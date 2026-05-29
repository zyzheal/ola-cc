import { describe, it, expect } from 'bun:test'
import { EvolutionEngine, EvolutionPhase } from './EvolutionEngine'

describe('EvolutionEngine integration', () => {
  it('should have P0_PREPARE executor for dataset loading', () => {
    const engine = new EvolutionEngine('test-skill')
    const state = engine.getState()
    expect(state.phase).toBe(EvolutionPhase.P0_PREPARE)
  })

  it('should support injecting feedback for P2', () => {
    const engine = new EvolutionEngine('test-skill')
    const state = engine.getState()
    state.context.gateResult = {
      passed: false,
      dimensions: {} as any,
      feedback: [{ dimension: 'holdout_floor', score: 0.4, threshold: 0.6, feedback: 'test feedback' }],
    }
    engine.injectFeedbackForP2()
    const updatedState = engine.getState()
    expect(updatedState.context.failureAnalysis).toContain('test feedback')
  })

  it('should validate constraints and report failures', async () => {
    const engine = new EvolutionEngine('test-skill')
    const largeSkill = 'x'.repeat(20000) // 20KB exceeds 15KB limit
    const result = await engine.validateConstraints(largeSkill)
    expect(result.passed).toBe(false)
    expect(result.failures.length).toBeGreaterThan(0)
    expect(result.failures[0]).toContain('size_limit')
  })

  it('should validate constraints and pass for valid skill', async () => {
    const engine = new EvolutionEngine('test-skill')
    const validSkill = '---\nname: test\ndescription: valid\n---\n# Test\nContent here.'
    const result = await engine.validateConstraints(validSkill)
    expect(result.passed).toBe(true)
    expect(result.failures.length).toBe(0)
  })

  it('should report loaded=false when dataset file does not exist', async () => {
    const engine = new EvolutionEngine('test-skill')
    const result = await engine.loadOrGenerateDataset('skill text', '/tmp/nonexistent-dataset.jsonl')
    expect(result.loaded).toBe(false)
    expect(result.path).toBe('/tmp/nonexistent-dataset.jsonl')
  })
})
