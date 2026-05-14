import { randomUUID } from 'node:crypto';
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  NonNullableUsage,
} from '../types';
import type { ToolUseBlock, TextBlock, MessageParam } from '../utils/anthropic-types';
import type { AnthropicApiClient } from '../cli/agent/api-client';
import type { ContextManager } from '../cli/agent/context-manager';
import type { PromptEngine } from '../cli/agent/prompt-engine';
import type { ToolRegistry } from '../cli/agent/tool-registry';
import type { Logger } from '../utils/logger';

export interface AgentLoopOptions {
  maxTurns?: number;
  model?: string;
}

export interface AgentLoopExecuteParams {
  userMessage: string;
  systemPrompt: string;
  sessionId: string;
}

export interface AgentLoopCallbacks {
  getMessages: () => MessageParam[];
  addMessage: (msg: MessageParam) => void;
  getTurnCount: () => number;
  incrementTurn: () => void;
  onMessage: (msg: SDKMessage) => void;
}

export interface AgentLoopResult {
  resultMessage: SDKResultMessage;
  turnCount: number;
}

export class AgentLoop {
  private apiClient: AnthropicApiClient;
  private registry: ToolRegistry;
  private logger: Logger;
  private maxTurns: number;
  private callbacks: AgentLoopCallbacks;

  constructor(
    apiClient: AnthropicApiClient,
    registry: ToolRegistry,
    logger: Logger,
    callbacks: AgentLoopCallbacks,
    options: AgentLoopOptions = {},
  ) {
    this.apiClient = apiClient;
    this.registry = registry;
    this.logger = logger;
    this.callbacks = callbacks;
    this.maxTurns = options.maxTurns ?? 100;
  }

  async execute(params: AgentLoopExecuteParams): Promise<AgentLoopResult> {
    const tools = this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as any,
    }));

    const startTime = Date.now();
    let turnCount = 0;

    while (turnCount < this.maxTurns) {
      const response = await this.apiClient.createMessage({
        system: params.systemPrompt,
        messages: this.callbacks.getMessages(),
        tools,
      });

      const assistantMsg: SDKMessage = {
        type: 'assistant',
        message: {
          id: response.id,
          type: 'message',
          role: 'assistant',
          content: response.content.map((block) => {
            if (block.type === 'tool_use') return block;
            return { type: 'text', text: (block as TextBlock).text ?? '' };
          }),
          model: response.model,
          stop_reason: response.stopReason as any,
          stop_sequence: null,
          usage: response.usage as any,
        },
        parent_tool_use_id: null,
        session_id: params.sessionId,
        uuid: randomUUID() as any,
      };

      this.callbacks.onMessage(assistantMsg);

      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use',
      );

      if (toolUseBlocks.length === 0) {
        // No tool use — final response
        const elapsedMs = Date.now() - startTime;
        const inputCost = (response.usage.input_tokens ?? 0) * 3e-6;
        const outputCost = (response.usage.output_tokens ?? 0) * 15e-6;

        const resultMsg: SDKResultMessage = {
          type: 'result',
          subtype: 'success',
          stop_reason: response.stopReason ?? null,
          duration_ms: elapsedMs,
          duration_api_ms: elapsedMs,
          is_error: false,
          num_turns: this.callbacks.getTurnCount(),
          result: response.content
            .filter((b): b is TextBlock => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n'),
          total_cost_usd: Math.round((inputCost + outputCost) * 100000) / 100000,
          usage: response.usage as unknown as NonNullableUsage,
          modelUsage: {},
          permission_denials: [],
          session_id: params.sessionId,
          uuid: randomUUID() as any,
        };

        this.callbacks.onMessage(resultMsg);

        // Persist assistant response
        this.callbacks.addMessage({
          role: 'assistant',
          content: response.content
            .filter((b): b is TextBlock => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n'),
        });
        this.callbacks.incrementTurn();

        return { resultMessage: resultMsg, turnCount: turnCount + 1 };
      }

      // C1 fix: persist assistant tool_use message before tool_results
      this.callbacks.addMessage({
        role: 'assistant',
        content: toolUseBlocks.map((block) => ({
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input,
        })),
      });

      // Execute tools
      for (const toolUse of toolUseBlocks) {
        const cwd = process.cwd();
        const result = await this.registry.execute(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          { cwd, sessionId: params.sessionId },
        );

        this.callbacks.addMessage({
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: toolUse.id,
              content: result.content as any,
            },
          ],
        });
      }

      turnCount++;
      this.callbacks.incrementTurn();
    }

    // Max turns exceeded
    const elapsedMs = Date.now() - startTime;
    const errMsg: SDKResultMessage = {
      type: 'result',
      subtype: 'error_max_turns',
      stop_reason: 'max_turns',
      duration_ms: elapsedMs,
      duration_api_ms: elapsedMs,
      is_error: true,
      num_turns: turnCount,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        web_search_requests: 0,
      } as unknown as NonNullableUsage,
      modelUsage: {},
      permission_denials: [],
      errors: ['Max turns exceeded'],
      session_id: params.sessionId,
      uuid: randomUUID() as any,
    };

    this.callbacks.onMessage(errMsg);
    throw new Error('Max turns exceeded');
  }
}
