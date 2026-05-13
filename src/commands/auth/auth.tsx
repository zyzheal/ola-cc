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
    const settings = getSettingsForSource('userSettings')
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
      const prevKey = process.env.ANTHROPIC_API_KEY
      const prevBase = process.env.ANTHROPIC_BASE_URL

      process.env.ANTHROPIC_API_KEY = profile.apiKey
      if (profile.apiUrl) process.env.ANTHROPIC_BASE_URL = profile.apiUrl

      try {
        const client = await getAnthropicClient({ maxRetries: 0 })
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
  action: 'add' | 'list' | 'use' | 'delete' | 'test' | 'help' | 'add-model' | 'remove-model' | 'edit' | ''
  name?: string
  apiUrl?: string
  apiKey?: string
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
  if (action === 'use' || action === 'delete' || action === 'test' || action === 'edit') return { action, name: parts[1] ? sanitizeInput(parts[1], MAX_PROFILE_NAME_LENGTH) : undefined }
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
            setMessage('用法: /auth add <name> --api-url <url> --api-key <key> --model <model>')
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
          const prov = parsed.provider || 'openai'
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
          saveProfiles(data)
          setDone(true)
          break
        }

        case 'use': {
          if (!parsed.name) { setMessage('用法: /auth use <name>'); setDone(true); break }
          const profile = data.profiles.find(p => p.name === parsed.name)
          if (!profile) { setMessage(`未找到 "${parsed.name}"`); setDone(true); break }
          if (profile.models.length === 0) { setMessage(`"${parsed.name}" 没有可用模型`); setDone(true); break }

          if (profile.provider === 'openai') {
            process.env.CLAUDE_CODE_USE_OPENAI = 'true'
            process.env.OPENAI_API_KEY = profile.apiKey
            process.env.OPENAI_API_BASE = profile.apiUrl
            process.env.OPENAI_BASE_URL = profile.apiUrl
            delete process.env.ANTHROPIC_API_KEY
          } else {
            process.env.ANTHROPIC_API_KEY = profile.apiKey
            if (profile.apiUrl) process.env.ANTHROPIC_BASE_URL = profile.apiUrl

            delete process.env.CLAUDE_CODE_USE_OPENAI
            delete process.env.OPENAI_API_KEY
            delete process.env.OPENAI_API_BASE
            delete process.env.OPENAI_BASE_URL
          }

          const modelToUse = profile.defaultModel || profile.models[0]
          setAppState(prev => ({ ...prev, mainLoopModel: modelToUse, mainLoopModelForSession: null }))
          data.activeProfile = profile.name
          data.activeModel = modelToUse
          saveProfiles(data)
          logEvent('tengu_auth_switch_provider', { provider: profile.provider, model: modelToUse })
          setMessage(`已切换到 "${chalk.bold(profile.name)}" (${profile.provider})\n模型: ${chalk.bold(modelToUse)}\nURL: ${profile.apiUrl}`)
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
          }
          saveProfiles(data)
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
          }
          saveProfiles(data)
          logEvent('tengu_auth_remove_model', { provider: profile.name, model: parsed.model })
          setMessage(`已从 "${parsed.name}" 移除 "${parsed.model}"`)
          setDone(true)
          break
        }

        case 'help': {
          setMessage(
            `${chalk.bold('Provider 配置管理')}\n\n` +
            `${chalk.cyan('/auth add')} <name> --api-url <url> --api-key <key> --model <model>\n  添加 provider 配置\n\n` +
            `${chalk.cyan('/auth list')}                     列出所有已保存的配置\n\n` +
            `${chalk.cyan('/auth use')} <name>               切换到指定 provider\n\n` +
            `${chalk.cyan('/auth delete')} <name>            删除 provider\n\n` +
            `${chalk.cyan('/auth test')} <name>              测试连接\n\n` +
            `${chalk.cyan('/auth add-model')} <name> <model> 给 provider 添加新 model\n` +
            `${chalk.cyan('/auth remove-model')} <name> <model> 从 provider 移除 model\n\n` +
            `${chalk.dim('示例:')}\n` +
            `  /auth add dashscope --api-url https://dashscope.aliyuncs.com/compatible-mode/v1 --api-key sk-xxx --model qwen3.6-plus\n` +
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

  return <AuthActionView parsed={parsed} onDone={onDone} />
}
