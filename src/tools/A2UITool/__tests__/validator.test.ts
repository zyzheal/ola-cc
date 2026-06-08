import { describe, test, expect, beforeEach } from 'bun:test'
import { A2UIValidator } from '../validator.js'
import { Catalog } from '../catalog.js'
import { SurfaceStateMachine } from '../surfaceStateMachine.js'
import type { A2UIMessage } from '../types.js'

describe('A2UIValidator', () => {
  let validator: A2UIValidator
  let catalog: Catalog
  let stateMachine: SurfaceStateMachine

  beforeEach(() => {
    catalog = new Catalog()
    stateMachine = new SurfaceStateMachine()
    validator = new A2UIValidator(catalog, stateMachine)
  })

  test('should validate valid surfaceUpdate message', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'btn-1',
              component: {
                type: 'Button',
                props: { label: 'Click Me' },
              },
            },
          ],
        },
      },
    ]

    const result = validator.validate(messages, 'test-surface')
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('should reject component not in catalog', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'custom-1',
              component: {
                type: 'NonExistentWidget',
                props: {},
              },
            },
          ],
        },
      },
    ]

    const result = validator.validate(messages, 'test-surface')
    expect(result.valid).toBe(false)
    expect(result.errors[0].rule).toBe('component_in_catalog')
  })

  test('should reject duplicate component IDs', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'same-id',
              component: { type: 'Button', props: { label: 'A' } },
            },
            {
              id: 'same-id',
              component: { type: 'Button', props: { label: 'B' } },
            },
          ],
        },
      },
    ]

    const result = validator.validate(messages, 'test-surface')
    expect(result.valid).toBe(false)
    expect(result.errors[0].rule).toBe('unique_component_id')
  })

  test('should reject action not in whitelist', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'btn-1',
              component: {
                type: 'Button',
                props: { label: 'Click' },
                actions: ['onHover'], // Not allowed for Button
              },
            },
          ],
        },
      },
    ]

    const result = validator.validate(messages, 'test-surface')
    expect(result.valid).toBe(false)
    expect(result.errors[0].rule).toBe('action_in_whitelist')
  })

  test('should allow valid actions', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'btn-1',
              component: {
                type: 'Button',
                props: { label: 'Click' },
                actions: ['onClick'], // Allowed for Button
              },
            },
          ],
        },
      },
    ]

    const result = validator.validate(messages, 'test-surface')
    expect(result.valid).toBe(true)
  })

  test('should validate state machine transitions', () => {
    const msg1: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            { id: 'btn-1', component: { type: 'Button', props: { label: 'A' } } },
          ],
        },
      },
    ]

    const result1 = validator.validate(msg1, 'test-surface')
    expect(result1.valid).toBe(true)

    const msg2: A2UIMessage[] = [
      { beginRendering: { root: 'btn-1' } },
    ]

    const result2 = validator.validate(msg2, 'test-surface')
    expect(result2.valid).toBe(true)
  })

  test('should reject invalid state transition', () => {
    const messages: A2UIMessage[] = [
      {
        dataModelUpdate: {
          contents: { key: 'value' },
        },
      },
    ]

    const result = validator.validate(messages, 'test-surface')
    expect(result.valid).toBe(false)
    expect(result.errors[0].rule).toBe('state_machine')
  })

  test('should validate multiple messages in sequence', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            { id: 'root', component: { type: 'Column', props: {}, children: ['btn-1'] } },
            { id: 'btn-1', component: { type: 'Button', props: { label: 'Click' } } },
          ],
        },
      },
      { beginRendering: { root: 'root' } },
      {
        dataModelUpdate: {
          contents: { clicks: 0 },
        },
      },
    ]

    const result = validator.validate(messages, 'test-surface')
    expect(result.valid).toBe(true)
  })

  test('should collect multiple errors', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            { id: 'dup', component: { type: 'Button', props: { label: 'A' } } },
            { id: 'dup', component: { type: 'NonExistent', props: {} } },
          ],
        },
      },
    ]

    const result = validator.validate(messages, 'test-surface')
    expect(result.valid).toBe(false)
    // Errors: duplicate ID + component not in catalog (NonExistent)
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
    const rules = result.errors.map((e) => e.rule)
    expect(rules).toContain('unique_component_id')
    expect(rules).toContain('component_in_catalog')
  })
})
