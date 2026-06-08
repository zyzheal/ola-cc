import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ActionServer } from '../actionServer.js'

describe('ActionServer', () => {
  let server: ActionServer

  beforeEach(() => {
    server = new ActionServer({ port: 29100 }) // Use specific port range for tests
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

    try {
      await fetch(`http://127.0.0.1:${port}/a2ui/health`)
      expect(true).toBe(false) // Should not reach here
    } catch {
      // Expected - connection refused
    }
  })
})
