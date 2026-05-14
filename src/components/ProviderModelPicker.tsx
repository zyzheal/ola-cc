import chalk from 'chalk'
import * as React from 'react'
import { useState, useCallback } from 'react'
import { Box, Text } from '../ink.js'
import TextInput from './TextInput.js'
import type { CommandResultDisplay } from '../commands.js'
import { logEvent } from '../services/analytics/index.js'
import { useSetAppState } from '../state/AppState.js'
import { setProcessScopedActiveProfile, clearProcessScopedActiveProfile } from '../utils/managedEnv.js'

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

interface ProviderModelPickerProps {
  provider: ProviderProfile
  activeModel: string
  activeProfileName: string
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
  loadProfiles: () => { profiles: ProviderProfile[]; activeProfile?: string; activeModel?: string }
  saveProfiles: (data: { profiles: ProviderProfile[]; activeProfile?: string; activeModel?: string }) => void
}

export function ProviderModelPicker({
  provider,
  activeModel,
  activeProfileName,
  onDone,
  loadProfiles,
  saveProfiles,
}: ProviderModelPickerProps) {
  const [mode, setMode] = useState<'list' | 'input'>('list')
  const [inputValue, setInputValue] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const setAppState = useSetAppState()

  const handleSelect = useCallback((model: string) => {
    const data = loadProfiles()
    const profile = data.profiles.find(p => p.name === activeProfileName)
    if (!profile) return

    const isProviderModel = profile.models.includes(model)

    // Update AppState
    setAppState(prev => ({ ...prev, mainLoopModel: model }))

    if (isProviderModel) {
      // Update activeModel for provider
      data.activeModel = model
      saveProfiles(data)

      // Sync process-scoped memory for multi-process isolation
      setProcessScopedActiveProfile(activeProfileName, model)

      logEvent('tengu_auth_switch_model', {
        provider: profile.provider,
        fromModel: activeModel,
        toModel: model,
      })
      onDone(`已切换到 ${chalk.bold(model)} (${chalk.dim(provider.name)})`)
    } else {
      // Non-provider model: clear activeProfile, let it be handled by SetModelAndClose path
      data.activeProfile = undefined
      data.activeModel = undefined
      saveProfiles(data)

      // Clear process-scoped memory to stay consistent with disk
      clearProcessScopedActiveProfile()

      onDone(`已切换到 ${chalk.bold(model)}`)
    }
  }, [provider, activeModel, activeProfileName, onDone, loadProfiles, saveProfiles, setAppState])

  const handleListSelect = useCallback((model: string) => {
    handleSelect(model)
  }, [handleSelect])

  const handleInputSubmit = useCallback((value: string) => {
    const trimmed = value.trim()
    if (!trimmed) {
      setErrorMsg('模型名称不能为空')
      return
    }
    handleSelect(trimmed)
  }, [handleSelect])

  const handleCancel = useCallback(() => {
    onDone('Cancelled model selection')
  }, [onDone])

  if (mode === 'input') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{chalk.cyan(`切换模型 (${provider.name})`)}</Text>
        <Text dim>按 ESC 取消</Text>
        <Text>输入模型名称: </Text>
        <TextInput
          onSubmit={handleInputSubmit}
          onExit={handleCancel}
        />
        {errorMsg && <Text bold red>{errorMsg}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{chalk.cyan(`切换模型 - ${provider.name}`)}</Text>
      <Text dim>URL: {provider.apiUrl}</Text>
      <Text>选择一个模型 (按回车确认):</Text>
      {provider.models.map((model, i) => {
        const isDefault = model === provider.defaultModel
        const isActive = model === activeModel
        const marker = isActive ? chalk.green(' ● ') : '   '
        const defaultTag = isDefault ? chalk.dim(' (默认)') : ''
        const activeTag = isActive ? chalk.green(' (当前)') : ''
        return (
          <Text key={model}>
            {marker}{chalk.bold(model)}{defaultTag}{activeTag}
          </Text>
        )
      })}
      <Text dim>--- 或输入自定义模型名称 ---</Text>
      <Text>
        <Text dim>&gt; </Text>
        <TextInput
          onSubmit={(v) => {
            handleInputSubmit(v)
          }}
          onExit={handleCancel}
        />
      </Text>
      {errorMsg && <Text bold red>{errorMsg}</Text>}
    </Box>
  )
}
