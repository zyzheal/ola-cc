import { describe, expect, it } from 'bun:test'
import { ConstraintValidator } from './constraintValidator'

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
})
