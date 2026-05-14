/**
 * Re-export types to simulate @anthropic-ai/sdk/resources paths.
 * This allows drop-in replacement for existing imports.
 */
export type {
  MessageParam,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ImageBlock,
  Tool,
  Usage,
  BetaMessage,
  BetaUsage,
  BetaRawMessageStreamEvent,
} from '../utils/anthropic-types.js';

// SDK-compatible type aliases — ContentBlockParam is the block union (no string)
export type TextBlockParam = { type: 'text'; text: string };
export type ToolUseBlockParam = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlockParam = { type: 'tool_result'; tool_use_id: string; content: string | Array<TextBlockParam | ImageBlockParam>; is_error?: boolean };
export type ImageBlockParam = { type: 'image'; source: { type: 'base64' | 'url'; media_type: string; data?: string; url?: string } };
export type Base64ImageSource = ImageBlockParam['source'];
export type ContentBlock = TextBlockParam | ToolUseBlockParam | ToolResultBlockParam | ImageBlockParam;
// ContentBlockParam = ContentBlock (for SDK compatibility)
export type ContentBlockParam = ContentBlock;

// Thinking blocks
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string };
export type ThinkingBlockParam = { type: 'thinking'; thinking?: string };

// Redacted thinking blocks
export type RedactedThinkingBlock = { type: 'redacted_thinking'; data: string };
export type RedactedThinkingBlockParam = { type: 'redacted_thinking'; data?: string };

// Beta types
export type BetaContentBlock = TextBlockParam | ToolUseBlockParam;
export type BetaContentBlockParam = ContentBlockParam;
export type BetaToolUseBlock = ToolUseBlockParam;
export type BetaMessageParam = import('../utils/anthropic-types.js').MessageParam;
export type BetaImageBlockParam = ImageBlockParam;
export type BetaToolResultBlockParam = ToolResultBlockParam;
export type BetaTool = { name: string; description: string; input_schema: Record<string, unknown> };
export type BetaToolUnion = BetaTool;
export type ContextManagementConfig = {
  edits?: Array<{ type: string; [key: string]: unknown }>;
  [key: string]: unknown;
};
export type BetaMessageStreamParams = Record<string, unknown> & {
  model: string;
  messages: import('../utils/anthropic-types.js').MessageParam[];
  max_tokens: number;
  system?: string | Array<{ type: string; text: string; cache_control?: { type: string } }>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: BetaToolChoiceAuto | BetaToolChoiceTool;
  stream?: boolean;
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' | 'adaptive' };
  output?: BetaOutputConfig;
  output_config?: BetaOutputConfig;
  speed?: number | 'fast';
  effort?: string;
  context_management?: ContextManagementConfig;
  temperature?: number;
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  betas?: string[];
};
export type BetaMessageDeltaUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { search_context_size: string; web_search_requests?: number };
  iterations?: number;
};
export type BetaOutputConfig = {
  max_tokens?: number;
  format?: 'json' | 'text' | 'json_schema' | { type: 'json' };
  effort?: string;
  task_budget?: { type: 'tokens'; remaining: number; max?: number };
  [key: string]: unknown;
};
export type BetaRequestDocumentBlock = { type: 'document'; source: { type: 'base64' | 'url'; media_type: string; data?: string; url?: string } };
export type BetaStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'model_context_window_exceeded' | null;
export type BetaToolChoiceAuto = { type: 'auto' };
export type BetaToolChoiceTool = { type: 'tool'; name: string };
export type BetaWebSearchTool20250305 = { type: 'web_search_20250305'; name?: string; allowed_domains?: string[]; disallowed_domains?: string[] };
export type BetaJSONOutputFormat = { type: 'json' };
export type BetaThinkingBlock = ThinkingBlock;
export type BetaRedactedThinkingBlock = RedactedThinkingBlock;

// Stream type (simplified)
export type Stream<T> = AsyncIterable<T> & {
  totalUsage?: import('../utils/anthropic-types.js').Usage;
  requestId?: string;
  controller?: AbortController;
};

// --- Additional types required by main codebase imports ---

// ToolChoice types (BetaToolChoiceAuto / BetaToolChoiceTool already exist above)
export type ToolChoice = 'auto' | 'any' | 'tool';
export type ToolChoiceAny = { type: 'any' };
export type ToolChoiceNone = { type: 'none' };

// Cache types
export type CacheControlEphemeral = { type: 'ephemeral' };
export type CacheCreation = { type: 'creation' };

// Citation types (simplified stubs — sufficient for type checking)
export type CitationCharLocation = { type: 'char_location'; start_index: number; end_index: number };
export type CitationCharLocationParam = CitationCharLocation;
export type CitationPageLocation = { type: 'page_location'; page_number: number };
export type CitationPageLocationParam = CitationPageLocation;
export type CitationContentBlockLocation = { type: 'content_block_location'; block_index: number };
export type CitationContentBlockLocationParam = CitationContentBlockLocation;
export type CitationsConfig = { enabled: boolean };
export type CitationsConfigParam = CitationsConfig;
export type CitationsDelta = CitationCharLocation;
export type CitationsWebSearchResultLocation = { type: 'web_search_result_location'; url: string };
export type CitationsSearchResultLocation = CitationsWebSearchResultLocation;

// ContentBlockSource types
export type ContentBlockSource = {
  type: 'content_block_source';
  content: ContentBlockSourceContent;
};
export type ContentBlockSourceContent = {
  text?: string;
  citations?: Array<CitationCharLocationParam | CitationPageLocationParam | CitationContentBlockLocationParam>;
};

// Document types
export type DocumentBlock = { type: 'document'; source: { type: 'base64' | 'url'; media_type: string; data?: string; url?: string } };
export type DocumentBlockParam = DocumentBlock;

// Message event types
export type MessageStreamEvent = import('../utils/anthropic-types.js').MessageStartEvent | import('../utils/anthropic-types.js').MessageDeltaEvent | import('../utils/anthropic-types.js').MessageStopEvent | RawContentBlockStartEvent | RawContentBlockDeltaEvent | RawContentBlockStopEvent;

// Raw event types
export type RawMessageStartEvent = { type: 'message_start'; message: import('../utils/anthropic-types.js').BetaMessage };
export type RawMessageStopEvent = { type: 'message_stop' };
export type RawMessageDeltaEvent = { type: 'message_delta'; delta: { stop_reason?: BetaStopReason }; usage: BetaMessageDeltaUsage };
export type RawContentBlockStartEvent = { type: 'content_block_start'; index: number; content_block: ContentBlockParam };
export type RawContentBlockDeltaEvent = { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text?: string } | { type: 'input_json_delta'; partial_json?: string } | { type: 'thinking_delta'; thinking?: string; signature?: string } | { type: 'signature_delta'; signature?: string } };
export type RawContentBlockStopEvent = { type: 'content_block_stop'; index: number };
export type RawContentBlockDelta = RawContentBlockDeltaEvent;
export type RawContentBlockStart = RawContentBlockStartEvent;
export type RawContentBlockStop = RawContentBlockStopEvent;

// Delta types
export type TextDelta = { type: 'text_delta'; text: string };
export type ThinkingDelta = { type: 'thinking_delta'; thinking: string; signature: string };
export type InputJSONDelta = { type: 'input_json_delta'; partial_json: string };
export type SignatureDelta = { type: 'signature_delta'; signature: string };

// Tool types
export type ToolUnion = import('../utils/anthropic-types.js').Tool;

// StopReason
export type StopReason = BetaStopReason;

// Metadata
export type Metadata = {
  user_id?: string;
  [key: string]: unknown;
};

// Model
export type Model = {
  id: string;
  display_name: string;
  created_at: string;
};

// MessageTokensCount
export type MessageTokensCount = {
  input_tokens: number;
};

// OutputConfig
export type OutputConfig = BetaOutputConfig;

// WebSearch types (simplified)
export type WebSearchResultBlock = { type: 'web_search_result'; url: string; title: string };
export type WebSearchResultBlockParam = WebSearchResultBlock;
