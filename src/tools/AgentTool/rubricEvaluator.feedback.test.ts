import { describe, it, expect } from 'bun:test'
import { evaluateQualityWithFeedback, type GateResultWithFeedback, type FitnessFeedback } from './rubricEvaluator'

describe('evaluateQualityWithFeedback', () => {
  it('should return feedback for failed dimensions when enableLLMFeedback=true', async () => {
    const mockLLM = async () => JSON.stringify({
      feedback: '技能缺少错误处理指导，导致 LLM 在 API 失败时无响应',
      suggestedApproach: '添加 try/catch 示例和错误码映射',
    })
    const result = await evaluateQualityWithFeedback(
      {
        tokenBudget: 1000,
        tokensUsed: 500,
        baselineTokens: 400,
        testResults: [
          { passed: true, name: 'test1', regression: false },
          { passed: false, name: 'test2', regression: false },
        ],
      },
      '---\nname: test\n---\n# Skill content',
      undefined,
      { enableLLMFeedback: true, model: 'mock' },
      mockLLM,
    )
    expect(result.passed).toBeDefined()
    expect(result.feedback).toBeDefined()
    expect(Array.isArray(result.feedback)).toBe(true)
  })

  it('should not call LLM when enableLLMFeedback is false', async () => {
    let llmCalled = false
    const mockLLM = async () => { llmCalled = true; return '{}' }
    await evaluateQualityWithFeedback(
      { tokenBudget: 1000, tokensUsed: 500, baselineTokens: 400 },
      'skill text',
      undefined,
      { enableLLMFeedback: false },
      mockLLM,
    )
    expect(llmCalled).toBe(false)
  })
})
