import { describe, test, expect, beforeEach } from 'bun:test'
import { ActionProcessor } from '../actionProcessor.js'
import type { A2UIAction } from '../types.js'

describe('ActionProcessor', () => {
  let processor: ActionProcessor

  beforeEach(() => {
    processor = new ActionProcessor()
  })

  function createAction(overrides: Partial<A2UIAction> = {}): A2UIAction {
    return {
      surfaceId: 'test-surface',
      actionId: 'action-1',
      componentId: 'btn-1',
      actionType: 'onClick',
      payload: {},
      timestamp: Date.now(),
      ...overrides,
    }
  }

  test('should start with no pending actions', () => {
    expect(processor.hasPendingActions('test-surface')).toBe(false)
    expect(processor.getPendingCount('test-surface')).toBe(0)
  })

  test('should store received actions', () => {
    const action = createAction()
    processor.onActionReceived(action)

    expect(processor.hasPendingActions('test-surface')).toBe(true)
    expect(processor.getPendingCount('test-surface')).toBe(1)
  })

  test('should consume actions for surface', () => {
    const action1 = createAction({ actionId: 'a1' })
    const action2 = createAction({ actionId: 'a2' })

    processor.onActionReceived(action1)
    processor.onActionReceived(action2)

    const consumed = processor.consumeActions('test-surface')
    expect(consumed).toHaveLength(2)
    expect(consumed[0].actionType).toBe('onClick')
  })

  test('should clear consumed actions', () => {
    processor.onActionReceived(createAction())
    processor.consumeActions('test-surface')

    expect(processor.hasPendingActions('test-surface')).toBe(false)
    expect(processor.getPendingCount('test-surface')).toBe(0)
  })

  test('should track multiple surfaces independently', () => {
    processor.onActionReceived(createAction({ surfaceId: 's1' }))
    processor.onActionReceived(createAction({ surfaceId: 's2' }))

    expect(processor.getPendingCount('s1')).toBe(1)
    expect(processor.getPendingCount('s2')).toBe(1)

    processor.consumeActions('s1')
    expect(processor.hasPendingActions('s1')).toBe(false)
    expect(processor.hasPendingActions('s2')).toBe(true)
  })

  test('should generate summary for onClick', () => {
    processor.onActionReceived(createAction({
      componentId: 'submit-btn',
      actionType: 'onClick',
    }))

    const consumed = processor.consumeActions('test-surface')
    expect(consumed[0].summary).toBe('User clicked submit-btn')
  })

  test('should generate summary for onChange with value', () => {
    processor.onActionReceived(createAction({
      componentId: 'name-input',
      actionType: 'onChange',
      payload: { value: 'John' },
    }))

    const consumed = processor.consumeActions('test-surface')
    expect(consumed[0].summary).toContain('changed name-input')
    expect(consumed[0].summary).toContain('John')
  })

  test('should generate summary for onSubmit', () => {
    processor.onActionReceived(createAction({
      componentId: 'form-1',
      actionType: 'onSubmit',
    }))

    const consumed = processor.consumeActions('test-surface')
    expect(consumed[0].summary).toBe('User submitted form on form-1')
  })

  test('should generate summary for unknown action type', () => {
    processor.onActionReceived(createAction({
      componentId: 'widget-1',
      actionType: 'onCustom',
    }))

    const consumed = processor.consumeActions('test-surface')
    expect(consumed[0].summary).toBe('User triggered onCustom on widget-1')
  })

  test('should track total processed count', () => {
    processor.onActionReceived(createAction())
    processor.onActionReceived(createAction())

    expect(processor.totalProcessed).toBe(2)
  })

  test('should clear all pending actions', () => {
    processor.onActionReceived(createAction({ surfaceId: 's1' }))
    processor.onActionReceived(createAction({ surfaceId: 's2' }))

    processor.clear()

    expect(processor.hasPendingActions('s1')).toBe(false)
    expect(processor.hasPendingActions('s2')).toBe(false)
  })

  test('should return empty array for surface with no actions', () => {
    const consumed = processor.consumeActions('nonexistent')
    expect(consumed).toEqual([])
  })

  test('should evict oldest actions when limit exceeded', () => {
    const smallProcessor = new ActionProcessor(2)

    smallProcessor.onActionReceived(createAction({ componentId: 'btn-a1' }))
    smallProcessor.onActionReceived(createAction({ componentId: 'btn-a2' }))
    smallProcessor.onActionReceived(createAction({ componentId: 'btn-a3' }))

    expect(smallProcessor.getPendingCount('test-surface')).toBe(2)

    const consumed = smallProcessor.consumeActions('test-surface')
    expect(consumed[0].componentId).toBe('btn-a2') // btn-a1 was evicted
    expect(consumed[1].componentId).toBe('btn-a3')
  })
})
