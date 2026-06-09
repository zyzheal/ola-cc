/**
 * Pure utility functions extracted from agentToolUtils.ts.
 *
 * This file has ZERO imports from the AgentTool dependency chain,
 * making it safe to import in test environments without triggering
 * the circular dependency:
 *   agentToolUtils → agentSummary → runAgent → commands → tools → AgentTool → agentToolUtils
 *
 * @module
 */

import type { Message as MessageType } from '../../types/message.js'

/** Type-safe check for attachment messages with a specific attachment.type. */
function hasAttachmentType(msg: MessageType, type: string): boolean {
  if (msg.type !== 'attachment') return false
  const att = (msg as unknown as { attachment?: { type?: unknown } }).attachment
  return typeof att?.type === 'string' && att.type === type
}

/**
 * Count total tool_use blocks across all assistant messages.
 */
export function countToolUses(messages: MessageType[]): number {
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant') {
      // Defensive check: message property may be undefined for some assistant messages
      if (!m.message || !Array.isArray(m.message.content)) {
        continue;
      }
      for (const block of m.message.content) {
        if (block.type === 'tool_use') {
          count++
        }
      }
    }
  }
  return count
}

/**
 * Infer agent termination reason from multiple signals.
 *
 * Priority:
 * 1. Explicit terminationReason passed by caller (highest)
 * 2. max_tool_calls_reached attachment in messages → budget_exhausted
 * 3. Fallback used (no text/thinking content found) → cancelled
 * 4. Default → completed
 *
 * @internal — used by finalizeAgentTool only; not part of the public API.
 */
export function resolveTerminationReason(
  agentMessages: MessageType[],
  usedFallback: boolean,
  terminationReason?: 'completed' | 'budget_exhausted' | 'timeout' | 'cancelled',
): 'completed' | 'budget_exhausted' | 'timeout' | 'cancelled' {
  const hasBudgetAttachment = agentMessages.some(
    m => hasAttachmentType(m, 'max_tool_calls_reached'),
  )
  return (
    terminationReason ??
    (hasBudgetAttachment ? 'budget_exhausted' : undefined) ??
    (usedFallback ? 'cancelled' : 'completed')
  )
}

/**
 * Build a text summary from tool use history as a last-resort fallback.
 * Extracts tool names and input keys to give the parent agent a trace of
 * what the sub-agent did, even when no text output was produced.
 *
 * @internal — used by finalizeAgentTool only; not part of the public API.
 */
export function buildToolUseSummary(messages: MessageType[]): string | null {
  const toolCalls: { name: string; inputKeys: string[] }[] = []
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    if (!m.message || !Array.isArray(m.message.content)) continue
    for (const block of m.message.content) {
      if (block.type === 'tool_use' && 'name' in block) {
        const inputKeys = block.input && typeof block.input === 'object'
          ? Object.keys(block.input).slice(0, 5)
          : []
        toolCalls.push({ name: block.name, inputKeys })
      }
    }
  }
  if (toolCalls.length === 0) return null
  const lines = toolCalls.map((t, i) =>
    `  ${i + 1}. ${t.name}${t.inputKeys.length > 0 ? `(${t.inputKeys.join(', ')})` : ''}`
  )
  return [
    '[Agent produced no text output. Tool call trace:]',
    ...lines,
    '',
    `Total: ${toolCalls.length} tool calls executed.`,
  ].join('\n')
}
