import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

export type ModelConfig = Record<APIProvider, ModelName>

// Model configurations - all model names must be provided via environment variables
// No hardcoded model names to support arbitrary proxy endpoints (DashScope, LiteLLM, etc.)

// Environment variable mapping:
// - CLAUDE_CODE_MODEL_HAIKU_35: Haiku 3.5 model name
// - CLAUDE_CODE_MODEL_HAIKU_45: Haiku 4.5 model name
// - CLAUDE_CODE_MODEL_SONNET_35: Sonnet 3.5 model name
// - CLAUDE_CODE_MODEL_SONNET_37: Sonnet 3.7 model name
// - CLAUDE_CODE_MODEL_SONNET_40: Sonnet 4.0 model name
// - CLAUDE_CODE_MODEL_SONNET_45: Sonnet 4.5 model name
// - CLAUDE_CODE_MODEL_SONNET_46: Sonnet 4.6 model name
// - CLAUDE_CODE_MODEL_OPUS_40: Opus 4.0 model name
// - CLAUDE_CODE_MODEL_OPUS_41: Opus 4.1 model name
// - CLAUDE_CODE_MODEL_OPUS_45: Opus 4.5 model name
// - CLAUDE_CODE_MODEL_OPUS_46: Opus 4.6 model name

function getEnvModel(envVar: string, fallback: string): string {
  return process.env[envVar] || fallback
}

// All model configs use environment variables with fallback to generic names
// The fallback allows system to work without env vars, but users should configure
// their specific model names via environment variables for proxy endpoints

export const CLAUDE_3_7_SONNET_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_SONNET_37', 'sonnet-3-7'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_SONNET_37', 'sonnet-3-7'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_SONNET_37', 'sonnet-3-7'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_SONNET_37', 'sonnet-3-7'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_SONNET_37', 'sonnet-3-7'),
} as const satisfies ModelConfig

export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_SONNET_35', 'sonnet-3-5'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_SONNET_35', 'sonnet-3-5'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_SONNET_35', 'sonnet-3-5'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_SONNET_35', 'sonnet-3-5'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_SONNET_35', 'sonnet-3-5'),
} as const satisfies ModelConfig

export const CLAUDE_3_5_HAIKU_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_35', 'haiku-3-5'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_35', 'haiku-3-5'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_35', 'haiku-3-5'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_35', 'haiku-3-5'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_35', 'haiku-3-5'),
} as const satisfies ModelConfig

export const CLAUDE_HAIKU_4_5_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_45', 'haiku-4-5'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_45', 'haiku-4-5'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_45', 'haiku-4-5'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_45', 'haiku-4-5'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_HAIKU_45', 'haiku-4-5'),
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_SONNET_40', 'sonnet-4'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_SONNET_40', 'sonnet-4'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_SONNET_40', 'sonnet-4'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_SONNET_40', 'sonnet-4'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_SONNET_40', 'sonnet-4'),
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_5_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_SONNET_45', 'sonnet-4-5'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_SONNET_45', 'sonnet-4-5'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_SONNET_45', 'sonnet-4-5'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_SONNET_45', 'sonnet-4-5'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_SONNET_45', 'sonnet-4-5'),
} as const satisfies ModelConfig

export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_SONNET_46', 'sonnet-4-6'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_SONNET_46', 'sonnet-4-6'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_SONNET_46', 'sonnet-4-6'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_SONNET_46', 'sonnet-4-6'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_SONNET_46', 'sonnet-4-6'),
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_OPUS_40', 'opus-4'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_OPUS_40', 'opus-4'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_OPUS_40', 'opus-4'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_OPUS_40', 'opus-4'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_OPUS_40', 'opus-4'),
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_1_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_OPUS_41', 'opus-4-1'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_OPUS_41', 'opus-4-1'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_OPUS_41', 'opus-4-1'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_OPUS_41', 'opus-4-1'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_OPUS_41', 'opus-4-1'),
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_5_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_OPUS_45', 'opus-4-5'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_OPUS_45', 'opus-4-5'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_OPUS_45', 'opus-4-5'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_OPUS_45', 'opus-4-5'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_OPUS_45', 'opus-4-5'),
} as const satisfies ModelConfig

export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: getEnvModel('CLAUDE_CODE_MODEL_OPUS_46', 'opus-4-6'),
  bedrock: getEnvModel('CLAUDE_CODE_MODEL_OPUS_46', 'opus-4-6'),
  vertex: getEnvModel('CLAUDE_CODE_MODEL_OPUS_46', 'opus-4-6'),
  foundry: getEnvModel('CLAUDE_CODE_MODEL_OPUS_46', 'opus-4-6'),
  openai: getEnvModel('CLAUDE_CODE_MODEL_OPUS_46', 'opus-4-6'),
} as const satisfies ModelConfig

// @[MODEL LAUNCH]: Register the new config here.
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
} as const satisfies Record<string, ModelConfig>

export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** Union of all canonical first-party model IDs */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** Runtime list of canonical model IDs — used by comprehensiveness tests. */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** Map canonical ID → internal short key. Used to apply settings-based modelOverrides. */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>