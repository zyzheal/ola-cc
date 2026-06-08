import { describe, test, expect, beforeEach } from 'bun:test'
import { SurfaceStateMachine } from '../surfaceStateMachine.js'

describe('SurfaceStateMachine', () => {
  let sm: SurfaceStateMachine

  beforeEach(() => {
    sm = new SurfaceStateMachine()
  })

  test('should start with nonexistent state', () => {
    expect(sm.getState('surface-1')).toBe('nonexistent')
  })

  test('should transition nonexistent -> created on surfaceUpdate', () => {
    const result = sm.validate('surface-1', 'surfaceUpdate')
    expect(result.valid).toBe(true)

    sm.transition('surface-1', 'surfaceUpdate')
    expect(sm.getState('surface-1')).toBe('created')
  })

  test('should transition created -> rendering on beginRendering', () => {
    sm.create('surface-1')
    expect(sm.getState('surface-1')).toBe('created')

    const result = sm.validate('surface-1', 'beginRendering')
    expect(result.valid).toBe(true)

    sm.transition('surface-1', 'beginRendering')
    expect(sm.getState('surface-1')).toBe('rendering')
  })

  test('should transition rendering -> interactive on dataModelUpdate', () => {
    sm.create('surface-1')
    sm.transition('surface-1', 'beginRendering')

    const result = sm.validate('surface-1', 'dataModelUpdate')
    expect(result.valid).toBe(true)

    sm.transition('surface-1', 'dataModelUpdate')
    expect(sm.getState('surface-1')).toBe('interactive')
  })

  test('should allow surfaceUpdate in created state', () => {
    sm.create('surface-1')

    const result = sm.validate('surface-1', 'surfaceUpdate')
    expect(result.valid).toBe(true)
  })

  test('should reject dataModelUpdate in created state', () => {
    sm.create('surface-1')

    const result = sm.validate('surface-1', 'dataModelUpdate')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid transition')
  })

  test('should reject beginRendering in nonexistent state', () => {
    const result = sm.validate('surface-1', 'beginRendering')
    expect(result.valid).toBe(false)
  })

  test('should allow deleteSurface from any active state', () => {
    // From created
    sm.create('surface-1')
    expect(sm.validate('surface-1', 'deleteSurface').valid).toBe(true)

    // From rendering
    sm.create('surface-2')
    sm.transition('surface-2', 'beginRendering')
    expect(sm.validate('surface-2', 'deleteSurface').valid).toBe(true)

    // From interactive
    sm.create('surface-3')
    sm.transition('surface-3', 'beginRendering')
    sm.transition('surface-3', 'dataModelUpdate')
    expect(sm.validate('surface-3', 'deleteSurface').valid).toBe(true)
  })

  test('should transition deleted -> created on surfaceUpdate', () => {
    sm.create('surface-1')
    sm.transition('surface-1', 'deleteSurface')
    expect(sm.getState('surface-1')).toBe('deleted')

    const result = sm.validate('surface-1', 'surfaceUpdate')
    expect(result.valid).toBe(true)

    sm.transition('surface-1', 'surfaceUpdate')
    expect(sm.getState('surface-1')).toBe('created')
  })

  test('should track multiple surfaces independently', () => {
    sm.create('surface-1')
    sm.create('surface-2')
    sm.transition('surface-1', 'beginRendering')

    expect(sm.getState('surface-1')).toBe('rendering')
    expect(sm.getState('surface-2')).toBe('created')
  })

  test('should reset all states', () => {
    sm.create('surface-1')
    sm.create('surface-2')
    sm.reset()

    expect(sm.getState('surface-1')).toBe('nonexistent')
    expect(sm.getState('surface-2')).toBe('nonexistent')
  })

  test('should delete surface', () => {
    sm.create('surface-1')
    sm.delete('surface-1')

    expect(sm.getState('surface-1')).toBe('deleted')
  })
})
