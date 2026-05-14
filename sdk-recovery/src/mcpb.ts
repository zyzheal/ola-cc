/**
 * Self-developed MCPB types.
 * Replaces @anthropic-ai/mcpb shim.
 */

/**
 * MCPB manifest type (simplified — covers the fields used in the codebase).
 * Based on @anthropic-ai/mcpb McpbManifestAny.
 */
export interface McpbManifest {
  name?: string;
  displayName?: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  repository?: string;
  homepage?: string;
  icon?: string;
  category?: string;
  mcpServers?: Record<string, McpbServerConfig>;
  userConfiguration?: McpbUserConfigurationOption[];
  [key: string]: unknown;
}

export interface McpbServerConfig {
  type?: 'stdio' | 'http' | 'sse' | 'ws';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

/**
 * User configuration option for MCPB bundles.
 */
export interface McpbUserConfigurationOption {
  name?: string;
  title: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path' | 'secret' | 'file' | 'directory';
  required?: boolean;
  default?: string | number | boolean | string[];
  options?: string[];
  multiple?: boolean;
  sensitive?: boolean;
  min?: number;
  max?: number;
}
