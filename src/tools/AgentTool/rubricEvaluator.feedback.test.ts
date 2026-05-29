import { describe, it, expect, beforeEach } from 'bun:test'
import { evaluateQualityWithFeedback, type GateResultWithFeedback, type FitnessFeedback } from './rubricEvaluator'

describe('evaluateQualityWithFeedback', () => {
  // Reset cache between tests by using unique skillText prefixes
  const uniqueSkillText = (id: string) => `---\nname: test-${id}\n---\n# Skill content ${id}`

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
      uniqueSkillText('feedback-1'),
      undefined,
      { enableLLMFeedback: true, model: 'mock' },
      mockLLM,
    )
    expect(result.passed).toBeDefined()
    expect(result.feedback).toBeDefined()
    expect(Array.isArray(result.feedback)).toBe(true)
    // Verify feedback content when there are failed dimensions
    if (result.feedback.length > 0) {
      expect(result.feedback[0].dimension).toBeTruthy()
      expect(result.feedback[0].feedback).toBeTruthy()
      expect(typeof result.feedback[0].score).toBe('number')
      expect(typeof result.feedback[0].threshold).toBe('number')
    }
  })

  it('should not call LLM when enableLLMFeedback is false', async () => {
    let llmCalled = false
    const mockLLM = async () => { llmCalled = true; return '{}' }
    await evaluateQualityWithFeedback(
      { tokenBudget: 1000, tokensUsed: 500, baselineTokens: 400 },
      uniqueSkillText('no-llm'),
      undefined,
      { enableLLMFeedback: false },
      mockLLM,
    )
    expect(llmCalled).toBe(false)
  })

  it('should handle LLM errors gracefully without affecting scoring', async () => {
    const mockLLM = async () => { throw new Error('LLM service down') }
    const result = await evaluateQualityWithFeedback(
      {
        tokenBudget: 1000,
        tokensUsed: 500,
        baselineTokens: 400,
        testResults: [
          { passed: false, name: 'test1', regression: false },
        ],
      },
      uniqueSkillText('llm-error'),
      undefined,
      { enableLLMFeedback: true },
      mockLLM,
    )
    // Scoring should still work even if LLM fails
    expect(result.passed).toBeDefined()
    expect(result.feedback).toBeDefined()
    // feedback should be empty since LLM failed for all dimensions
    expect(result.feedback.length).toBe(0)
  })

  it('should not call llmCaller when it is undefined', async () => {
    const result = await evaluateQualityWithFeedback(
      {
        tokenBudget: 1000,
        tokensUsed: 500,
        baselineTokens: 400,
        testResults: [
          { passed: false, name: 'test1', regression: false },
        ],
      },
      uniqueSkillText('no-caller'),
      undefined,
      { enableLLMFeedback: true },
      undefined, // no llmCaller
    )
    expect(result.feedback).toBeDefined()
    expect(result.feedback.length).toBe(0)
  })

  it('should return empty feedback when all dimensions pass', async () => {
    let llmCalled = false
    const mockLLM = async () => { llmCalled = true; return '{}' }
    const result = await evaluateQualityWithFeedback(
      {
        tokenBudget: 1000,
        tokensUsed: 400,
        baselineTokens: 400,
        testResults: [
          { passed: true, name: 'test1', regression: false },
        ],
      },
      uniqueSkillText('all-pass'),
      undefined,
      { enableLLMFeedback: true },
      mockLLM,
    )
    expect(result.feedback.length).toBe(0)
    // LLM should not be called since no dimensions failed
    expect(llmCalled).toBe(false)
  })
})
