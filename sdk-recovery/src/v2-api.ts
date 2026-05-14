import type { SDKSession, SDKSessionOptions, SDKUserMessage, SDKMessage, SDKResultMessage, NonNullableUsage } from './types';
import { createDefaultRegistry } from './cli/tools';
import { AnthropicApiClient } from './cli/agent/api-client';
import { PromptEngine } from './cli/agent/prompt-engine';
import { SessionManager, ManagedSession } from './core/session-manager';
import { AgentLoop } from './core/agent-loop';
import { createMockLogger } from './utils/logger';
import type { TextBlock } from './utils/anthropic-types';

const sessionManager = new SessionManager();

export async function unstable_v2_createSession(
  options: SDKSessionOptions,
): Promise<SDKSession> {
  return sessionManager.createSession(options);
}

export async function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions,
): Promise<SDKSession> {
  return sessionManager.resumeSession(sessionId, options);
}

export async function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  const session = (await sessionManager.createSession(options)) as ManagedSession;
  const logger = createMockLogger();
  const registry = createDefaultRegistry();

  const apiClient = new AnthropicApiClient({
    apiKey: options.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
    model: options.model,
    maxTokens: 4096,
    baseURL: options.env?.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL,
    logger,
  });

  const cwd = options.env?.cwd || process.cwd();
  const contextManager = session.getContextManager();
  const promptEngine = new PromptEngine();

  const systemPrompt = promptEngine.buildSystemPrompt({
    tools: registry.list(),
    workingDirectory: cwd,
  });

  // Add user message
  const textContent = message;
  contextManager.addMessage({ role: 'user', content: textContent });

  const agentLoop = new AgentLoop(apiClient, registry, logger, {
    getMessages: () => contextManager.getMessages(),
    addMessage: (msg) => contextManager.addMessage(msg),
    getTurnCount: () => contextManager.getTurnCount(),
    incrementTurn: () => contextManager.incrementTurn(),
    onMessage: (msg) => session.pushToStream(msg),
  }, { maxTurns: 100, model: options.model });

  try {
    const result = await agentLoop.execute({
      userMessage: message,
      systemPrompt,
      sessionId: session.sessionId,
    });

    await session.saveSession();
    session.finishStream();
    return result.resultMessage;
  } catch (err) {
    session.finishStream();
    return {
      type: 'result',
      subtype: 'error_during_execution',
      stop_reason: 'error',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        web_search_requests: 0,
        costUSD: 0,
        contextWindow: 0,
      } as unknown as NonNullableUsage,
      modelUsage: {},
      permission_denials: [],
      errors: [(err as Error).message],
      uuid: crypto.randomUUID() as any,
      session_id: session.sessionId,
    };
  }
}

// Re-export for backwards compatibility
export { sessionManager };
