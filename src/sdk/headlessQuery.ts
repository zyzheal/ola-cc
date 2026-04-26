/**
 * Headless query factory — creates a standalone QueryEngine-backed session
 * for SDK consumers without requiring the interactive REPL runtime.
 *
 * Usage:
 *   const q = createHeadlessQuery({ cwd: '/path/to/project', prompt: '...' })
 *   for await (const msg of q.messages()) { ... }
 */

import { randomUUID } from 'crypto'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'

import type { AppState, AppStateStore } from '../state/AppStateStore.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { createStore } from '../state/store.js'
import type { SDKMessage } from '../entrypoints/sdk/coreTypes.js'
import { asSessionId } from '../types/ids.js'
import { FileStateCache, READ_FILE_STATE_CACHE_SIZE } from '../utils/fileStateCache.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import type { Tool, ToolUseContext } from '../Tool.js'

// Lazy-load heavy modules to avoid pulling in the full REPL at import time.
/* eslint-disable @typescript-eslint/no-require-imports */
const getAllBaseTools = () =>
  require('../tools.js').getAllBaseTools as typeof import('../tools.js').getAllBaseTools
const getQueryEngine = () =>
  require('../QueryEngine.js')
    .QueryEngine as typeof import('../QueryEngine.js').QueryEngine
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Register global error handlers for headless mode.
 * In interactive mode, these are set up by init.ts → setupGracefulShutdown.
 * In headless/SDK mode, init.ts is bypassed, so we register them here.
 * Only registers once (guarded by a module-level flag).
 */
let headlessErrorHandlersRegistered = false

function registerHeadlessErrorHandlers(): void {
  if (headlessErrorHandlersRegistered) return
  headlessErrorHandlersRegistered = true

  process.on('unhandledRejection', reason => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    console.error('[headless] unhandledRejection:', msg)
  })

  process.on('uncaughtException', error => {
    console.error('[headless] uncaughtException:', error.message)
  })
}

export type HeadlessQueryOptions = {
  /** Working directory for the session. */
  cwd: string
  /** Initial prompt to submit. */
  prompt: string
  /** Model to use (falls back to env/config default). */
  model?: string
  /** Max turns before auto-stop. */
  maxTurns?: number
  /** Max budget in USD. */
  maxBudgetUsd?: number
  /** Enable verbose logging. */
  verbose?: boolean
  /** Abort signal for canceling the query. */
  signal?: AbortSignal
}

export type HeadlessQuery = {
  /** Async generator yielding SDK messages. */
  messages(): AsyncGenerator<SDKMessage, void, unknown>
  /** Abort the running query. */
  abort(): void
}

/**
 * Create a minimal AppStateStore for headless operation.
 */
function createHeadlessStore(): { getAppState: () => AppState; setAppState: AppStateStore['setState'] } {
  const state: AppState = {
    ...getDefaultAppState(),
    tasks: {},
    agentNameRegistry: new Map(),
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: { marketplaces: [], plugins: [] },
      needsRefresh: false,
    },
    notifications: { current: null, queue: [] },
    elicitation: { queue: [] },
    agentDefinitions: { builtin: [], custom: [], errors: [] },
    todos: {},
    remoteAgentTaskSuggestions: [],
    thinkingEnabled: undefined,
  }

  const store = createStore<AppState>(state)
  return {
    getAppState: store.getState,
    setAppState: store.setState,
  }
}

/**
 * Create a no-op canUseTool that auto-approves all tool calls.
 * In headless mode we trust the model — no interactive permission dialogs.
 */
function createAutoApproveCanUseTool(): (
  tool: Tool,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  assistantMessage: import('../types/message.js').AssistantMessage,
  toolUseID: string,
) => Promise<PermissionDecision> {
  return async () => ({
    behavior: 'allow' as const,
    decisionReason: { type: 'config', reason: 'headless-auto-approve' },
  })
}

/**
 * Create a headless query session.
 *
 * Sets up a minimal runtime (state store, tools, API client, QueryEngine)
 * and returns a Query-like object whose `messages()` generator yields
 * SDK messages for the given prompt.
 */
export function createHeadlessQuery(options: HeadlessQueryOptions): HeadlessQuery {
  const { cwd, prompt, model, maxTurns, maxBudgetUsd, verbose, signal } = options

  // Ensure session directory exists at creation time
  const sessionDir = join(cwd, '.claude', 'sessions')
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true })
  }

  const abortController = new AbortController()
  if (signal) {
    signal.addEventListener('abort', () => abortController.abort(), { once: true })
  }

  // Register global error handler for headless mode (bypasses init.ts).
  // Placed at function top-level so handlers are active even if consumer
  // creates a query but never iterates the generator.
  registerHeadlessErrorHandlers()

  return {
    async *messages() {

      // 2. Bootstrap global state
      const sessionId = randomUUID()
      ;(globalThis as Record<string, unknown>).__CLAUDE_CODE_SESSION_ID = asSessionId(sessionId)
      ;(globalThis as Record<string, unknown>).__CLAUDE_CODE_ORIGINAL_CWD = cwd
      ;(globalThis as Record<string, unknown>).__CLAUDE_CODE_PROJECT_ROOT = cwd
      ;(globalThis as Record<string, unknown>).__CLAUDE_CODE_IS_NON_INTERACTIVE = true

      // 2.5 Error handlers already registered at function top-level

      // 3. Create state store
      const { getAppState, setAppState } = createHeadlessStore()

      // 4. Get tools
      const tools = getAllBaseTools()

      // 5. Create FileStateCache
      const readFileCache = new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024)

      // 6. Create canUseTool
      const canUseTool = createAutoApproveCanUseTool()

      // 7. Create QueryEngine and run
      const QueryEngine = getQueryEngine()
      const engine = new QueryEngine({
        cwd,
        tools,
        commands: [],
        mcpClients: [],
        agents: [],
        canUseTool,
        getAppState,
        setAppState,
        initialMessages: [],
        readFileCache,
        userSpecifiedModel: model,
        maxTurns,
        maxBudgetUsd,
        verbose: verbose ?? false,
        abortController,
      })

      try {
        yield* engine.submitMessage(prompt)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        yield {
          type: 'assistant' as const,
          message: {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
          },
          session_id: sessionId,
        } as SDKMessage
        throw error
      }
    },
    abort() {
      abortController.abort()
    },
  }
}
