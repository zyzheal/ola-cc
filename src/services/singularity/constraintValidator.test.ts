import { describe, expect, it } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ConstraintValidator } from './constraintValidator'
import type { DiverseStrategy } from './EvolutionEngine'

describe('ConstraintValidator', () => {
  const validator = new ConstraintValidator()

  const validSkill = `---
name: test-skill
description: A test skill for validation
---
# Test Skill
Some content here.`

  const largeSkill = 'x'.repeat(20000) // 20KB

  it('should pass when size is within limit', async () => {
    const results = await validator.validateAll(validSkill, 'skill')
    const sizeResult = results.find((r) => r.constraintName === 'size_limit')
    expect(sizeResult?.passed).toBe(true)
  })

  it('should fail when size exceeds 15KB', async () => {
    const results = await validator.validateAll(largeSkill, 'skill')
    const sizeResult = results.find((r) => r.constraintName === 'size_limit')
    expect(sizeResult?.passed).toBe(false)
  })

  it('should pass when growth is within 20%', async () => {
    const baseline = 'x'.repeat(5000)
    const evolved = 'x'.repeat(6000) // +20%
    const results = await validator.validateAll(evolved, 'skill', baseline)
    const growthResult = results.find(
      (r) => r.constraintName === 'growth_limit',
    )
    expect(growthResult?.passed).toBe(true)
  })

  it('should fail when growth exceeds 20%', async () => {
    const baseline = 'x'.repeat(5000)
    const evolved = 'x'.repeat(7000) // +40%
    const results = await validator.validateAll(evolved, 'skill', baseline)
    const growthResult = results.find(
      (r) => r.constraintName === 'growth_limit',
    )
    expect(growthResult?.passed).toBe(false)
  })

  it('should pass for valid skill structure', async () => {
    const results = await validator.validateAll(validSkill, 'skill')
    const structResult = results.find(
      (r) => r.constraintName === 'skill_structure',
    )
    expect(structResult?.passed).toBe(true)
  })

  it('should fail for missing frontmatter', async () => {
    const noFront = '# Just a heading\nSome content without frontmatter'
    const results = await validator.validateAll(noFront, 'skill')
    const structResult = results.find(
      (r) => r.constraintName === 'skill_structure',
    )
    expect(structResult?.passed).toBe(false)
  })

  it('should pass non-empty check', async () => {
    const results = await validator.validateAll(validSkill, 'skill')
    const nonEmpty = results.find((r) => r.constraintName === 'non_empty')
    expect(nonEmpty?.passed).toBe(true)
  })

  it('should fail empty check', async () => {
    const results = await validator.validateAll('', 'skill')
    const nonEmpty = results.find((r) => r.constraintName === 'non_empty')
    expect(nonEmpty?.passed).toBe(false)
  })

  // --- checkSurgicalPatch tests ---

  const mockStrategy: DiverseStrategy = {
    type: 'conservative',
    name: 'test-strategy',
    description: 'A test strategy',
    approach: 'minimal changes',
    preferredLayer: 1,
    targetDimensions: ['correctness'],
    estimatedLines: 10,
  }

  it('should pass surgical patch check when estimated lines are within limit', async () => {
    // 200 total lines * 0.15 = 30 max, estimatedLines=10 < 30 => pass
    const results = await validator.validateAll(validSkill, 'skill', undefined, undefined, {
      strategy: mockStrategy,
      totalLines: 200,
    })
    const surgicalResult = results.find(
      (r) => r.constraintName === 'surgical_patch',
    )
    expect(surgicalResult).toBeDefined()
    expect(surgicalResult?.passed).toBe(true)
  })

  it('should fail surgical patch check when estimated lines exceed limit', async () => {
    // 100 total lines * 0.15 = 15 max, estimatedLines=25 > 15 => fail
    const heavyStrategy: DiverseStrategy = {
      ...mockStrategy,
      estimatedLines: 25,
    }
    const results = await validator.validateAll(validSkill, 'skill', undefined, undefined, {
      strategy: heavyStrategy,
      totalLines: 100,
    })
    const surgicalResult = results.find(
      (r) => r.constraintName === 'surgical_patch',
    )
    expect(surgicalResult).toBeDefined()
    expect(surgicalResult?.passed).toBe(false)
  })

  it('should cap surgical patch limit at maxAbsoluteLines', async () => {
    // 1000 total lines * 0.15 = 150, but capped at maxAbsoluteLines=30
    // estimatedLines=35 > 30 => fail
    const largeStrategy: DiverseStrategy = {
      ...mockStrategy,
      estimatedLines: 35,
    }
    const results = await validator.validateAll(validSkill, 'skill', undefined, undefined, {
      strategy: largeStrategy,
      totalLines: 1000,
    })
    const surgicalResult = results.find(
      (r) => r.constraintName === 'surgical_patch',
    )
    expect(surgicalResult).toBeDefined()
    expect(surgicalResult?.passed).toBe(false)
  })

  it('should not include surgical patch result when strategy is not provided', async () => {
    const results = await validator.validateAll(validSkill, 'skill')
    const surgicalResult = results.find(
      (r) => r.constraintName === 'surgical_patch',
    )
    expect(surgicalResult).toBeUndefined()
  })

  // --- runTestSuite tests ---

  it('should not include test_suite result when projectRoot is not provided', async () => {
    const results = await validator.validateAll(validSkill, 'skill')
    const testResult = results.find(
      (r) => r.constraintName === 'test_suite',
    )
    expect(testResult).toBeUndefined()
  })

  it('should pass test suite when bun test succeeds', async () => {
    // Create a temp directory with a trivially passing test
    const tmpDir = join(import.meta.dir, '__tmp_test_pass')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(
      join(tmpDir, 'trivial.test.ts'),
      `import { describe, it, expect } from 'bun:test';
describe('trivial', () => { it('passes', () => { expect(1).toBe(1); }); });`,
    )
    try {
      const results = await validator.validateAll(validSkill, 'skill', undefined, undefined, {
        projectRoot: tmpDir,
      })
      const testResult = results.find((r) => r.constraintName === 'test_suite')
      expect(testResult).toBeDefined()
      expect(testResult?.passed).toBe(true)
      expect(testResult?.message).toBe('All tests passed')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, { timeout: 30_000 })

  it('should fail test suite when bun test fails', async () => {
    // Create a temp directory with a failing test
    const tmpDir = join(import.meta.dir, '__tmp_test_fail')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(
      join(tmpDir, 'fail.test.ts'),
      `import { describe, it, expect } from 'bun:test';
describe('fail', () => { it('fails', () => { expect(1).toBe(2); }); });`,
    )
    try {
      const results = await validator.validateAll(validSkill, 'skill', undefined, undefined, {
        projectRoot: tmpDir,
      })
      const testResult = results.find((r) => r.constraintName === 'test_suite')
      expect(testResult).toBeDefined()
      expect(testResult?.passed).toBe(false)
      expect(testResult?.message).toBe('Test suite failed')
      expect(testResult?.details).toBeTruthy()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, { timeout: 30_000 })
})
