/**
 * A2UITool — Agent-to-User Interface integration
 *
 * Renders interactive web UI from A2UI JSON messages.
 * Generates self-contained HTML, opens in browser,
 * and listens for user interaction callbacks via local HTTP.
 */

import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { openPath } from '../../utils/browser.js'
import { Catalog } from './catalog.js'
import { SurfaceStateMachine } from './surfaceStateMachine.js'
import { CircuitBreaker } from './circuitBreaker.js'
import { A2UIValidator } from './validator.js'
import { HTMLGenerator } from './htmlGenerator.js'
import { ActionServer } from './actionServer.js'
import { TempFileManager } from './tempFileManager.js'
import { ActionProcessor } from './actionProcessor.js'
import type { A2UIAction, A2UIMessage, A2UIOutput } from './types.js'

// ─── Input Schema ───

const a2uiMessageSchema = z.object({
  surfaceUpdate: z.object({
    surfaceId: z.string().optional(),
    components: z.array(z.object({
      id: z.string(),
      component: z.record(z.string(), z.unknown()),
    })),
  }).optional(),
  dataModelUpdate: z.object({
    surfaceId: z.string().optional(),
    contents: z.record(z.string(), z.unknown()),
  }).optional(),
  beginRendering: z.object({
    root: z.string(),
    catalog: z.string().optional(),
  }).optional(),
  deleteSurface: z.object({
    surfaceId: z.string(),
  }).optional(),
}).describe('A2UI protocol message')

const inputSchema = z.object({
  a2ui_messages: z.array(a2uiMessageSchema).min(1).describe('A2UI JSON messages to render'),
  catalog_id: z.string().optional().describe('Catalog ID to use'),
  surface_id: z.string().optional().describe('Surface ID to create'),
  theme: z.enum(['light', 'dark']).optional().describe('UI theme (default: dark)'),
  title: z.string().optional().describe('Page title'),
})

type Input = z.infer<typeof inputSchema>

// ─── Helpers ───

function generateSurfaceId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `a2ui-${timestamp}-${random}`
}

function sanitizeSurfaceId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '')
  if (safe.length === 0) return generateSurfaceId()
  return safe
}

function countComponents(messages: A2UIMessage[]): number {
  let count = 0
  for (const msg of messages) {
    if ('surfaceUpdate' in msg) {
      count += msg.surfaceUpdate.components.length
    }
  }
  return count
}

// ─── Singleton instances (shared across calls) ───

const catalog = new Catalog()
const stateMachine = new SurfaceStateMachine()
const circuitBreaker = new CircuitBreaker()
const validator = new A2UIValidator(catalog, stateMachine)
const htmlGenerator = new HTMLGenerator()
const actionServer = new ActionServer()
const tempFileManager = new TempFileManager()

// ─── Action-to-Conversation Bridge ───
const actionProcessor = new ActionProcessor()

// Register action callback to collect pending actions
actionServer.onAction(async (action: A2UIAction) => {
  actionProcessor.onActionReceived(action)
  logForDebugging('[A2UI] Action received:', action.actionType, 'on', action.componentId)
  return { status: 'ok', actionId: action.actionId }
})

// ─── Tool ───

export const a2uiTool = buildTool({
  name: 'a2ui',
  searchHint: 'render UI web page interactive form table button a2ui',
  maxResultSizeChars: 10_000,
  inputSchema,

  renderToolUseMessage(input: Input) {
    const count = input.a2ui_messages?.length || 0
    return `Rendering ${count} A2UI message(s)...`
  },

  async description() {
    return (
      'Render interactive web UI from A2UI JSON. Generates a self-contained HTML file ' +
      'and opens it in the browser. User interactions (clicks, form submissions) are ' +
      'sent back as Actions. Use this to create interactive dashboards, forms, tables, ' +
      'and other UI components that the user can interact with directly.'
    )
  },

  async prompt() {
    return `Render interactive web UI from A2UI JSON. Generates a self-contained HTML file and opens it in the browser.

Available components:
- Column: { children: string[], gap?: number } - Vertical layout
- Row: { children: string[], gap?: number } - Horizontal layout
- Text: { text: string, style?: object } - Text display
- Card: { child: string, title?: string } - Card container
- Button: { label: string, variant?: 'primary'|'secondary' } - Clickable button (supports onClick)
- TextField: { label?: string, placeholder?: string, value?: string } - Text input (supports onChange)
- Select: { label?: string, options: string[], value?: string } - Dropdown (supports onChange)

A2UI message format:
- surfaceUpdate: { components: [{ id: string, component: { type, props, children?, actions? } }] }
- dataModelUpdate: { contents: Record<string, unknown> }
- beginRendering: { root: string } - Start rendering from root component
- deleteSurface: { surfaceId: string } - Delete a surface

Example:
{
  a2ui_messages: [
    { surfaceUpdate: { components: [
      { id: "card1", component: { type: "Card", props: { title: "User Form", child: "col1" } } },
      { id: "col1", component: { type: "Column", props: { gap: 12 }, children: ["name", "email", "btn"] } },
      { id: "name", component: { type: "TextField", props: { label: "Name", placeholder: "Enter name" } } },
      { id: "email", component: { type: "TextField", props: { label: "Email", placeholder: "Enter email" } } },
      { id: "btn", component: { type: "Button", props: { label: "Submit" }, actions: ["onClick"] } }
    ] } },
    { beginRendering: { root: "card1" } }
  ],
  title: "User Form",
  theme: "dark"
}

User interactions (clicks, form changes) are sent back as Actions.`
  },

  async call(input: Input, _context, _canUseTool, _parentMessage, _onProgress) {
    // 0. Check for pending actions from previous interactions
    const surfaceId = sanitizeSurfaceId(input.surface_id || generateSurfaceId())
    const consumedActions = actionProcessor.consumeActions(surfaceId)
    if (consumedActions.length > 0) {
      logForDebugging(`[A2UI] Consuming ${consumedActions.length} pending actions for surface ${surfaceId}`)
    }

    // 1. Input validation
    if (!input.a2ui_messages || input.a2ui_messages.length === 0) {
      return {
        data: {
          surface_id: '',
          file_path: '',
          component_count: 0,
          action_port: 0,
          status: 'failed' as const,
        },
        newMessages: [{
          type: 'system' as const,
          message: 'A2UI validation failed: a2ui_messages is empty',
        }],
      }
    }

    // 1. Circuit breaker check
    if (circuitBreaker.isOpen()) {
      logForDebugging('[A2UI] Circuit breaker open, degrading')
      return {
        data: {
          surface_id: 'degraded',
          file_path: '',
          component_count: 0,
          action_port: 0,
          status: 'degraded' as const,
        },
        newMessages: [{
          type: 'system' as const,
          message: 'A2UI degraded: circuit breaker open due to repeated failures. Falling back to markdown rendering.',
        }],
      }
    }

    // 2. Validate A2UI JSON
    const validation = validator.validate(
      input.a2ui_messages as A2UIMessage[],
      surfaceId,
    )
    if (!validation.valid) {
      circuitBreaker.recordFailure()
      const errorDetails = validation.errors
        .map((e) => `- [${e.rule}] ${e.message}`)
        .join('\n')
      return {
        data: {
          surface_id: surfaceId,
          file_path: '',
          component_count: 0,
          action_port: 0,
          status: 'failed' as const,
        },
        newMessages: [{
          type: 'system' as const,
          message: `A2UI validation failed:\n${errorDetails}`,
        }],
      }
    }

    try {
      // 4. Generate action token
      const actionToken = actionServer.generateActionToken()

      // 5. Ensure Action server is running
      await actionServer.ensureRunning()

      // 6. Generate HTML
      const html = htmlGenerator.generate({
        messages: input.a2ui_messages as A2UIMessage[],
        surfaceId,
        actionPort: actionServer.port,
        catalog: catalog.get(input.catalog_id || 'default'),
        actionToken,
        theme: input.theme,
        title: input.title,
      })

      // 7. Write temp file
      const filePath = await tempFileManager.write(surfaceId, html)

      // 8. Open browser
      let status: 'rendered' | 'degraded' = 'rendered'
      try {
        await openPath(filePath)
      } catch (err) {
        logForDebugging('[A2UI] Cannot open browser:', err)
        status = 'degraded'
      }

      // 9. Record success
      circuitBreaker.recordSuccess()

      const output: A2UIOutput = {
        surface_id: surfaceId,
        file_path: filePath,
        component_count: countComponents(input.a2ui_messages as A2UIMessage[]),
        action_port: actionServer.port,
        status,
      }

      // 10. Build result with pending actions
      const newMessages: Array<{ type: 'system'; message: string }> = []

      // Include consumed actions as system messages
      if (consumedActions.length > 0) {
        const actionSummary = consumedActions
          .map((a) => `- ${a.summary}`)
          .join('\n')
        newMessages.push({
          type: 'system' as const,
          message: `User interactions received:\n${actionSummary}`,
        })
      }

      if (status === 'degraded') {
        newMessages.push({
          type: 'system' as const,
          message: `Cannot open browser (headless environment). HTML file saved at: ${filePath}`,
        })
      }

      return { data: output, newMessages: newMessages.length > 0 ? newMessages : undefined }
    } catch (err) {
      circuitBreaker.recordFailure()
      const errorMessage = err instanceof Error ? err.message : String(err)
      logForDebugging('[A2UI] Error:', errorMessage)
      return {
        data: {
          surface_id: surfaceId,
          file_path: '',
          component_count: 0,
          action_port: 0,
          status: 'failed' as const,
        },
        newMessages: [{
          type: 'system' as const,
          message: `A2UI error: ${errorMessage}`,
        }],
      }
    }
  },
})
