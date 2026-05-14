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
 * Note: Using z.string() or z.custom() instead of z.instanceof(RegExp) for compatibility.
 */
export const SandboxRuntimeConfigSchema = z.object({
  enabled: z.boolean().optional(),
  network: z.object({
    enabled: z.boolean().optional(),
    allowedHosts: z.array(z.union([z.string(), z.custom((val) => val instanceof RegExp)])).optional(),
    blockedHosts: z.array(z.union([z.string(), z.custom((val) => val instanceof RegExp)])).optional(),
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
 * SandboxManager — stub class with all static methods expected by sandbox-adapter.ts.
 * The actual sandbox implementation uses OS-level sandboxing (seatbelt on macOS,
 * seccomp on Linux). This stub provides the API surface for type-checking and
 * graceful degradation when sandboxing is not available.
 *
 * ⚠️ WARNING: This is a STUB for development/build compatibility only.
 * In production, this should be replaced with a real sandbox implementation.
 */
export class SandboxManager {
  private static _config: Partial<SandboxRuntimeConfig> = {};
  private static _store: SandboxViolationStore = {
    recordViolation: async () => {},
    getViolations: async () => [],
    getViolationsByType: async () => [],
    clear: async () => {},
  };

  static checkDependencies(_opts: { command: string; args: string[] }): SandboxDependencyCheck {
    return { name: _opts.command, available: false, message: 'Sandbox not available' };
  }

  static isSupportedPlatform(): boolean {
    return false;
  }

  static async wrapWithSandbox(
    _command: string,
    _binShell?: string,
    _customConfig?: Partial<SandboxRuntimeConfig>,
    _abortSignal?: AbortSignal,
  ): Promise<string> {
    // Stub: return command as-is since sandboxing is not available
    throw new Error('Sandbox not available');
  }

  static async initialize(
    _config: Partial<SandboxRuntimeConfig>,
    _sandboxAskCallback?: SandboxAskCallback,
  ): Promise<void> {
    // Stub: no-op since sandbox is not available
  }

  static updateConfig(config: Partial<SandboxRuntimeConfig>): void {
    this._config = config;
  }

  static reset(): void {
    this._config = {};
  }

  // Return config in the format expected by sandbox-adapter.ts
  static getFsReadConfig(): { action: string; paths: string[]; patterns: string[] } {
    return { action: 'warn', paths: [], patterns: [] };
  }

  static getFsWriteConfig(): { action: string; paths: string[]; patterns: string[] } {
    return { action: 'warn', paths: [], patterns: [] };
  }

  static getNetworkRestrictionConfig(): NetworkRestrictionConfig {
    return {};
  }

  static getIgnoreViolations(): IgnoreViolationsConfig | undefined {
    return undefined;
  }

  static getAllowUnixSockets(): boolean {
    return false;
  }

  static getAllowLocalBinding(): boolean {
    return false;
  }

  static getEnableWeakerNestedSandbox(): boolean {
    return false;
  }

  static getProxyPort(): number {
    return 0;
  }

  static getSocksProxyPort(): number {
    return 0;
  }

  static getLinuxHttpSocketPath(): string {
    return '';
  }

  static getLinuxSocksSocketPath(): string {
    return '';
  }

  static async waitForNetworkInitialization(): Promise<boolean> {
    return false;
  }

  static getSandboxViolationStore(): SandboxViolationStore {
    return this._store;
  }

  static annotateStderrWithSandboxFailures(
    _command: string,
    _stderr: string,
  ): string {
    // Stub: return stderr as-is
    return _stderr;
  }

  static cleanupAfterCommand(): void {
    // Stub: no-op
  }
}

/**
 * SandboxViolationStore — interface for storing and querying violation events.
 */
export interface SandboxViolationStore {
  recordViolation(event: SandboxViolationEvent): Promise<void>;
  getViolations(filter?: { type?: string }): Promise<SandboxViolationEvent[]>;
  getViolationsByType(type: 'filesystem' | 'network'): Promise<SandboxViolationEvent[]>;
  clear(): Promise<void>;
}
