import { getSettingsForSource } from './src/utils/settings/settings.js'

function main() {
  const settings = getSettingsForSource('userSettings') || {}
  const providers = (settings as any).__olaProviders__

  if (!providers || providers.profiles.length === 0) {
    console.log('没有已保存的 provider 配置。使用 /auth add 添加。')
    return
  }

  console.log('已保存的 Provider 配置:\n')
  providers.profiles.forEach((p: any, i: number) => {
    const active = p.name === providers.activeProfile ? ' (当前)' : ''
    const verified = p.verified ? '✓' : '?'
    console.log(`${i + 1}. ${p.name}${active}  ${verified}  ${p.provider}`)
    console.log(`   URL: ${p.apiUrl}`)
    console.log(`   Models: ${p.models.join(', ')}`)
    if (p.name === providers.activeProfile && providers.activeModel) {
      console.log(`   当前模型: ${providers.activeModel}`)
    }
    console.log('')
  })
}

main()