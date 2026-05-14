import type { MessageParam } from '../../utils/anthropic-types';

/**
 * Approximate token count using language-aware character-based heuristics.
 *
 * cl100k_base encoding characteristics:
 *   - English: ~4 chars/token (common words encode as single tokens)
 *   - Chinese/Japanese: ~1-2 chars/token (CJK chars are more token-expensive)
 *   - Code/JSON: ~3-4 chars/token (punctuation adds overhead)
 *   - Tool use blocks: ~50 token overhead per block for structure/formatting
 *
 * This is a heuristic — actual tokenization requires the official tokenizer.
 */
export function approximateTokens(text: string): number {
  if (text.length === 0) return 0;

  // Count CJK characters (Chinese, Japanese, Korean)
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const asciiChars = text.length - cjkCount;

  // English/ASCII: ~4 chars per token
  // CJK: ~1.5 chars per token
  return Math.ceil(asciiChars / 4) + Math.ceil(cjkCount / 1.5);
}

/**
 * Estimate token overhead for structured content blocks.
 */
function estimateBlockOverhead(blockType: string): number {
  switch (blockType) {
    case 'tool_use': return 55;  // id + name + input structure overhead
    case 'tool_result': return 20; // tool_use_id + wrapper structure
    default: return 5;
  }
}

export interface ContextManagerOptions {
  maxContextTokens?: number;
  maxTurns?: number;
}

/**
 * ContextManager tracks message history and estimates token usage.
 * Phase 3 version: simple message list with token estimation.
 * Phase 4 version: weight-based compaction and summarization.
 */
export class ContextManager {
  private messages: MessageParam[] = [];
  private maxContextTokens: number;
  private maxTurns: number;
  private turnCount = 0;

  constructor(options: ContextManagerOptions = {}) {
    this.maxContextTokens = options.maxContextTokens ?? 200_000;
    this.maxTurns = options.maxTurns ?? 100;
  }

  addMessage(msg: MessageParam): void {
    this.messages.push(msg);
  }

  getMessages(): MessageParam[] {
    return [...this.messages];
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  incrementTurn(): void {
    this.turnCount++;
  }

  /**
   * Estimate total tokens in the current message history.
   * Uses language-aware character-based approximation plus block overhead.
   */
  estimateTokens(): number {
    let total = 0;
    for (const msg of this.messages) {
      if (typeof msg.content === 'string') {
        total += approximateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          total += estimateBlockOverhead(block.type);
          if (block.type === 'text') {
            total += approximateTokens(block.text);
          } else if (block.type === 'tool_use') {
            total += approximateTokens(JSON.stringify(block.input));
          } else if (block.type === 'tool_result') {
            const textContent = Array.isArray(block.content)
              ? block.content.map(b => (b as { text?: string }).text ?? '').join('')
              : (block.content ?? '');
            total += approximateTokens(String(textContent));
          }
        }
      }
    }
    return total;
  }

  /**
   * Check if context is approaching the token limit.
   * Returns true if estimated usage is > 80% of max.
   */
  isNearLimit(): boolean {
    return this.estimateTokens() > this.maxContextTokens * 0.8;
  }

  /**
   * Check if max turns has been reached.
   */
  hasReachedMaxTurns(): boolean {
    return this.turnCount >= this.maxTurns;
  }

  /**
   * Compact context by removing older messages while preserving
   * critical tool_use/tool_result pairs and system prompt.
   *
   * Strategy: keep first N and last M messages, but ensure we don't
   * orphan tool_use without its corresponding tool_result.
   */
  compact(): void {
    if (this.messages.length <= 6) return;

    // Keep the first 2 messages and last 4 messages
    const keepFirst = 2;
    const keepLast = 4;

    if (this.messages.length <= keepFirst + keepLast) return;

    // Collect tool_use ids from ALL messages (including dropped range)
    const allToolUses = new Map<string, MessageParam>();
    for (const msg of this.messages) {
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as any).type === 'tool_use') {
            allToolUses.set((block as any).id, msg);
          }
        }
      }
    }

    // Keep first N and last M
    const first = this.messages.slice(0, keepFirst);
    const recent = this.messages.slice(-keepLast);

    // Ensure tool_use/tool_result pairs aren't split
    // If recent contains a tool_result, ensure its tool_use is included
    const needed: MessageParam[] = [];
    for (const msg of recent) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ((block as any).type === 'tool_result') {
            const toolUseId = (block as any).tool_use_id;
            const toolUseMsg = allToolUses.get(toolUseId);
            if (toolUseMsg && !first.includes(toolUseMsg) && !recent.includes(toolUseMsg) && !needed.includes(toolUseMsg)) {
              needed.push(toolUseMsg);
            }
          }
        }
      }
    }

    this.messages = [...first, ...needed, ...recent];
  }

  /**
   * Reset context for a new session.
   */
  reset(): void {
    this.messages = [];
    this.turnCount = 0;
  }
}
