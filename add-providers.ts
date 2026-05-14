// 直接写入 provider 配置到 settings
import { getSettingsForSource, updateSettingsForSource } from './src/utils/settings/settings.js'

const profiles = [
  {
    name: 'minimax',
    provider: 'openai' as const,
    apiUrl: 'https://zhenze-huhehaote.cmecloud.cn/api/coding',
    apiKey: 'CnvaQlvCHE8_kMXnBT0U2Jl7ww1oe2I4HoUcNXbuPhY',
    models: ['minimax-m2.5'],
    defaultModel: 'minimax-m2.5',
    verified: true,
    addedAt: new Date().toISOString(),
  },
  {
    name: 'glm51',
    provider: 'openai' as const,
    apiUrl: 'https://zhenze-huhehaote.cmecloud.cn/api/coding',
    apiKey: 'CnvaQlvCHE8_kMXnBT0U2Jl7ww1oe2I4HoUcNXbuPhY',
    models: ['glm-5.1'],
    defaultModel: 'glm-5.1',
    verified: true,
    addedAt: new Date().toISOString(),
  },
]

function main() {
  const settings = getSettingsForSource('userSettings') || {}
  const existing = (settings as any).__olaProviders__ || { profiles: [] }

  // 合并配置
  for (const profile of profiles) {
    const idx = existing.profiles.findIndex((p: any) => p.name === profile.name)
    if (idx >= 0) {
      existing.profiles[idx] = profile
    } else {
      existing.profiles.push(profile)
    }
  }

  // 设置 glm51 为默认
  existing.activeProfile = 'glm51'
  existing.activeModel = 'glm-5.1'

  const result = updateSettingsForSource('userSettings', {
    ...settings,
    __olaProviders__: existing,
  })

  if (result.error) {
    console.error('❌ 保存失败:', result.error.message)
    process.exit(1)
  }

  console.log('✅ 已添加 provider 配置:')
  console.log(JSON.stringify(existing, null, 2))
}

main()