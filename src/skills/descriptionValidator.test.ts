import { describe, test, expect } from 'bun:test'
import { validateDescription } from './descriptionValidator'

describe('validateDescription', () => {
  test('passes with Chinese exclusion statement', () => {
    const result = validateDescription(
      '评审设计文档。不做代码修改，不分析已有实现。当用户请求评审时使用。',
      undefined,
      'test-skill',
    )
    expect(result.hasExclusion).toBe(true)
    expect(result.hasScope).toBe(true)
    expect(result.suggestions).toHaveLength(0)
  })

  test('passes with English exclusion statement', () => {
    const result = validateDescription(
      'Review code. Not responsible for writing fixes. Does not cover documentation. Use when asked to review.',
      undefined,
      'test-skill',
    )
    expect(result.hasExclusion).toBe(true)
    expect(result.hasScope).toBe(true)
    expect(result.suggestions).toHaveLength(0)
  })

  test('passes with delegation statement', () => {
    const result = validateDescription(
      '评审文档。不做代码修改，用 code-design-analyzer 替代。适用于代码评审场景。',
      undefined,
      'test-skill',
    )
    expect(result.hasExclusion).toBe(true)
    expect(result.hasScope).toBe(true)
    expect(result.suggestions).toHaveLength(0)
  })

  test('passes with Trigger: in description (scope)', () => {
    const result = validateDescription(
      '评审文档，不做代码修改。Trigger: 评审, review, 深度评审',
      undefined,
      'test-skill',
    )
    expect(result.hasScope).toBe(true)
    expect(result.hasExclusion).toBe(true)
    expect(result.suggestions).toHaveLength(0)
  })

  test('passes with whenToUse field (scope)', () => {
    const result = validateDescription(
      '评审设计文档。不做代码修改。',
      'When the user asks to review a design document',
      'test-skill',
    )
    expect(result.hasExclusion).toBe(true)
    expect(result.hasScope).toBe(true)
    expect(result.suggestions).toHaveLength(0)
  })

  test('flags missing exclusion', () => {
    const result = validateDescription(
      '评审设计文档，检查操作链路完整性和页面交互。',
      undefined,
      'test-skill',
    )
    expect(result.hasExclusion).toBe(false)
    expect(result.suggestions.some(s => s.includes('exclusion'))).toBe(true)
  })

  test('flags missing scope', () => {
    const result = validateDescription(
      '评审文档。不做代码修改，转交 task-decomposer。',
      undefined,
      'test-skill',
    )
    expect(result.hasExclusion).toBe(true)
    expect(result.hasScope).toBe(false)
    expect(result.suggestions.some(s => s.includes('scope'))).toBe(true)
  })

  test('flags both missing', () => {
    const result = validateDescription(
      'This skill reviews things.',
      undefined,
      'test-skill',
    )
    expect(result.hasExclusion).toBe(false)
    expect(result.hasScope).toBe(false)
    expect(result.suggestions).toHaveLength(2)
  })

  test('matches 适用于 pattern', () => {
    const result = validateDescription(
      '适用于大型系统的全栈评审。不直接修改代码。',
      undefined,
      'test-skill',
    )
    expect(result.hasScope).toBe(true)
    expect(result.hasExclusion).toBe(true)
  })

  test('matches 触发词 pattern', () => {
    const result = validateDescription(
      '评审文档。触发词：评审, review',
      undefined,
      'test-skill',
    )
    expect(result.hasScope).toBe(true)
  })

  test('matches "use XXX instead" pattern', () => {
    const result = validateDescription(
      'Reviews code quality. Does not write fixes, use code-reviewer instead.',
      undefined,
      'test-skill',
    )
    expect(result.hasExclusion).toBe(true)
  })

  test('empty description flagged for both', () => {
    const result = validateDescription('', undefined, 'test-skill')
    expect(result.hasExclusion).toBe(false)
    expect(result.hasScope).toBe(false)
  })
})
