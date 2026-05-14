/**
 * Self-developed sandbox-runtime types.
 * Replaces @anthropic-ai/sandbox-runtime shim re-export.
 */

import { z } from 'zod';

/**
 * Sandbox runtime configuration.
 */
export interface SandboxRuntimeConfig {
  enabled?: boolean;
  network?: NetworkConfig;
  filesystem?: FilesystemConfig;
  ignoreViolations?: IgnoreViolationsConfig;
  [key: string]: unknown;
}

export interface NetworkConfig {
  enabled?: boolean;
  allowedHosts?: NetworkHostPattern[];
  blockedHosts?: NetworkHostPattern[];
  [key: string]: unknown;
}

/**
 * Network restriction config as returned by getNetworkRestrictionConfig().
 * Used in prompt construction and sandbox adapter.
 */
export interface NetworkRestrictionConfig {
  allowedHosts?: string[];
  deniedHosts?: string[];
  [key: string]: unknown;
}

export interface FilesystemConfig {
  readRestrictions?: FsReadRestrictionConfig[];
  writeRestrictions?: FsWriteRestrictionConfig[];
  [key: string]: unknown;
}

export interface IgnoreViolationsConfig {
  filesystem?: boolean;
  network?: boolean;
  [key: string]: unknown;
}

export type NetworkHostPattern = string | RegExp;

export interface FsReadRestrictionConfig {
  path?: string;
  pattern?: string;
  action?: 'block' | 'warn';
  denyOnly?: string[];
  allowWithinDeny?: string[];
  [key: string]: unknown;
}

export interface FsWriteRestrictionConfig {
  path?: string;
  pattern?: string;
  action?: 'block' | 'warn';
  allowOnly?: string[];
  denyWithinAllow?: string[];
  [key: string]: unknown;
}

export interface SandboxViolationEvent {
  type: 'filesystem' | 'network';
  action: 'read' | 'write' | 'connect';
  path?: string;
  host?: string;
  timestamp: string;
  [key: string]: unknown;
}

export type SandboxAskCallback = (event: SandboxViolationEvent) => Promise<'allow' | 'deny' | 'allowAlways'>;

export type SandboxDependencyCheck = {
  name: string;
  available: boolean;
  [key: string]: unknown;
};

/**
 * Zod schema for SandboxRuntimeConfig validation.
 */
export const SandboxRuntimeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  network: z.object({
    enabled: z.boolean().optional(),
    allowedHosts: z.array(z.union([z.string(), z.instanceof(RegExp)])).optional(),
    blockedHosts: z.array(z.union([z.string(), z.instanceof(RegExp)])).optional(),
  }).optional(),
  filesystem: z.object({
    readRestrictions: z.array(z.object({
      path: z.string().optional(),
      pattern: z.string().optional(),
      action: z.enum(['block', 'warn']).optional(),
    }).passthrough()).optional(),
    writeRestrictions: z.array(z.object({
      path: z.string().optional(),
      pattern: z.string().optional(),
      action: z.enum(['block', 'warn']).optional(),
    }).passthrough()).optional(),
  }).optional(),
  ignoreViolations: z.object({
    filesystem: z.boolean().optional(),
    network: z.boolean().optional(),
  }).optional(),
}).passthrough();

/**
 * SandboxManager — interface for managing sandboxed processes.
 * This is a type-only stub. The actual implementation uses OS-level sandboxing.
 */
export interface SandboxManager {
  run<T>(fn: () => Promise<T>, config?: Partial<SandboxRuntimeConfig>): Promise<T>;
  getConfig(): SandboxRuntimeConfig;
  updateConfig(config: Partial<SandboxRuntimeConfig>): void;
  getFsReadConfig(): FsReadRestrictionConfig;
  getFsWriteConfig(): FsWriteRestrictionConfig;
  getNetworkRestrictionConfig(): NetworkRestrictionConfig;
  getIgnoreViolations(): IgnoreViolationsConfig | undefined;
}

/**
 * SandboxViolationStore — interface for storing and querying violation events.
 */
export interface SandboxViolationStore {
  recordViolation(event: SandboxViolationEvent): Promise<void>;
  getViolations(filter?: { type?: string }): Promise<SandboxViolationEvent[]>;
  clear(): Promise<void>;
}
