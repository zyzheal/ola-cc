import { describe, it, expect } from 'bun:test'
import { EvolutionEngine } from './EvolutionEngine'

describe('EvolutionEngine P2 feedback integration', () => {
  it('should inject feedback into failureAnalysis context', () => {
    const engine = new EvolutionEngine('test-skill')
    // Directly mutate internal context (getState shares context reference)
    const state = engine.getState()
    state.context.gateResult = {
      passed: false,
      dimensions: {} as any,
      feedback: [
        {
          dimension: 'holdout_floor',
          score: 0.4,
          threshold: 0.6,
          feedback: '技能缺少错误处理指导',
          suggestedApproach: '添加 try/catch 示例',
        },
      ],
      overallFeedback: '维度 holdout_floor: 技能缺少错误处理指导',
    }

    // Call the method under test
    engine.injectFeedbackForP2()

    // Verify failureAnalysis was injected
    const afterState = engine.getState()
    expect(afterState.context.failureAnalysis).toBeDefined()
    expect(typeof afterState.context.failureAnalysis).toBe('string')
    expect(afterState.context.failureAnalysis).toContain('holdout_floor')
    expect(afterState.context.failureAnalysis).toContain('错误处理')
  })

  it('should not set failureAnalysis when no feedback present', () => {
    const engine = new EvolutionEngine('test-skill')
    engine.getState().context.gateResult = {
      passed: true,
      dimensions: {} as any,
      feedback: [],
    }
    // injectFeedbackForP2 should not crash and should not set failureAnalysis
    engine.injectFeedbackForP2()
    const state = engine.getState()
    expect(state.context.failureAnalysis).toBeUndefined()
  })

  it('should not crash when gateResult is undefined', () => {
    const engine = new EvolutionEngine('test-skill')
    // No gateResult set — should handle gracefully
    engine.injectFeedbackForP2()
    const state = engine.getState()
    expect(state.context.failureAnalysis).toBeUndefined()
  })
})
