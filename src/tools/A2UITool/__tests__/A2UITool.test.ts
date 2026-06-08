/**
 * A2UITool Tests
 *
 * Unit tests for: Validator, Catalog, SurfaceStateMachine, CircuitBreaker
 * Integration test: A2UITool.call() full flow
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Catalog } from '../catalog.js'
import { SurfaceStateMachine } from '../surfaceStateMachine.js'
import { CircuitBreaker } from '../circuitBreaker.js'
import { A2UIValidator } from '../validator.js'
import { TempFileManager } from '../tempFileManager.js'
import type { A2UIMessage, CatalogConfig } from '../types.js'

// ─── Catalog Tests ───

describe('Catalog', () => {
  let catalog: Catalog

  beforeEach(() => {
    catalog = new Catalog()
  })

  it('should have default catalog', () => {
    const config = catalog.get('default')
    expect(config.id).toBe('default')
    expect(config.components.length).toBeGreaterThan(0)
  })

  it('should return default catalog for unknown id', () => {
    const config = catalog.get('unknown')
    expect(config.id).toBe('default')
  })

  it('should check if component exists', () => {
    expect(catalog.hasComponent('Button')).toBe(true)
    expect(catalog.hasComponent('Card')).toBe(true)
    expect(catalog.hasComponent('Unknown')).toBe(false)
  })

  it('should get component definition', () => {
    const def = catalog.getComponentDef('Button')
    expect(def).toBeDefined()
    expect(def?.type).toBe('Button')
    expect(def?.actions).toContain('onClick')
  })

  it('should list component types', () => {
    const types = catalog.componentTypes
    expect(types).toContain('Button')
    expect(types).toContain('Card')
    expect(types).toContain('Text')
    expect(types).toContain('TextField')
    expect(types).toContain('Select')
    expect(types).toContain('Column')
    expect(types).toContain('Row')
  })

  it('should register custom catalog', () => {
    const custom: CatalogConfig = {
      id: 'custom',
      components: [
        {
          type: 'CustomButton',
          props: { label: { type: 'string', required: true } },
          actions: ['onClick'],
        },
      ],
    }
    catalog.register(custom)
    // hasComponent checks default catalog only
    expect(catalog.hasComponent('CustomButton')).toBe(false)
    // But get() returns custom catalog
    const customConfig = catalog.get('custom')
    expect(customConfig.components.some(c => c.type === 'CustomButton')).toBe(true)
  })
})

// ─── SurfaceStateMachine Tests ───

describe('SurfaceStateMachine', () => {
  let stateMachine: SurfaceStateMachine

  beforeEach(() => {
    stateMachine = new SurfaceStateMachine()
  })

  it('should start in nonexistent state', () => {
    expect(stateMachine.getState('test')).toBe('nonexistent')
  })

  it('should transition from nonexistent to created on surfaceUpdate', () => {
    stateMachine.transition('test', 'surfaceUpdate')
    expect(stateMachine.getState('test')).toBe('created')
  })

  it('should transition from created to rendering on beginRendering', () => {
    stateMachine.transition('test', 'surfaceUpdate')
    stateMachine.transition('test', 'beginRendering')
    expect(stateMachine.getState('test')).toBe('rendering')
  })

  it('should transition from rendering to interactive on dataModelUpdate', () => {
    stateMachine.transition('test', 'surfaceUpdate')
    stateMachine.transition('test', 'beginRendering')
    stateMachine.transition('test', 'dataModelUpdate')
    expect(stateMachine.getState('test')).toBe('interactive')
  })

  it('should transition to deleted from any active state', () => {
    stateMachine.transition('test', 'surfaceUpdate')
    stateMachine.transition('test', 'deleteSurface')
    expect(stateMachine.getState('test')).toBe('deleted')
  })

  it('should reject invalid transitions', () => {
    const result = stateMachine.validate('test', 'beginRendering')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid transition')
  })

  it('should allow surfaceUpdate from deleted state (recreation)', () => {
    stateMachine.transition('test', 'surfaceUpdate')
    stateMachine.transition('test', 'deleteSurface')
    const result = stateMachine.validate('test', 'surfaceUpdate')
    expect(result.valid).toBe(true)
  })

  it('should validate valid transitions', () => {
    stateMachine.transition('test', 'surfaceUpdate')
    const result = stateMachine.validate('test', 'beginRendering')
    expect(result.valid).toBe(true)
  })

  it('should track multiple surfaces independently', () => {
    stateMachine.transition('surface1', 'surfaceUpdate')
    stateMachine.transition('surface2', 'surfaceUpdate')
    stateMachine.transition('surface1', 'beginRendering')
    expect(stateMachine.getState('surface1')).toBe('rendering')
    expect(stateMachine.getState('surface2')).toBe('created')
  })
})

// ─── CircuitBreaker Tests ───

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker

  beforeEach(() => {
    circuitBreaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 100, // Short timeout for testing
      halfOpenMaxAttempts: 1,
    })
  })

  it('should start in closed state', () => {
    expect(circuitBreaker.isOpen()).toBe(false)
    expect(circuitBreaker.getState()).toBe('closed')
  })

  it('should open after N consecutive failures', () => {
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()
    expect(circuitBreaker.isOpen()).toBe(false)

    circuitBreaker.recordFailure()
    expect(circuitBreaker.isOpen()).toBe(true)
    expect(circuitBreaker.getState()).toBe('open')
  })

  it('should reset failure count on success', () => {
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()
    circuitBreaker.recordSuccess()
    circuitBreaker.recordFailure()
    expect(circuitBreaker.isOpen()).toBe(false)
  })

  it('should transition to half-open after timeout', async () => {
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()
    expect(circuitBreaker.isOpen()).toBe(true)

    // Wait for timeout
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(circuitBreaker.isOpen()).toBe(false)
    expect(circuitBreaker.getState()).toBe('half-open')
  })

  it('should close on success in half-open state', async () => {
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()

    await new Promise((resolve) => setTimeout(resolve, 150))
    // isOpen() transitions to half-open
    expect(circuitBreaker.isOpen()).toBe(false)
    expect(circuitBreaker.getState()).toBe('half-open')
    // Now record success to close
    circuitBreaker.recordSuccess()
    expect(circuitBreaker.getState()).toBe('closed')
  })

  it('should re-open on failure in half-open state', async () => {
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()

    await new Promise((resolve) => setTimeout(resolve, 150))
    circuitBreaker.recordFailure()
    expect(circuitBreaker.getState()).toBe('open')
  })

  it('should reset to closed state', () => {
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()
    circuitBreaker.recordFailure()
    circuitBreaker.reset()
    expect(circuitBreaker.getState()).toBe('closed')
    expect(circuitBreaker.isOpen()).toBe(false)
  })
})

// ─── Validator Tests ───

describe('A2UIValidator', () => {
  let validator: A2UIValidator
  let catalog: Catalog
  let stateMachine: SurfaceStateMachine

  beforeEach(() => {
    catalog = new Catalog()
    stateMachine = new SurfaceStateMachine()
    validator = new A2UIValidator(catalog, stateMachine)
  })

  it('should validate valid surfaceUpdate', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'btn1',
              component: {
                type: 'Button',
                props: { label: 'Click me' },
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

  it('should reject component not in catalog', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'unknown1',
              component: {
                type: 'UnknownComponent',
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

  it('should reject duplicate component IDs', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'btn1',
              component: {
                type: 'Button',
                props: { label: 'Button 1' },
              },
            },
            {
              id: 'btn1', // Duplicate!
              component: {
                type: 'Button',
                props: { label: 'Button 2' },
              },
            },
          ],
        },
      },
    ]

    const result = validator.validate(messages, 'test-surface')
    expect(result.valid).toBe(false)
    expect(result.errors[0].rule).toBe('unique_component_id')
  })

  it('should reject action not in whitelist', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'btn1',
              component: {
                type: 'Button',
                props: { label: 'Click' },
                actions: ['onHover'], // Not allowed!
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

  it('should reject invalid state transition', () => {
    // First, create a surface
    stateMachine.transition('test-surface', 'surfaceUpdate')

    // Try to beginRendering on already-created surface (should work)
    const messages1: A2UIMessage[] = [
      { beginRendering: { root: 'btn1' } },
    ]
    const result1 = validator.validate(messages1, 'test-surface')
    expect(result1.valid).toBe(true)

    // Now try to surfaceUpdate on rendering surface (should work)
    const messages2: A2UIMessage[] = [
      {
        surfaceUpdate: {
          surfaceId: 'test-surface',
          components: [
            {
              id: 'btn2',
              component: {
                type: 'Button',
                props: { label: 'New' },
              },
            },
          ],
        },
      },
    ]
    const result2 = validator.validate(messages2, 'test-surface')
    expect(result2.valid).toBe(true)
  })

  it('should validate multiple messages in sequence', () => {
    // First validate surfaceUpdate
    const messages1: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'card1',
              component: {
                type: 'Card',
                props: { title: 'My Card', child: 'text1' },
              },
            },
            {
              id: 'text1',
              component: {
                type: 'Text',
                props: { text: 'Hello' },
              },
            },
          ],
        },
      },
    ]
    const result1 = validator.validate(messages1, 'test-surface')
    expect(result1.valid).toBe(true)

    // Then validate beginRendering (state is now 'created')
    const messages2: A2UIMessage[] = [
      { beginRendering: { root: 'card1' } },
    ]
    const result2 = validator.validate(messages2, 'test-surface')
    expect(result2.valid).toBe(true)
  })
})

// ─── TempFileManager Tests ───

describe('TempFileManager', () => {
  let tempFileManager: TempFileManager

  beforeEach(() => {
    tempFileManager = new TempFileManager()
  })

  afterEach(async () => {
    await tempFileManager.cleanupAll()
  })

  it('should generate valid path', () => {
    const path = tempFileManager.generatePath('test-surface')
    expect(path).toContain('a2ui_test-surface.html')
  })

  it('should reject invalid surfaceId', () => {
    expect(() => tempFileManager.generatePath('../hack')).toThrow()
    expect(() => tempFileManager.generatePath('')).toThrow()
  })

  it('should write and cleanup file', async () => {
    const html = '<html><body>Test</body></html>'
    const filePath = await tempFileManager.write('test-surface', html)

    const fs = require('fs')
    expect(fs.existsSync(filePath)).toBe(true)

    await tempFileManager.cleanup('test-surface')
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('should track active surfaces', async () => {
    await tempFileManager.write('surface1', '<html>1</html>')
    await tempFileManager.write('surface2', '<html>2</html>')

    // cleanupAll should only delete tracked surfaces
    await tempFileManager.cleanupAll()
  })
})

// ─── Integration: HTMLGenerator Tests ───

describe('HTMLGenerator', () => {
  it('should generate valid HTML', async () => {
    const { HTMLGenerator } = await import('../htmlGenerator.js')
    const generator = new HTMLGenerator()

    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            {
              id: 'btn1',
              component: {
                type: 'Button',
                props: { label: 'Click me' },
              },
            },
          ],
        },
      },
    ]

    const html = generator.generate({
      messages,
      surfaceId: 'test-surface',
      actionPort: 28900,
      catalog: {
        id: 'default',
        components: [
          {
            type: 'Button',
            props: { label: { type: 'string', required: true } },
            actions: ['onClick'],
          },
        ],
      },
      actionToken: 'test-token-123',
      theme: 'dark',
      title: 'Test UI',
    })

    // Check HTML contains expected elements
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('Test UI')
    expect(html).toContain('test-surface')
    expect(html).toContain('28900')
    expect(html).toContain('test-token-123')
    expect(html).toContain('btn1')
    expect(html).toContain('Click me')
    // Check CSP nonce is present
    expect(html).toMatch(/nonce-[A-Za-z0-9+/=]+/)
  })

  it('should escape HTML in title', async () => {
    const { HTMLGenerator } = await import('../htmlGenerator.js')
    const generator = new HTMLGenerator()

    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: { id: 'default', components: [] },
      actionToken: 'token',
      title: '<script>alert("xss")</script>',
    })

    expect(html).not.toContain('<script>alert("xss")</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
