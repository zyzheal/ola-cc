#!/usr/bin/env bun

/**
 * Provider 检测测试脚本 - 验证 isThirdPartyProvider() 函数
 */

import { isThirdPartyProvider } from './src/utils/model/providers.js'

interface TestCase {
  name: string
  env: Record<string, string>
  expectedThirdParty: boolean
}

const testCases: TestCase[] = [
  {
    name: 'minimax (openai)',
    env: {
      CLAUDE_CODE_USE_OPENAI: 'true',
      ANTHROPIC_BASE_URL: 'https://zhenze-huhehaote.cmecloud.cn/api/coding/v1',
    },
    expectedThirdParty: true,
  },
  {
    name: 'glm51 (openai)',
    env: {
      CLAUDE_CODE_USE_OPENAI: 'true',
      ANTHROPIC_BASE_URL: 'https://zhenze-huhehaote.cmecloud.cn/api/coding/v1',
    },
    expectedThirdParty: true,
  },
  {
    name: 'qwen (anthropic/dashscope)',
    env: {
      ANTHROPIC_BASE_URL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      ANTHROPIC_MODEL: 'qwen3.6-plus',
    },
    expectedThirdParty: true,
  },
  {
    name: 'deepseek (anthropic)',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_MODEL: 'deepseek-v4-flash',
    },
    expectedThirdParty: true,
  },
  {
    name: 'anthropic official',
    env: {},
    expectedThirdParty: false,
  },
]

console.log('='.repeat(80))
console.log('isThirdPartyProvider() 测试')
console.log('='.repeat(80))

let passed = 0
let failed = 0

for (const tc of testCases) {
  // 清除环境变量
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_MODEL

  // 设置测试环境变量
  for (const [key, value] of Object.entries(tc.env)) {
    process.env[key] = value
  }

  const result = isThirdPartyProvider()
  const isCorrect = result === tc.expectedThirdParty

  if (isCorrect) {
    passed++
    console.log(`✓ ${tc.name}: ${result} (expected: ${tc.expectedThirdParty})`)
  } else {
    failed++
    console.log(`✗ ${tc.name}: ${result} (expected: ${tc.expectedThirdParty})`)
  }
}

console.log('\n' + '='.repeat(80))
console.log(`结果: ${passed} 通过, ${failed} 失败`)
console.log('='.repeat(80))

if (failed > 0) {
  process.exit(1)
}
