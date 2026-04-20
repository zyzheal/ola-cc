import { describe, it, expect } from 'bun:test'
import { createOpenAICompatibleShimClient } from './openaiShim.js'

describe('openaiShim', () => {
  describe('createOpenAICompatibleShimClient', () => {
    it('throws when no API key is provided', () => {
      expect(() => createOpenAICompatibleShimClient({})).toThrow('OpenAI API key is not set')
    })

    it('creates client with provided API key', () => {
      const client = createOpenAICompatibleShimClient({ apiKey: 'test-key' })
      expect(client.beta).toBeDefined()
      expect(client.beta.messages).toBeDefined()
      expect(client.beta.messages.create).toBeDefined()
    })
  })

  describe('non-streaming response with mocked fetch', () => {
    it('converts response to Anthropic format', async () => {
      const mockFetch = async () => ({
        ok: true,
        json: async () => ({
          id: 'test-id',
          model: 'gpt-4o',
          choices: [{
            message: { role: 'assistant', content: 'Hello!', tool_calls: null },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      }) as Response

      const client = createOpenAICompatibleShimClient({
        apiKey: 'test-key',
        fetchOverride: mockFetch,
        maxRetries: 0,
      })

      const result = await client.beta.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 100,
      })

      expect(result.id).toBe('test-id')
      expect(result.model).toBe('gpt-4o')
      expect(result.stop_reason).toBe('end_turn')
      expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }])
    })
  })

  describe('tool conversion', () => {
    it('converts Anthropic tools to OpenAI format and sanitizes schema', async () => {
      let capturedBody: unknown
      const mockFetch = async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string)
        return {
          ok: true,
          json: async () => ({
            id: 'test-id',
            model: 'gpt-4o',
            choices: [{ message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        } as Response
      }

      const client = createOpenAICompatibleShimClient({
        apiKey: 'test-key',
        fetchOverride: mockFetch,
        maxRetries: 0,
      })

      await client.beta.messages.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 100,
        tools: [{
          name: 'get_weather',
          description: 'Get weather info',
          input_schema: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location', 'missing_field'],
          },
        }],
      })

      const body = capturedBody as { tools?: unknown[] }
      expect(body.tools).toBeDefined()
      expect(body.tools?.length).toBe(1)
      const tool = body.tools?.[0] as { type: string; function: { name: string; parameters: unknown } }
      expect(tool.type).toBe('function')
      expect(tool.function.name).toBe('get_weather')
      // Schema sanitizer should add missing_field to properties
      const params = tool.function.parameters as { properties: Record<string, unknown>; required: string[] }
      expect(params.properties.missing_field).toBeDefined()
      expect(params.required).toContain('location')
    })
  })
})
