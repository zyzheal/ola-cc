import { describe, test, expect } from 'bun:test'
import { a2uiTool } from '../A2UITool.js'

describe('A2UITool Integration', () => {
  test('should export a valid tool object', () => {
    expect(a2uiTool).toBeDefined()
    expect(a2uiTool.name).toBe('a2ui')
    expect(a2uiTool.inputSchema).toBeDefined()
  })

  test('should have required tool methods', () => {
    expect(typeof a2uiTool.call).toBe('function')
    expect(typeof a2uiTool.description).toBe('function')
    expect(typeof a2uiTool.prompt).toBe('function')
    expect(typeof a2uiTool.renderToolUseMessage).toBe('function')
  })

  test('should render tool use message', () => {
    const message = a2uiTool.renderToolUseMessage({
      a2ui_messages: [
        {
          surfaceUpdate: {
            components: [
              { id: 'a', component: { type: 'Button', props: {} } },
            ],
          },
        },
        {
          surfaceUpdate: {
            components: [
              { id: 'b', component: { type: 'Text', props: { text: 'hi' } } },
            ],
          },
        },
      ],
    } as any)

    expect(message).toContain('2')
    expect(message).toContain('A2UI message')
  })

  test('should have correct search hint', () => {
    expect(a2uiTool.searchHint).toContain('a2ui')
    expect(a2uiTool.searchHint).toContain('render')
  })

  test('should have max result size', () => {
    expect(a2uiTool.maxResultSizeChars).toBe(10_000)
  })

  test('should return description', async () => {
    const desc = await a2uiTool.description()
    expect(desc).toContain('A2UI')
    expect(desc).toContain('interactive')
  })

  test('should return prompt with component info', async () => {
    const prompt = await a2uiTool.prompt()
    expect(prompt).toContain('Button')
    expect(prompt).toContain('TextField')
    expect(prompt).toContain('Card')
    expect(prompt).toContain('Column')
  })
})
