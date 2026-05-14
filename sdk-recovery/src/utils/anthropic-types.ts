// src/utils/anthropic-types.ts
/**
 * Anthropic Messages API type definitions.
 * Recovered from usage patterns across the codebase.
 */

export interface MessageParam {
  role: "user" | "assistant" | "system";
  content: string | Array<TextBlock | ToolUseBlock | ToolResultBlock>;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type: string;
    data?: string;
    url?: string;
  };
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface BetaMessage {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<TextBlock | ToolUseBlock>;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: Usage;
}

export interface BetaUsage extends Usage {
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface MessageStartEvent {
  type: "message_start";
  index?: number;
  message: {
    id: string;
    model: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
}

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index?: number;
  content_block: {
    type: "text" | "tool_use";
    id?: string;
    name?: string;
    text?: string;
  };
}

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index?: number;
  delta: {
    type: "text_delta";
    text: string;
  } | {
    type: "input_json_delta";
    partial_json: string;
  };
}

export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index?: number;
}

export interface MessageDeltaEvent {
  type: "message_delta";
  index?: number;
  delta: {
    stop_reason: string | null;
    stop_sequence: string | null;
  };
  usage?: { output_tokens: number };
}

export interface MessageStopEvent {
  type: "message_stop";
  index?: number;
}

export type BetaRawMessageStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent;

export type BetaContentBlock = TextBlock | ToolUseBlock;
