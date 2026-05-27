import chalk from 'chalk'
import * as React from 'react'
import { useEffect, useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { logEvent } from '../../services/analytics/index.js'
import { createOpenAICompatibleShimClient } from '../../services/api/openaiShim.js'
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { useSetAppState } from '../../state/AppState.js'
import { getAnthropicClient } from '../../services/api/client.js'
import { setProcessScopedActiveProfile, getProcessScopedOlaProviders, syncProcessScopedOlaProviders, clearProcessScopedActiveProfile } from '../../utils/managedEnv.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { normalizeApiKeyForConfig } from '../../utils/authPortable.js'

// -- Types

interface ProviderProfile {
  name: string
  provider: 'openai' | 'anthropic'
  apiUrl: string
  apiKey: string
  models: string[]
  defaultModel: string
  verified: boolean
  addedAt: string
}

interface ProfilesData {
  profiles: ProviderProfile[]
  activeProfile?: string
  activeModel?: string
}

// -- Migration

const MAX_PROFILE_NAME_LENGTH = 50
const MAX_API_KEY_LENGTH = 500
const MAX_MODEL_NAME_LENGTH = 100
const PROFILE_NAME_REGEX = /^[a-zA-Z0-9_\-]+$/

function isValidProfileName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_PROFILE_NAME_LENGTH && PROFILE_NAME_REGEX.test(name)
}

function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') return false
    if (hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) return false
    if (hostname === '[::1]' || hostname.startsWith('fc') || hostname.startsWith('fd')) return false
    return true
  } catch {
    return false
  }
}

function sanitizeInput(input: string, maxLength: number): string {
  return input.trim().slice(0, maxLength)
}

function migrateProfile(p: unknown): ProviderProfile | null {
  if (!p || typeof p !== 'object') return null
  const obj = p as Record<string, unknown>
  if (obj.models && Array.isArray(obj.models)) {
    if (typeof obj.name !== 'string' || typeof obj.provider !== 'string') return null
    return obj as unknown as ProviderProfile
  }
  const model = typeof obj.model === 'string' ? obj.model : typeof obj.defaultModel === 'string' ? obj.defaultModel : ''
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    provider: (typeof obj.provider === 'string' ? obj.provider : 'openai') as 'openai' | 'anthropic',
    apiUrl: typeof obj.apiUrl === 'string' ? obj.apiUrl : '',
    apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : '',
    models: model ? [model] : [],
    defaultModel: model,
    verified: !!obj.verified,
    addedAt: typeof obj.addedAt === 'string' ? obj.addedAt : new Date().toISOString(),
  }
}

// -- Storage

function loadProfiles(): ProfilesData {
  try {
    // Check flagSettings (--settings) first, then userSettings
    const sources = ['flagSettings', 'userSettings'] as const
    for (const source of sources) {
      const settings = getSettingsForSource(source)
      if (!settings) continue
      const raw = (settings as any).__olaProviders__
      if (raw && typeof raw === 'object') {
        const profiles = (Array.isArray(raw.profiles) ? raw.profiles : [])
          .map(migrateProfile)
          .filter((p): p is ProviderProfile => p && typeof p.name === 'string' && p.name.length > 0)
        return {
          profiles,
          activeProfile: raw.activeProfile,
          activeModel: raw.activeModel,
        }
      }
    }
  } catch {
    // ignore
  }
  return { profiles: [] }
}

function saveProfiles(data: ProfilesData): { error: Error | null } {
  const result = updateSettingsForSource('userSettings', {
    __olaProviders__: {
      profiles: data.profiles,
      activeProfile: data.activeProfile,
      activeModel: data.activeModel,
    },
  })
  return result
}

// -- API Key Approval

/**
 * Add an anthropic provider's API key to the approved list in ~/.ola-cc.json
 * so getAnthropicApiKeyWithSource() (src/utils/auth.ts:299-309) will recognize it.
 * Without this, keys added via /auth add are not in the approved list
 * (which /login normally populates), causing "Not logged in" errors.
 * This mirrors saveApiKey() behavior for /login-flow consistency.
 */
function approveProviderApiKey(profile: ProviderProfile): void {
  if (profile.provider !== 'anthropic' || !profile.apiKey) return
  const normalizedKey = normalizeApiKeyForConfig(profile.apiKey)
  saveGlobalConfig(current => {
    const approved = current.customApiKeyResponses?.approved ?? []
    if (approved.includes(normalizedKey)) return current
    return {
      ...current,
      customApiKeyResponses: {
        ...current.customApiKeyResponses,
        approved: [...approved, normalizedKey],
      },
    }
  })
}

// -- API Verification

async function verifyProviderProfile(
  profile: ProviderProfile,
): Promise<{ success: boolean; error?: string }> {
  const modelToTest = profile.models[0] || profile.defaultModel || 'unknown'
  try {
    if (profile.provider === 'openai') {
      const prevOpenai = process.env.CLAUDE_CODE_USE_OPENAI
      const prevKey = process.env.OPENAI_API_KEY
      const prevBase = process.env.OPENAI_API_BASE
      const prevBaseUrl = process.env.OPENAI_BASE_URL

      process.env.CLAUDE_CODE_USE_OPENAI = 'true'
      process.env.OPENAI_API_KEY = profile.apiKey
      process.env.OPENAI_API_BASE = profile.apiUrl
      process.env.OPENAI_BASE_URL = profile.apiUrl

      try {
        const client = createOpenAICompatibleShimClient({
          apiKey: profile.apiKey,
          maxRetries: 0,
          model: modelToTest,
        })

        const result = await (client.beta.messages.create({
          model: modelToTest,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
          stream: false,
        }) as any)

        const response = await result
        if (response && response.id) {
          return { success: true }
        }
        return { success: false, error: 'Unexpected response format' }
      } finally {
        if (prevOpenai !== undefined) process.env.CLAUDE_CODE_USE_OPENAI = prevOpenai
        else delete process.env.CLAUDE_CODE_USE_OPENAI
        if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey
        else delete process.env.OPENAI_API_KEY
        if (prevBase !== undefined) process.env.OPENAI_API_BASE = prevBase
        else delete process.env.OPENAI_API_BASE
        if (prevBaseUrl !== undefined) process.env.OPENAI_BASE_URL = prevBaseUrl
        else delete process.env.OPENAI_BASE_URL
      }
    } else {
      const prevOpenai = process.env.CLAUDE_CODE_USE_OPENAI
      const prevOlaOpenai = process.env.OLA_CC_USE_OPENAI
      const prevKey = process.env.ANTHROPIC_API_KEY
      const prevBase = process.env.ANTHROPIC_BASE_URL

      // Clear OpenAI shim flags to ensure getAnthropicClient returns real Anthropic client
      delete process.env.CLAUDE_CODE_USE_OPENAI
      delete process.env.OLA_CC_USE_OPENAI
      process.env.ANTHROPIC_API_KEY = profile.apiKey
      if (profile.apiUrl) process.env.ANTHROPIC_BASE_URL = profile.apiUrl

      try {
        const client = await getAnthropicClient({ apiKey: profile.apiKey, maxRetries: 0 })
        const result = await (client.beta.messages.create({
          model: modelToTest || 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
          stream: false,
        }) as any)

        const response = await result
        if (response && response.id) {
          return { success: true }
        }
        return { success: false, error: 'Unexpected response format' }
      } finally {
        if (prevOpenai !== undefined) process.env.CLAUDE_CODE_USE_OPENAI = prevOpenai
        else delete process.env.CLAUDE_CODE_USE_OPENAI
        if (prevOlaOpenai !== undefined) process.env.OLA_CC_USE_OPENAI = prevOlaOpenai
        else delete process.env.OLA_CC_USE_OPENAI
        if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey
        else delete process.env.ANTHROPIC_API_KEY
        if (prevBase !== undefined) process.env.ANTHROPIC_BASE_URL = prevBase
        else delete process.env.ANTHROPIC_BASE_URL
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const truncated = message.length > 300 ? message.slice(0, 300) + '...' : message
    return { success: false, error: truncated }
  }
}

// -- Parse arguments for CLI mode

interface ParsedArgs {
  action: 'add' | 'list' | 'use' | 'delete' | 'test' | 'help' | 'add-model' | 'remove-model' | 'edit' | 'update-key' | ''
  name?: string
  apiUrl?: string
  apiKey?: string
  newApiKey?: string
  model?: string
  provider?: 'openai' | 'anthropic'
}

function parseArgs(args: string): ParsedArgs {
  const trimmed = args.trim()
  if (!trimmed) return { action: '' }

  const parts = trimmed.split(/\s+/)
  const action = parts[0] as ParsedArgs['action']

  if (action === 'list' || action === 'info') return { action }
  if (action === 'help' || action === '--help' || action === '-h') return { action: 'help' }
  if (action === 'delete' || action === 'test' || action === 'edit') return { action, name: parts[1] ? sanitizeInput(parts[1], MAX_PROFILE_NAME_LENGTH) : undefined }
  if (action === 'update-key') {
    const result: ParsedArgs = { action, name: parts[1] ? sanitizeInput(parts[1], MAX_PROFILE_NAME_LENGTH) : undefined }
    for (let argIdx = 2; argIdx < parts.length; argIdx++) {
      if (parts[argIdx] === '--new-key' && parts[argIdx + 1]) result.newApiKey = sanitizeInput(parts[++argIdx], MAX_API_KEY_LENGTH)
    }
    return result
  }
  if (action === 'use') {
    const result: ParsedArgs = { action, name: parts[1] ? sanitizeInput(parts[1], MAX_PROFILE_NAME_LENGTH) : undefined }
    for (let i = 2; i < parts.length; i++) {
      if (parts[i] === '--model' && parts[i + 1]) result.model = sanitizeInput(parts[++i], MAX_MODEL_NAME_LENGTH)
    }
    return result
  }
  if (action === 'add-model' || action === 'remove-model') return { action, name: parts[1] ? sanitizeInput(parts[1], MAX_PROFILE_NAME_LENGTH) : undefined, model: parts[2] ? sanitizeInput(parts[2], MAX_MODEL_NAME_LENGTH) : undefined }

  if (action === 'add') {
    const result: ParsedArgs = { action, name: parts[1] ? sanitizeInput(parts[1], MAX_PROFILE_NAME_LENGTH) : undefined }
    if (parts.length <= 2) return { action: '', name: parts[1] ? sanitizeInput(parts[1], MAX_PROFILE_NAME_LENGTH) : undefined }
    for (let argIdx = 2; argIdx < parts.length; argIdx++) {
      if (parts[argIdx] === '--api-url' && parts[argIdx + 1]) result.apiUrl = sanitizeInput(parts[++argIdx], 500)
      else if (parts[argIdx] === '--api-key' && parts[argIdx + 1]) result.apiKey = sanitizeInput(parts[++argIdx], MAX_API_KEY_LENGTH)
      else if (parts[argIdx] === '--model' && parts[argIdx + 1]) result.model = sanitizeInput(parts[++argIdx], MAX_MODEL_NAME_LENGTH)
      else if (parts[argIdx] === '--provider' && parts[argIdx + 1]) {
        const providerValue = parts[++argIdx].toLowerCase()
        if (providerValue === 'openai' || providerValue === 'anthropic') {
          result.provider = providerValue
        }
      }
    }
    return result
  }

  return { action: 'help' }
}

// -- Non-interactive action handler (for CLI args mode)

function AuthActionView({
  parsed,
  onDone,
}: {
  parsed: ParsedArgs
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  const [message, setMessage] = useState('')
  const [done, setDone] = useState(false)
  const setAppState = useSetAppState()

  useEffect(() => {
    async function run() {
      const data = loadProfiles()

      switch (parsed.action) {
        case 'list': {
          if (data.profiles.length === 0) {
            setMessage('没有已保存的 provider 配置。使用 /auth add 添加。')
          } else {
            const lines = data.profiles.flatMap((p, profIdx) => {
              const active = p.name === data.activeProfile ? chalk.green(' (当前)') : ''
              const verified = p.verified ? chalk.green('✓') : chalk.yellow('?')
              const num = chalk.dim(`${profIdx + 1}.`)
              const modelsStr = p.models.length > 0
                ? `\n   Models: ${p.models.map((m, j) => m === p.defaultModel ? chalk.bold(m) + chalk.dim(' (默认)') : m).join(', ')}`
                : chalk.yellow('\n   ⚠ 没有可用模型')
              const currentModelStr = p.name === data.activeProfile && data.activeModel
                ? `\n   当前模型: ${chalk.bold(data.activeModel)}`
                : ''
              return [
                `${num} ${chalk.bold(p.name)}${active}  ${verified}  ${p.provider}`,
                `   URL: ${p.apiUrl}${modelsStr}${currentModelStr}`,
              ]
            })
            setMessage(`已保存的 Provider 配置:\n${lines.join('\n')}`)
          }
          setDone(true)
          break
        }

        case 'add': {
          if (!parsed.name || !parsed.apiUrl || !parsed.apiKey || !parsed.model) {
            setMessage('用法: /auth add <name> --api-url <url> --api-key <key> --model <model> [--provider openai|anthropic]')
            setDone(true)
            break
          }
          if (!isValidProfileName(parsed.name)) {
            setMessage(`无效的 profile 名称。只能包含字母、数字、连字符和下划线（最多 ${MAX_PROFILE_NAME_LENGTH} 个字符）`)
            setDone(true)
            break
          }
          if (!isValidUrl(parsed.apiUrl)) {
            setMessage('无效的 API URL。只支持 http(s) 协议')
            setDone(true)
            break
          }
          // Auto-detect provider from URL if not explicitly specified
          const isAnthropicUrl = parsed.apiUrl.includes('/anthropic')
          const prov = parsed.provider || (isAnthropicUrl ? 'anthropic' : 'openai')
          const existing = data.profiles.findIndex(p => p.name === parsed.name)
          const profile: ProviderProfile = {
            name: parsed.name,
            provider: prov,
            apiUrl: parsed.apiUrl,
            apiKey: parsed.apiKey,
            models: [parsed.model],
            defaultModel: parsed.model,
            verified: false,
            addedAt: new Date().toISOString(),
          }
          setMessage(`正在验证连接到 ${parsed.apiUrl}...`)
          const verifyResult = await verifyProviderProfile(profile)
          if (verifyResult.success) {
            profile.verified = true
            if (existing >= 0) data.profiles[existing] = profile
            else data.profiles.push(profile)
            setMessage(`已添加 "${profile.name}" — 连接验证成功 ${chalk.green('✓')}`)
          } else {
            profile.verified = false
            if (existing >= 0) data.profiles[existing] = profile
            else data.profiles.push(profile)
            setMessage(`已保存 "${profile.name}" 但验证失败:\n${chalk.red(verifyResult.error || 'Unknown error')}`)
          }

          approveProviderApiKey(profile)
          saveProfiles(data)

          // Sync new profile to process-scoped memory so it can be used immediately
          syncProcessScopedOlaProviders(data)

          setDone(true)
          break
        }

        case 'use': {
          if (!parsed.name) { setMessage('用法: /auth use <name> [--model <model>]'); setDone(true); break }
          const profile = data.profiles.find(p => p.name === parsed.name)
          if (!profile) { setMessage(`未找到 "${parsed.name}"`); setDone(true); break }
          if (profile.models.length === 0) { setMessage(`"${parsed.name}" 没有可用模型`); setDone(true); break }

          // Resolve model: --model flag > defaultModel
          const targetModel = parsed.model && profile.models.includes(parsed.model)
            ? parsed.model
            : profile.defaultModel

          if (parsed.model && !profile.models.includes(parsed.model)) {
            setMessage(`模型 "${parsed.model}" 不在 "${parsed.name}" 中。\n可用模型: ${profile.models.join(', ')}\n已切换到默认模型: ${chalk.bold(profile.defaultModel)}`)
          }

          approveProviderApiKey(profile)

          // Use process-scoped memory switching — env vars are process-scoped,
          // so multiple processes can independently switch providers.
          setProcessScopedActiveProfile(profile.name, targetModel)

          // Update mainLoopModel via AppState for immediate effect in current session
          setAppState(prev => ({ ...prev, mainLoopModel: targetModel, mainLoopModelForSession: null }))

          // Persist the active profile to disk so new processes pick it up.
          data.activeProfile = profile.name
          data.activeModel = targetModel
          saveProfiles(data)

          logEvent('tengu_auth_switch_provider', { provider: profile.provider, model: targetModel })
          setMessage(`已切换到 "${chalk.bold(profile.name)}" (${profile.provider})\n模型: ${chalk.bold(targetModel)}\nURL: ${profile.apiUrl}`)
          setDone(true)
          break
        }

        case 'delete': {
          if (!parsed.name) { setMessage('用法: /auth delete <name>'); setDone(true); break }
          const idx = data.profiles.findIndex(p => p.name === parsed.name)
          if (idx < 0) { setMessage(`未找到 "${parsed.name}"`); setDone(true); break }
          data.profiles.splice(idx, 1)
          if (data.activeProfile === parsed.name) {
            data.activeProfile = undefined
            data.activeModel = undefined
            // Clear process-scoped memory and env vars for deleted active profile
            clearProcessScopedActiveProfile()
          }
          saveProfiles(data)

          // Sync profile removal to process-scoped memory
          syncProcessScopedOlaProviders(data)

          setMessage(`已删除 "${parsed.name}"`)
          setDone(true)
          break
        }

        case 'test': {
          if (!parsed.name) { setMessage('用法: /auth test <name>'); setDone(true); break }
          const profile = data.profiles.find(p => p.name === parsed.name)
          if (!profile) { setMessage(`未找到 "${parsed.name}"`); setDone(true); break }
          if (profile.models.length === 0) { setMessage(`"${parsed.name}" 没有可用模型`); setDone(true); break }
          setMessage(`正在测试连接到 ${profile.apiUrl}...`)
          const result = await verifyProviderProfile(profile)
          if (result.success) { profile.verified = true; setMessage(`"${profile.name}" — 连接验证成功 ${chalk.green('✓')}`) }
          else { profile.verified = false; setMessage(`"${profile.name}" — 验证失败:\n${chalk.red(result.error || 'Unknown error')}`) }
          saveProfiles(data)
          setDone(true)
          break
        }

        case 'add-model': {
          if (!parsed.name || !parsed.model) { setMessage('用法: /auth add-model <provider> <model>'); setDone(true); break }
          const profile = data.profiles.find(p => p.name === parsed.name)
          if (!profile) { setMessage(`未找到 "${parsed.name}"`); setDone(true); break }
          if (profile.models.includes(parsed.model)) { setMessage(`"${parsed.model}" 已存在于 "${parsed.name}"`); setDone(true); break }
          profile.models.push(parsed.model)
          if (!profile.defaultModel) profile.defaultModel = parsed.model
          setMessage(`正在验证连接到 ${parsed.model}...`)
          const result = await verifyProviderProfile(profile)
          if (result.success) { profile.verified = true; setMessage(`已添加 "${parsed.model}" 到 "${parsed.name}" — 连接验证成功 ${chalk.green('✓')}`) }
          else { profile.verified = false; setMessage(`已添加 "${parsed.model}" 但验证失败:\n${chalk.red(result.error || 'Unknown error')}`) }
          saveProfiles(data)

          // Always sync process-scoped memory when active profile's models change
          syncProcessScopedOlaProviders(data)
          if (data.activeProfile !== parsed.name && data.activeProfile) {
            // Re-apply the current active profile's env vars to ensure consistency
            setProcessScopedActiveProfile(data.activeProfile, data.activeModel)
          }

          logEvent('tengu_auth_add_model', { provider: profile.name, model: parsed.model })
          setDone(true)
          break
        }

        case 'remove-model': {
          if (!parsed.name || !parsed.model) { setMessage('用法: /auth remove-model <provider> <model>'); setDone(true); break }
          const profile = data.profiles.find(p => p.name === parsed.name)
          if (!profile) { setMessage(`未找到 "${parsed.name}"`); setDone(true); break }
          if (profile.models.length <= 1) { setMessage(`不能移除最后一个模型 "${parsed.model}"`); setDone(true); break }
          const idx = profile.models.indexOf(parsed.model)
          if (idx < 0) { setMessage(`"${parsed.model}" 不在 "${parsed.name}" 中`); setDone(true); break }
          profile.models.splice(idx, 1)
          if (profile.defaultModel === parsed.model) {
            profile.defaultModel = profile.models[0]
          }
          if (data.activeProfile === parsed.name && data.activeModel === parsed.model) {
            data.activeModel = profile.defaultModel
            setAppState(prev => ({ ...prev, mainLoopModel: profile.defaultModel }))

            // Sync process memory for the active profile
            setProcessScopedActiveProfile(parsed.name, profile.defaultModel)
          }
          saveProfiles(data)

          // Always sync process-scoped memory when models change
          syncProcessScopedOlaProviders(data)

          logEvent('tengu_auth_remove_model', { provider: profile.name, model: parsed.model })
          setMessage(`已从 "${parsed.name}" 移除 "${parsed.model}"`)
          setDone(true)
          break
        }

        case 'update-key': {
          // CLI-only mode: name + newApiKey provided as args
          if (parsed.name && parsed.newApiKey) {
            const profile = data.profiles.find(p => p.name === parsed.name)
            if (!profile) {
              setMessage(`未找到 "${parsed.name}"`)
              setDone(true)
              break
            }
            setMessage('正在验证新的 API Key...')
            const verifyResult = await verifyProviderProfile({ ...profile, apiKey: parsed.newApiKey })
            if (verifyResult.success) {
              const profileIdx = data.profiles.findIndex(p => p.name === profile.name)
              if (profileIdx >= 0) {
                data.profiles[profileIdx].apiKey = parsed.newApiKey
                data.profiles[profileIdx].verified = true
              }
              saveProfiles(data)
              syncProcessScopedOlaProviders(data)
              approveProviderApiKey(data.profiles[profileIdx])
              setMessage(`已更新 "${chalk.bold(profile.name)}" 的 API Key\n连接验证成功 ✓\n已同步到环境变量`)
            } else {
              setMessage(`更新失败 "${profile.name}":\n${chalk.red(verifyResult.error || 'Unknown error')}`)
            }
            setDone(true)
            break
          }
          // Interactive mode: fall through to __interactive__
          setMessage('__interactive__')
          setDone(true)
          break
        }

        case 'help': {
          setMessage(
            `${chalk.bold('Provider 配置管理')}\n\n` +
            `${chalk.cyan('/auth add')} <name> --api-url <url> --api-key <key> --model <model> [--provider openai|anthropic]\n  添加 provider 配置 (--provider 可选，默认根据 URL 自动检测)\n\n` +
            `${chalk.cyan('/auth list')}                     列出所有已保存的配置\n\n` +
            `${chalk.cyan('/auth use')} <name>               切换到指定 provider\n\n` +
            `${chalk.cyan('/auth delete')} <name>            删除 provider\n\n` +
            `${chalk.cyan('/auth test')} <name>              测试连接\n\n` +
            `${chalk.cyan('/auth update-key')} <name>         交互式更新 provider API Key (支持命令行模式)\n` +
            `${chalk.cyan('                        ')}` + chalk.dim('CLI: /auth update-key <name> --new-key <key>\n') +
            `${chalk.cyan('/auth add-model')} <name> <model> 给 provider 添加新 model\n` +
            `${chalk.cyan('/auth remove-model')} <name> <model> 从 provider 移除 model\n\n` +
            `${chalk.dim('示例:')}\n` +
            `  /auth add dashscope --api-url https://dashscope.aliyuncs.com/compatible-mode/v1 --api-key sk-xxx --model qwen3.6-plus\n` +
            `  /auth add qwen --api-url https://coding.dashscope.aliyuncs.com/apps/anthropic --api-key sk-xxx --model qwen3.6-plus  # 自动检测为 Anthropic 协议\n` +
            `  /auth list\n` +
            `  /auth use dashscope\n` +
            `  /auth add-model dashscope qwen-max`,
          )
          setDone(true)
          break
        }

        default: {
          setMessage('__interactive__')
          setDone(true)
          break
        }
      }
    }
    void run()
  }, [parsed])

  useEffect(() => {
    if (done && message !== '__interactive__') {
      onDone(message)
    }
  }, [done, message, onDone])

  return null
}

// -- Update Key Interactive View

interface UpdateKeyState {
  step: 'select' | 'input-key' | 'verifying' | 'done' | 'error'
  selectedProfile?: ProviderProfile
  selectedIdx: number
  newApiKey: string
  error?: string
}

function UpdateKeyView({ onDone }: { onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void }) {
  const [state, setState] = useState<UpdateKeyState>({ step: 'select', selectedIdx: 0 })
  const profilesData = loadProfiles()

  // Filter out empty profiles list
  useEffect(() => {
    if (profilesData.profiles.length === 0) {
      onDone('没有已保存的 provider 配置。使用 /auth add 添加。', { display: 'system' })
    }
  }, [])

  function handleSelectProfile(idx: number, profile: ProviderProfile) {
    setState(prev => ({ ...prev, step: 'input-key', selectedProfile: profile, selectedIdx: idx }))
  }

  async function handleSubmitKey() {
    const currentNewKey = state.newApiKey.trim()
    const currentProfile = state.selectedProfile
    if (!currentProfile || !currentNewKey) {
      setState(prev => ({ ...prev, step: 'error', error: 'API Key 不能为空' }))
      return
    }
    setState(prev => ({ ...prev, step: 'verifying' }))

    const verifyResult = await verifyProviderProfile({ ...currentProfile, apiKey: currentNewKey })
    if (verifyResult.success) {
      const data = loadProfiles()
      const idx = data.profiles.findIndex(p => p.name === currentProfile.name)
      if (idx >= 0) {
        data.profiles[idx].apiKey = currentNewKey
        data.profiles[idx].verified = true
      }
      saveProfiles(data)
      syncProcessScopedOlaProviders(data)
      approveProviderApiKey(data.profiles[idx])
      setState(prev => ({ ...prev, step: 'done' }))
    } else {
      setState(prev => ({ ...prev, step: 'error', error: verifyResult.error || '验证失败' }))
    }
  }

  // Step: Select profile from list
  if (state.step === 'select') {
    return (
      <div
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'j') {
            e.preventDefault()
            setState(prev => ({ ...prev, selectedIdx: Math.min(prev.selectedIdx + 1, profilesData.profiles.length - 1) }))
          } else if (e.key === 'ArrowUp' || e.key === 'k') {
            e.preventDefault()
            setState(prev => ({ ...prev, selectedIdx: Math.max(prev.selectedIdx - 1, 0) }))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const sel = profilesData.profiles[state.selectedIdx]
            if (sel) handleSelectProfile(state.selectedIdx, sel)
          }
        }}
        style={{ padding: '8px 0', outline: 'none', cursor: 'default' }}
        tabIndex={0}
      >
        <div style={{ color: '#58a6ff', marginBottom: 12, fontSize: 14, fontWeight: 'bold' }}>
          {chalk.bold('更新 Provider API Key')}
        </div>
        <div style={{ color: '#8b949e', fontSize: 12, marginBottom: 8 }}>请选择要更新 API Key 的 profile：</div>
        {profilesData.profiles.map((p, i) => {
          const isActive = i === state.selectedIdx
          return (
            <div
              key={p.name}
              onClick={() => handleSelectProfile(i, p)}
              style={{
                background: isActive ? 'rgba(88,166,255,0.1)' : 'transparent',
                padding: '4px 8px',
                borderRadius: 4,
                margin: '2px 0',
                borderLeft: p.name === profilesData.activeProfile ? '2px solid #3fb950' : '2px solid transparent',
                paddingLeft: isActive ? 12 : 8,
                cursor: 'pointer',
              }}
            >
              <span style={{ color: isActive ? '#58a6ff' : '#c9d1d9' }}>
                {chalk.dim(`${i + 1}. `)}{chalk.bold(p.name)}
              </span>
              {p.name === profilesData.activeProfile && chalk.green(' (当前)')}
              {' '}
              <span style={{ color: p.verified ? '#3fb950' : '#d29922' }}>{p.verified ? '✓' : '?'}</span>
              {' '}
              <span style={{ color: '#8b949e', fontSize: 11 }}>{p.provider}</span>
            </div>
          )
        })}
        <div style={{ marginTop: 12, fontSize: 11, color: '#8b949e' }}>
          ↑↓ 选择 · Enter 确认
        </div>
      </div>
    )
  }

  // Step: Input new API Key
  if (state.step === 'input-key' && state.selectedProfile) {
    return (
      <div style={{ padding: '8px 0' }}>
        <div style={{ color: '#58a6ff', marginBottom: 8, fontSize: 14, fontWeight: 'bold' }}>
          {chalk.bold(`更新 ${chalk.cyan(state.selectedProfile.name)} 的 API Key`)}
        </div>
        <div style={{ marginBottom: 8 }}>
          <div style={{ color: '#8b949e', fontSize: 12 }}>URL:</div>
          <div style={{ fontSize: 12, fontFamily: 'monospace' }}>{state.selectedProfile.apiUrl}</div>
        </div>
        <div style={{ marginBottom: 8 }}>
          <div style={{ color: '#8b949e', fontSize: 12 }}>当前 Key:</div>
          <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#8b949e' }}>sk-{'•'.repeat(Math.min(state.selectedProfile.apiKey.length - 4, 16))}</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <div style={{ color: '#8b949e', fontSize: 12 }}>新 API Key:</div>
          <input
            type="password"
            value={state.newApiKey}
            onChange={(e) => setState({ ...state, newApiKey: e.target.value })}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') await handleSubmitKey()
            }}
            placeholder="sk-..."
            autoFocus
            style={{
              width: '100%',
              background: 'transparent',
              border: '1px solid #30363d',
              borderBottomColor: state.newApiKey ? '#58a6ff' : '#30363d',
              color: '#c9d1d9',
              fontFamily: 'monospace',
              fontSize: 12,
              padding: '4px 8px',
              outline: 'none',
              borderRadius: 4,
            }}
          />
        </div>
        {state.error && (
          <div style={{ fontSize: 12, color: '#f85149', marginBottom: 8 }}>
            {chalk.red('✗ ') + state.error}
          </div>
        )}
        <button
          onClick={handleSubmitKey}
          style={{
            background: '#238636',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '6px 16px',
            fontFamily: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          验证并保存 →
        </button>
        <button
          onClick={() => setState({ ...state, step: 'select', selectedProfile: undefined, newApiKey: '', error: undefined })}
          style={{
            marginLeft: 8,
            background: '#30363d',
            color: '#c9d1d9',
            border: 'none',
            borderRadius: 6,
            padding: '6px 16px',
            fontFamily: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          返回
        </button>
      </div>
    )
  }

  // Step: Verifying
  if (state.step === 'verifying') {
    return (
      <div style={{ padding: '8px 0', textAlign: 'center' }}>
        <div style={{ color: '#d29922', fontSize: 13 }}>
          ⠋ 正在连接到 {state.selectedProfile?.apiUrl}...
        </div>
        <div style={{ marginTop: 8, height: 2, background: '#21262d', borderRadius: 1, overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            background: 'linear-gradient(90deg, #58a6ff, #3fb950)',
            animation: 'auth-progress 1.5s ease-in-out infinite',
            width: '30%',
            borderRadius: 1,
          }} />
        </div>
      </div>
    )
  }

  // Step: Done
  if (state.step === 'done' && state.selectedProfile) {
    onDone(
      `${chalk.green('✓')} 已更新 "${chalk.bold(state.selectedProfile.name)}" 的 API Key\n${chalk.green('✓')} 连接验证成功\n${chalk.green('✓')} 已同步到环境变量`,
      { display: 'system' }
    )
    return null
  }

  // Step: Error
  if (state.step === 'error' && state.selectedProfile) {
    return (
      <div style={{ padding: '8px 0' }}>
        <div style={{ color: '#f85149', fontSize: 13, marginBottom: 8 }}>
          {chalk.red('✗') + ` 更新失败 "${chalk.bold(state.selectedProfile.name)}"`}
        </div>
        {state.error && (
          <div style={{ fontSize: 12, color: '#f85149', marginBottom: 12, whiteSpace: 'pre-wrap' }}>
            {state.error}
          </div>
        )}
        <button
          onClick={() => setState({ ...state, step: 'input-key', error: undefined })}
          style={{
            background: '#238636',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '6px 16px',
            fontFamily: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          重试
        </button>
        <button
          onClick={() => setState({ ...state, step: 'select', selectedProfile: undefined, newApiKey: '', error: undefined })}
          style={{
            marginLeft: 8,
            background: '#30363d',
            color: '#c9d1d9',
            border: 'none',
            borderRadius: 6,
            padding: '6px 16px',
            fontFamily: 'inherit',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          返回列表
        </button>
      </div>
    )
  }

  return null
}

// -- Main export

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseArgs(args || '')

  logEvent('tengu_auth_command', {
    action: parsed.action as string,
  })

  // No action or incomplete 'add' → show usage help
  if (parsed.action === '' || (parsed.action === 'add' && (!parsed.apiUrl || !parsed.apiKey || !parsed.model))) {
    return <AuthActionView
      parsed={{ action: 'help' }}
      onDone={onDone}
    />
  }

  // Edit: not supported in CLI-only mode
  if (parsed.action === 'edit') {
    onDone('编辑功能暂不可用。请使用 /auth add 重新添加配置。', { display: 'system' })
    return
  }

  // Update key: interactive mode (no --new-key arg)
  if (parsed.action === 'update-key' && !parsed.newApiKey) {
    return <UpdateKeyView onDone={onDone} />
  }

  return <AuthActionView parsed={parsed} onDone={onDone} />
}
