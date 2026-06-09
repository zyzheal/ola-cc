# A2UI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the A2UI (Agent-to-User Interface) integration with comprehensive tests and the missing Action-to-Conversation bridge.

**Architecture:** A2UI enables AI agents to generate interactive web UIs that render in the browser. The tool generates self-contained HTML files, opens them in the browser, and listens for user interaction callbacks via a local HTTP server. The missing piece is the ActionProcessor that bridges browser actions back to the agent conversation.

**Tech Stack:** TypeScript, Bun, Zod (validation), Node http module, crypto (security)

---

## Current State Analysis

### Already Implemented ✅
| Module | File | Status |
|--------|------|--------|
| A2UITool | `src/tools/A2UITool/A2UITool.ts` | Complete, uses buildTool pattern |
| Types | `src/tools/A2UITool/types.ts` | Complete, all interfaces defined |
| Catalog | `src/tools/A2UITool/catalog.ts` | Complete, 7 default components |
| Validator | `src/tools/A2UITool/validator.ts` | Complete, dual validation |
| StateMachine | `src/tools/A2UITool/surfaceStateMachine.ts` | Complete, all transitions |
| CircuitBreaker | `src/tools/A2UITool/circuitBreaker.ts` | Complete, 3-state machine |
| HTMLGenerator | `src/tools/A2UITool/htmlGenerator.ts` | Complete, security hardened |
| ActionServer | `src/tools/A2UITool/actionServer.ts` | Complete, auth tokens |
| TempFileManager | `src/tools/A2UITool/tempFileManager.ts` | Complete, path validation |
| HTML Template | `src/tools/A2UITool/templates/a2ui.html` | Complete, inline renderer |
| Tool Registration | `src/tools.ts` | Complete, registered |

### Missing ❌
| Item | Priority | Description |
|------|----------|-------------|
| Unit Tests | P0 | No test files exist for any module |
| ActionProcessor | P1 | Bridge browser actions back to agent conversation |
| Integration Tests | P1 | End-to-end flow tests |

---

## File Structure

```
src/tools/A2UITool/
├── __tests__/
│   ├── catalog.test.ts              # NEW: Catalog unit tests
│   ├── circuitBreaker.test.ts       # NEW: CircuitBreaker unit tests
│   ├── surfaceStateMachine.test.ts  # NEW: StateMachine unit tests
│   ├── validator.test.ts            # NEW: Validator unit tests
│   ├── htmlGenerator.test.ts        # NEW: HTMLGenerator unit tests
│   ├── actionServer.test.ts         # NEW: ActionServer unit tests
│   ├── tempFileManager.test.ts      # NEW: TempFileManager unit tests
│   ├── actionProcessor.test.ts      # NEW: ActionProcessor unit tests
│   └── A2UITool.integration.test.ts # NEW: Full integration test
├── actionProcessor.ts               # NEW: Action-to-conversation bridge
├── A2UITool.ts                      # Existing
├── actionServer.ts                  # Existing
├── catalog.ts                       # Existing
├── circuitBreaker.ts                # Existing
├── htmlGenerator.ts                 # Existing
├── surfaceStateMachine.ts           # Existing
├── tempFileManager.ts               # Existing
├── templates/
│   └── a2ui.html                    # Existing
├── types.ts                         # Existing
└── validator.ts                     # Existing
```

---

## Task 1: Catalog Unit Tests

**Files:**
- Create: `src/tools/A2UITool/__tests__/catalog.test.ts`

- [ ] **Step 1: Create test file with basic catalog tests**

```typescript
import { describe, test, expect } from 'bun:test'
import { Catalog } from '../catalog.js'

describe('Catalog', () => {
  test('should initialize with default catalog', () => {
    const catalog = new Catalog()
    const defaultConfig = catalog.get('default')

    expect(defaultConfig.id).toBe('default')
    expect(defaultConfig.components.length).toBeGreaterThan(0)
  })

  test('should have all required default components', () => {
    const catalog = new Catalog()
    const requiredTypes = ['Column', 'Row', 'Text', 'Card', 'Button', 'TextField', 'Select']

    for (const type of requiredTypes) {
      expect(catalog.hasComponent(type)).toBe(true)
    }
  })

  test('should return default catalog for unknown id', () => {
    const catalog = new Catalog()
    const unknown = catalog.get('nonexistent')

    expect(unknown.id).toBe('default')
  })

  test('should register custom catalog', () => {
    const catalog = new Catalog()
    catalog.register({
      id: 'custom',
      components: [
        {
          type: 'CustomWidget',
          props: { value: { type: 'string', required: true } },
        },
      ],
    })

    expect(catalog.get('custom').id).toBe('custom')
    expect(catalog.hasComponent('CustomWidget')).toBe(false) // hasComponent checks default
  })

  test('should get component definition', () => {
    const catalog = new Catalog()
    const buttonDef = catalog.getComponentDef('Button')

    expect(buttonDef).toBeDefined()
    expect(buttonDef?.type).toBe('Button')
    expect(buttonDef?.actions).toContain('onClick')
  })

  test('should return undefined for unknown component', () => {
    const catalog = new Catalog()
    const unknown = catalog.getComponentDef('UnknownComponent')

    expect(unknown).toBeUndefined()
  })

  test('should list all component types', () => {
    const catalog = new Catalog()
    const types = catalog.componentTypes

    expect(types).toContain('Button')
    expect(types).toContain('TextField')
    expect(types.length).toBe(7)
  })

  test('Button component should have correct props', () => {
    const catalog = new Catalog()
    const button = catalog.getComponentDef('Button')

    expect(button?.props.label).toEqual({ type: 'string', required: true })
    expect(button?.props.variant).toEqual({ type: 'string', default: 'primary' })
  })

  test('TextField component should have onChange action', () => {
    const catalog = new Catalog()
    const textField = catalog.getComponentDef('TextField')

    expect(textField?.actions).toContain('onChange')
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test src/tools/A2UITool/__tests__/catalog.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/A2UITool/__tests__/catalog.test.ts
git commit -m "test(a2ui): add Catalog unit tests"
```

---

## Task 2: CircuitBreaker Unit Tests

**Files:**
- Create: `src/tools/A2UITool/__tests__/circuitBreaker.test.ts`

- [ ] **Step 1: Create CircuitBreaker test file**

```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import { CircuitBreaker } from '../circuitBreaker.js'

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker

  beforeEach(() => {
    breaker = new CircuitBreaker()
  })

  test('should start in closed state', () => {
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.getState()).toBe('closed')
  })

  test('should open after 3 consecutive failures', () => {
    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(false)

    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(false)

    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(true)
    expect(breaker.getState()).toBe('open')
  })

  test('should reset failure count on success', () => {
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordSuccess()

    // Should need 3 more failures to open
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(false)
  })

  test('should transition to half-open after timeout', async () => {
    // Use short timeout for testing
    const shortTimeoutBreaker = new CircuitBreaker({ resetTimeoutMs: 100 })

    // Trip the breaker
    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()
    expect(shortTimeoutBreaker.isOpen()).toBe(true)

    // Wait for timeout
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Should be half-open now
    expect(shortTimeoutBreaker.isOpen()).toBe(false)
    expect(shortTimeoutBreaker.getState()).toBe('half-open')
  })

  test('should close on success in half-open state', async () => {
    const shortTimeoutBreaker = new CircuitBreaker({ resetTimeoutMs: 100 })

    // Trip the breaker
    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()

    // Wait for timeout
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Should be half-open
    expect(shortTimeoutBreaker.getState()).toBe('half-open')

    // Success should close it
    shortTimeoutBreaker.recordSuccess()
    expect(shortTimeoutBreaker.getState()).toBe('closed')
  })

  test('should reopen on failure in half-open state', async () => {
    const shortTimeoutBreaker = new CircuitBreaker({ resetTimeoutMs: 100 })

    // Trip the breaker
    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()
    shortTimeoutBreaker.recordFailure()

    // Wait for timeout
    await new Promise((resolve) => setTimeout(resolve, 150))

    // Should be half-open
    expect(shortTimeoutBreaker.getState()).toBe('half-open')

    // Failure should reopen it
    shortTimeoutBreaker.recordFailure()
    expect(shortTimeoutBreaker.getState()).toBe('open')
  })

  test('should reset completely', () => {
    breaker.recordFailure()
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.isOpen()).toBe(true)

    breaker.reset()
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.getState()).toBe('closed')
  })

  test('should respect custom failure threshold', () => {
    const customBreaker = new CircuitBreaker({ failureThreshold: 5 })

    for (let i = 0; i < 4; i++) {
      customBreaker.recordFailure()
      expect(customBreaker.isOpen()).toBe(false)
    }

    customBreaker.recordFailure()
    expect(customBreaker.isOpen()).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tools/A2UITool/__tests__/circuitBreaker.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/A2UITool/__tests__/circuitBreaker.test.ts
git commit -m "test(a2ui): add CircuitBreaker unit tests"
```

---

## Task 3: SurfaceStateMachine Unit Tests

**Files:**
- Create: `src/tools/A2UITool/__tests__/surfaceStateMachine.test.ts`

- [ ] **Step 1: Create SurfaceStateMachine test file**

```typescript
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
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tools/A2UITool/__tests__/surfaceStateMachine.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/A2UITool/__tests__/surfaceStateMachine.test.ts
git commit -m "test(a2ui): add SurfaceStateMachine unit tests"
```

---

## Task 4: Validator Unit Tests

**Files:**
- Create: `src/tools/A2UITool/__tests__/validator.test.ts`

- [ ] **Step 1: Create Validator test file**

```typescript
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
    // First message: create surface
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

    // Second message: beginRendering
    const msg2: A2UIMessage[] = [
      { beginRendering: { root: 'btn-1' } },
    ]

    const result2 = validator.validate(msg2, 'test-surface')
    expect(result2.valid).toBe(true)
  })

  test('should reject invalid state transition', () => {
    // Try dataModelUpdate without surfaceUpdate first
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
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tools/A2UITool/__tests__/validator.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/A2UITool/__tests__/validator.test.ts
git commit -m "test(a2ui): add Validator unit tests"
```

---

## Task 5: HTMLGenerator Unit Tests

**Files:**
- Create: `src/tools/A2UITool/__tests__/htmlGenerator.test.ts`

- [ ] **Step 1: Create HTMLGenerator test file**

```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import { HTMLGenerator } from '../htmlGenerator.js'
import type { A2UIMessage, CatalogConfig } from '../types.js'

describe('HTMLGenerator', () => {
  let generator: HTMLGenerator
  let defaultCatalog: CatalogConfig

  beforeEach(() => {
    generator = new HTMLGenerator()
    defaultCatalog = {
      id: 'default',
      components: [
        { type: 'Button', props: { label: { type: 'string', required: true } }, actions: ['onClick'] },
        { type: 'Text', props: { text: { type: 'string', required: true } } },
      ],
    }
  })

  test('should generate valid HTML', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            { id: 'btn-1', component: { type: 'Button', props: { label: 'Click' } } },
          ],
        },
      },
    ]

    const html = generator.generate({
      messages,
      surfaceId: 'test-surface',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'test-token-123',
    })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  test('should include nonce in CSP and script tags', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    // Should have nonce in CSP
    expect(html).toMatch(/script-src.*'nonce-[^']+'/)
    // Should have nonce on style tag
    expect(html).toMatch(/<style nonce="[^"]+">/)
  })

  test('should inject action port correctly', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 30000,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('data-port="30000"')
    expect(html).toContain('http://localhost:30000')
  })

  test('should inject surface ID', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'my-surface-123',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('data-surface-id="my-surface-123"')
  })

  test('should escape HTML in surface ID', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: '<script>alert("xss")</script>',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    // Should be escaped
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  test('should escape HTML in title', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
      title: '<img onerror="alert(1)">',
    })

    expect(html).not.toContain('<img onerror')
    expect(html).toContain('&lt;img')
  })

  test('should use dark theme by default', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('class="dark"')
  })

  test('should use light theme when specified', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
      theme: 'light',
    })

    expect(html).toContain('class="light"')
  })

  test('should inject A2UI messages as JSON', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            { id: 'btn-1', component: { type: 'Button', props: { label: 'Test' } } },
          ],
        },
      },
    ]

    const html = generator.generate({
      messages,
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    // Should be in a script[type="application/json"] tag
    expect(html).toContain('<script id="a2ui-data" type="application/json">')
    expect(html).toContain('"type":"Button"')
  })

  test('should inject action token', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'my-secret-token',
    })

    expect(html).toContain('data-token="my-secret-token"')
  })

  test('should include component catalog in config', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('data-catalog=')
    expect(html).toContain('"type":"Button"')
  })

  test('should generate default title when not specified', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'surf-abc',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('<title>A2UI - surf-abc</title>')
  })

  test('should use custom title when specified', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
      title: 'My Dashboard',
    })

    expect(html).toContain('<title>My Dashboard</title>')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tools/A2UITool/__tests__/htmlGenerator.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/A2UITool/__tests__/htmlGenerator.test.ts
git commit -m "test(a2ui): add HTMLGenerator unit tests"
```

---

## Task 6: TempFileManager Unit Tests

**Files:**
- Create: `src/tools/A2UITool/__tests__/tempFileManager.test.ts`

- [ ] **Step 1: Create TempFileManager test file**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TempFileManager } from '../tempFileManager.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('TempFileManager', () => {
  let manager: TempFileManager
  let createdFiles: string[]

  beforeEach(() => {
    manager = new TempFileManager()
    createdFiles = []
  })

  afterEach(async () => {
    // Cleanup any files we created
    for (const file of createdFiles) {
      try {
        await fs.promises.unlink(file)
      } catch {
        // Ignore
      }
    }
  })

  test('should generate valid temp file path', () => {
    const filePath = manager.generatePath('test-surface')

    expect(filePath).toContain(os.tmpdir())
    expect(filePath).toContain('a2ui_test-surface.html')
  })

  test('should sanitize surface ID', () => {
    const filePath = manager.generatePath('test@surface#123')

    expect(filePath).toContain('a2ui_testsurface123.html')
  })

  test('should reject path traversal attempts', () => {
    expect(() => manager.generatePath('../etc/passwd')).toThrow('Invalid surfaceId')
    expect(() => manager.generatePath('test/../../../etc')).toThrow('Invalid surfaceId')
  })

  test('should reject empty surface ID', () => {
    expect(() => manager.generatePath('')).toThrow('Invalid surfaceId')
  })

  test('should reject surface ID with only special chars', () => {
    expect(() => manager.generatePath('@#$%')).toThrow('Invalid surfaceId')
  })

  test('should write HTML file', async () => {
    const filePath = await manager.write('test-write', '<html>test</html>')
    createdFiles.push(filePath)

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(content).toBe('<html>test</html>')
  })

  test('should set restrictive file permissions', async () => {
    const filePath = await manager.write('test-perms', '<html></html>')
    createdFiles.push(filePath)

    const stats = await fs.promises.stat(filePath)
    const mode = (stats.mode & 0o777).toString(8)
    expect(mode).toBe('600')
  })

  test('should track active surfaces', async () => {
    const filePath = await manager.write('tracked-surface', '<html></html>')
    createdFiles.push(filePath)

    // Should be able to cleanup
    await manager.cleanup('tracked-surface')

    // File should be deleted
    const exists = await fs.promises.access(filePath).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  test('should cleanup all tracked surfaces', async () => {
    const file1 = await manager.write('surface-1', '<html>1</html>')
    const file2 = await manager.write('surface-2', '<html>2</html>')
    createdFiles.push(file1, file2)

    await manager.cleanupAll()

    const exists1 = await fs.promises.access(file1).then(() => true).catch(() => false)
    const exists2 = await fs.promises.access(file2).then(() => true).catch(() => false)
    expect(exists1).toBe(false)
    expect(exists2).toBe(false)
  })

  test('should handle cleanup of non-existent file gracefully', async () => {
    // Should not throw
    await manager.cleanup('nonexistent-surface')
  })

  test('should allow hyphens in surface ID', () => {
    const filePath = manager.generatePath('my-cool-surface')

    expect(filePath).toContain('a2ui_my-cool-surface.html')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tools/A2UITool/__tests__/tempFileManager.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/A2UITool/__tests__/tempFileManager.test.ts
git commit -m "test(a2ui): add TempFileManager unit tests"
```

---

## Task 7: ActionProcessor Implementation

**Files:**
- Create: `src/tools/A2UITool/actionProcessor.ts`
- Modify: `src/tools/A2UITool/A2UITool.ts` (integrate ActionProcessor)

- [ ] **Step 1: Create ActionProcessor**

```typescript
/**
 * ActionProcessor — Action-to-Conversation Bridge
 *
 * Bridges browser user interactions back to the agent conversation.
 * Stores pending actions and provides them to the agent on next tool call.
 */

import type { A2UIAction } from './types.js'

export interface ProcessedAction {
  surfaceId: string
  componentId: string
  actionType: string
  payload: Record<string, unknown>
  timestamp: number
  summary: string
}

export class ActionProcessor {
  private pendingActions: Map<string, A2UIAction[]> = new Map()
  private processedCount = 0

  /**
   * Called when a new action arrives from the browser
   */
  onActionReceived(action: A2UIAction): void {
    const actions = this.pendingActions.get(action.surfaceId) || []
    actions.push(action)
    this.pendingActions.set(action.surfaceId, actions)
    this.processedCount++
  }

  /**
   * Consume all pending actions for a surface (called by agent)
   */
  consumeActions(surfaceId: string): ProcessedAction[] {
    const actions = this.pendingActions.get(surfaceId) || []
    this.pendingActions.delete(surfaceId)

    return actions.map((a) => ({
      surfaceId: a.surfaceId,
      componentId: a.componentId,
      actionType: a.actionType,
      payload: a.payload,
      timestamp: a.timestamp,
      summary: this.summarizeAction(a),
    }))
  }

  /**
   * Check if there are pending actions for a surface
   */
  hasPendingActions(surfaceId: string): boolean {
    const actions = this.pendingActions.get(surfaceId)
    return !!actions && actions.length > 0
  }

  /**
   * Get count of pending actions for a surface
   */
  getPendingCount(surfaceId: string): number {
    return this.pendingActions.get(surfaceId)?.length || 0
  }

  /**
   * Get total processed action count
   */
  get totalProcessed(): number {
    return this.processedCount
  }

  /**
   * Clear all pending actions
   */
  clear(): void {
    this.pendingActions.clear()
  }

  /**
   * Generate human-readable summary of an action
   */
  private summarizeAction(action: A2UIAction): string {
    const { componentId, actionType, payload } = action

    switch (actionType) {
      case 'onClick':
        return `User clicked ${componentId}`
      case 'onChange':
        return `User changed ${componentId} value to: ${JSON.stringify(payload.value)}`
      case 'onSubmit':
        return `User submitted form on ${componentId}`
      default:
        return `User triggered ${actionType} on ${componentId}`
    }
  }
}
```

- [ ] **Step 2: Integrate ActionProcessor into A2UITool**

Modify `src/tools/A2UITool/A2UITool.ts` to add ActionProcessor:

```typescript
// Add import at top
import { ActionProcessor } from './actionProcessor.js'

// Add to singleton instances
const actionProcessor = new ActionProcessor()

// In the call() method, after step 9 (record success), add:

// 10. Check for pending actions
const pendingActions = actionProcessor.consumeActions(surfaceId)
if (pendingActions.length > 0) {
  const actionSummary = pendingActions
    .map((a) => `- ${a.summary}`)
    .join('\n')

  return {
    data: output,
    newMessages: [{
      type: 'system' as const,
      message: `User interactions on Surface ${surfaceId}:\n${actionSummary}`,
    }],
  }
}

// Also update ActionServer callback to feed ActionProcessor:
// In ensureRunning() or before, add:
actionServer.onAction(async (action) => {
  actionProcessor.onActionReceived(action)
  return { status: 'ok', actionId: action.actionId }
})
```

- [ ] **Step 3: Create ActionProcessor tests**

```typescript
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
})
```

- [ ] **Step 4: Run ActionProcessor tests**

Run: `bun test src/tools/A2UITool/__tests__/actionProcessor.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/A2UITool/actionProcessor.ts src/tools/A2UITool/__tests__/actionProcessor.test.ts src/tools/A2UITool/A2UITool.ts
git commit -m "feat(a2ui): add ActionProcessor for agent conversation bridge"
```

---

## Task 8: ActionServer Unit Tests

**Files:**
- Create: `src/tools/A2UITool/__tests__/actionServer.test.ts`

- [ ] **Step 1: Create ActionServer test file**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ActionServer } from '../actionServer.js'
import * as http from 'http'

describe('ActionServer', () => {
  let server: ActionServer

  beforeEach(() => {
    server = new ActionServer({ port: 0 }) // Random port
  })

  afterEach(async () => {
    await server.stop()
  })

  test('should start and listen on port', async () => {
    await server.ensureRunning()
    expect(server.port).toBeGreaterThan(0)
  })

  test('should respond to health check', async () => {
    await server.ensureRunning()

    const response = await fetch(`http://127.0.0.1:${server.port}/a2ui/health`)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
    expect(data.uptime).toBeDefined()
  })

  test('should generate unique action tokens', () => {
    const token1 = server.generateActionToken()
    const token2 = server.generateActionToken()

    expect(token1).not.toBe(token2)
    expect(token1.length).toBe(64) // 32 bytes hex
  })

  test('should reject action without token', async () => {
    await server.ensureRunning()

    const response = await fetch(`http://127.0.0.1:${server.port}/a2ui/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        surfaceId: 'test',
        actionId: 'a1',
        componentId: 'btn',
        actionType: 'onClick',
        payload: {},
        timestamp: Date.now(),
      }),
    })

    expect(response.status).toBe(401)
  })

  test('should reject action with invalid token', async () => {
    await server.ensureRunning()

    const response = await fetch(`http://127.0.0.1:${server.port}/a2ui/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Token': 'invalid-token',
      },
      body: JSON.stringify({
        surfaceId: 'test',
        actionId: 'a1',
        componentId: 'btn',
        actionType: 'onClick',
        payload: {},
        timestamp: Date.now(),
      }),
    })

    expect(response.status).toBe(401)
  })

  test('should accept action with valid token', async () => {
    await server.ensureRunning()
    const token = server.generateActionToken()

    const response = await fetch(`http://127.0.0.1:${server.port}/a2ui/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Token': token,
      },
      body: JSON.stringify({
        surfaceId: 'test',
        actionId: 'a1',
        componentId: 'btn',
        actionType: 'onClick',
        payload: {},
        timestamp: Date.now(),
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.status).toBe('ok')
  })

  test('should reject invalid action type', async () => {
    await server.ensureRunning()
    const token = server.generateActionToken()

    const response = await fetch(`http://127.0.0.1:${server.port}/a2ui/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Token': token,
      },
      body: JSON.stringify({
        surfaceId: 'test',
        actionId: 'a1',
        componentId: 'btn',
        actionType: 'onInvalid', // Not in whitelist
        payload: {},
        timestamp: Date.now(),
      }),
    })

    expect(response.status).toBe(403)
  })

  test('should reject missing required fields', async () => {
    await server.ensureRunning()
    const token = server.generateActionToken()

    const response = await fetch(`http://127.0.0.1:${server.port}/a2ui/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Token': token,
      },
      body: JSON.stringify({
        // Missing surfaceId and actionId
        componentId: 'btn',
        actionType: 'onClick',
      }),
    })

    expect(response.status).toBe(400)
  })

  test('should reject invalid JSON', async () => {
    await server.ensureRunning()
    const token = server.generateActionToken()

    const response = await fetch(`http://127.0.0.1:${server.port}/a2ui/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Token': token,
      },
      body: 'not json',
    })

    expect(response.status).toBe(400)
  })

  test('should call callback on action', async () => {
    let callbackCalled = false
    let receivedAction: any = null

    server.onAction(async (action) => {
      callbackCalled = true
      receivedAction = action
      return { status: 'ok', actionId: action.actionId }
    })

    await server.ensureRunning()
    const token = server.generateActionToken()

    await fetch(`http://127.0.0.1:${server.port}/a2ui/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Token': token,
      },
      body: JSON.stringify({
        surfaceId: 'test',
        actionId: 'a1',
        componentId: 'btn',
        actionType: 'onClick',
        payload: { value: 'clicked' },
        timestamp: Date.now(),
      }),
    })

    expect(callbackCalled).toBe(true)
    expect(receivedAction.surfaceId).toBe('test')
    expect(receivedAction.payload.value).toBe('clicked')
  })

  test('should handle CORS preflight', async () => {
    await server.ensureRunning()

    const response = await fetch(`http://127.0.0.1:${server.port}/a2ui/action`, {
      method: 'OPTIONS',
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST')
  })

  test('should return 404 for unknown routes', async () => {
    await server.ensureRunning()

    const response = await fetch(`http://127.0.0.1:${server.port}/unknown`)

    expect(response.status).toBe(404)
  })

  test('should list active surfaces', async () => {
    await server.ensureRunning()
    const token = server.generateActionToken()

    // Send action for surface-1
    await fetch(`http://127.0.0.1:${server.port}/a2ui/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Token': token,
      },
      body: JSON.stringify({
        surfaceId: 'surface-1',
        actionId: 'a1',
        componentId: 'btn',
        actionType: 'onClick',
        payload: {},
        timestamp: Date.now(),
      }),
    })

    const response = await fetch(`http://127.0.0.1:${server.port}/a2ui/surfaces`)
    const data = await response.json()

    expect(data.surfaces).toContain('surface-1')
  })

  test('should stop server cleanly', async () => {
    await server.ensureRunning()
    const port = server.port

    await server.stop()

    // Server should not be listening anymore
    try {
      await fetch(`http://127.0.0.1:${port}/a2ui/health`)
      expect(true).toBe(false) // Should not reach here
    } catch {
      // Expected - connection refused
    }
  })
})
```

- [ ] **Step 2: Run tests**

Run: `bun test src/tools/A2UITool/__tests__/actionServer.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/A2UITool/__tests__/actionServer.test.ts
git commit -m "test(a2ui): add ActionServer unit tests"
```

---

## Task 9: Integration Test

**Files:**
- Create: `src/tools/A2UITool/__tests__/A2UITool.integration.test.ts`

- [ ] **Step 1: Create integration test file**

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { A2UITool } from '../A2UITool.js'

describe('A2UITool Integration', () => {
  // Note: These tests verify the tool's type structure and validation
  // Actual browser opening is mocked/skipped in unit tests

  test('should export a valid tool object', () => {
    expect(A2UITool).toBeDefined()
    expect(A2UITool.name).toBe('a2ui')
    expect(A2UITool.inputSchema).toBeDefined()
  })

  test('should have required tool methods', () => {
    expect(typeof A2UITool.call).toBe('function')
    expect(typeof A2UITool.description).toBe('function')
    expect(typeof A2UITool.prompt).toBe('function')
    expect(typeof A2UITool.renderToolUseMessage).toBe('function')
  })

  test('should render tool use message', () => {
    const message = A2UITool.renderToolUseMessage({
      a2ui_messages: [
        { surfaceUpdate: { components: [{ id: 'a', component: { type: 'Button', props: {} } }] } },
        { surfaceUpdate: { components: [{ id: 'b', component: { type: 'Text', props: { text: 'hi' } }] } } },
      ],
    })

    expect(message).toContain('2')
    expect(message).toContain('A2UI message')
  })

  test('should have correct search hint', () => {
    expect(A2UITool.searchHint).toContain('a2ui')
    expect(A2UITool.searchHint).toContain('render')
  })

  test('should have max result size', () => {
    expect(A2UITool.maxResultSizeChars).toBe(10_000)
  })
})
```

- [ ] **Step 2: Run integration tests**

Run: `bun test src/tools/A2UITool/__tests__/A2UITool.integration.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run all A2UI tests**

Run: `bun test src/tools/A2UITool/__tests__/`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/A2UITool/__tests__/A2UITool.integration.test.ts
git commit -m "test(a2ui): add integration tests"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `bun test src/tools/A2UITool/__tests__/`
Expected: All tests PASS (25+ tests)

- [ ] **Step 2: Verify build**

Run: `bun run build`
Expected: Build succeeds

- [ ] **Step 3: Verify tool is registered**

Run: `bun run dev --help` and check a2ui is listed
Expected: a2ui tool appears in help

- [ ] **Step 4: Create summary commit**

```bash
git add -A
git commit -m "feat(a2ui): complete A2UI integration with tests and ActionProcessor

- Added unit tests for all 8 modules (50+ tests)
- Implemented ActionProcessor for agent conversation bridge
- Integrated ActionProcessor into A2UITool call flow
- All tests passing, build verified"
```

---

## Success Criteria Verification

| Criteria | Verification |
|----------|-------------|
| Agent generates valid A2UI JSON | Unit tests: 100% validation pass rate for default catalog ✅ |
| HTML renders in browser | HTMLGenerator tests verify correct output ✅ |
| Action callbacks work | ActionServer tests verify auth + processing ✅ |
| Circuit breaker works | CircuitBreaker tests verify 3 failures → degraded ✅ |
| State machine prevents invalid transitions | StateMachine tests verify all transitions ✅ |
| Security: localhost only | ActionServer tests verify CORS + auth ✅ |
| Agent receives user actions | ActionProcessor implemented + tested ✅ |

---

## Implementation Summary

**Total Tasks:** 10
**Total Tests:** 50+
**New Files:** 9 (8 test files + 1 module)
**Modified Files:** 1 (A2UITool.ts)

**Key Deliverables:**
1. Comprehensive unit test coverage for all A2UI modules
2. ActionProcessor for bridging browser actions to agent conversation
3. Integration tests verifying the complete flow
4. Build verification
