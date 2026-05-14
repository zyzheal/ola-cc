// 测试 provider 配置连接
import { createOpenAICompatibleShimClient } from './src/services/api/openaiShim.js'

const profiles = [
  {
    name: 'minimax',
    apiUrl: 'https://zhenze-huhehaote.cmecloud.cn/api/coding',
    apiKey: 'CnvaQlvCHE8_kMXnBT0U2Jl7ww1oe2I4HoUcNXbuPhY',
    model: 'minimax-m2.5',
  },
  {
    name: 'qwen',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '', // 缺少 key
    model: 'qwen-plus',
  },
  {
    name: 'glm51',
    apiUrl: 'https://zhenze-huhehaote.cmecloud.cn/api/coding',
    apiKey: 'CnvaQlvCHE8_kMXnBT0U2Jl7ww1oe2I4HoUcNXbuPhY',
    model: 'glm-5.1',
  },
]

async function testProfile(p: typeof profiles[0]) {
  if (!p.apiKey) {
    console.log(`[${p.name}] ❌ 缺少 API Key`)
    return
  }

  console.log(`[${p.name}] 测试连接...`)
  try {
    const client = createOpenAICompatibleShimClient({
      apiKey: p.apiKey,
      maxRetries: 0,
      model: p.model,
    })

    const result = await (client.beta.messages.create({
      model: p.model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 10,
      stream: false,
    }) as any)

    if (result && result.id) {
      console.log(`[${p.name}] ✅ 连接成功! Response ID: ${result.id}`)
    } else {
      console.log(`[${p.name}] ❌ 意外响应格式`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[${p.name}] ❌ 连接失败: ${msg.slice(0, 200)}`)
  }
}

async function main() {
  console.log('开始测试 provider 配置...\n')
  for (const p of profiles) {
    await testProfile(p)
    console.log('')
  }
}

main()