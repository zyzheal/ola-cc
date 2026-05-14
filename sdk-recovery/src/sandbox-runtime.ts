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
 * SandboxManager — stub class with all static methods expected by sandbox-adapter.ts.
 * The actual sandbox implementation uses OS-level sandboxing (seatbelt on macOS,
 * seccomp on Linux). This stub provides the API surface for type-checking and
 * graceful degradation when sandboxing is not available.
 */
export class SandboxManager {
  private static _config: Partial<SandboxRuntimeConfig> = {};
  private static _store: SandboxViolationStore = {
    recordViolation: async () => {},
    getViolations: async () => [],
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
    _binShell: string,
    _args: string[],
    _env: Record<string, string>,
    _cwd: string,
    _config: Partial<SandboxRuntimeConfig>,
  ): Promise<{ process: unknown; stdout: unknown; stderr: unknown }> {
    throw new Error('Sandbox not available');
  }

  static async initialize(
    _config: Partial<SandboxRuntimeConfig>,
    _callback?: (event: SandboxViolationEvent) => Promise<void>,
  ): Promise<void> {}

  static updateConfig(config: Partial<SandboxRuntimeConfig>): void {
    this._config = config;
  }

  static reset(): void {
    this._config = {};
  }

  static getFsReadConfig(): FsReadRestrictionConfig {
    return { action: 'warn' };
  }

  static getFsWriteConfig(): FsWriteRestrictionConfig {
    return { action: 'warn' };
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

  static async waitForNetworkInitialization(): Promise<void> {}

  static getSandboxViolationStore(): SandboxViolationStore {
    return this._store;
  }

  static async annotateStderrWithSandboxFailures(
    _stderr: string,
  ): Promise<string> {
    return _stderr;
  }

  static cleanupAfterCommand(): void {}
}

/**
 * SandboxViolationStore — interface for storing and querying violation events.
 */
export interface SandboxViolationStore {
  recordViolation(event: SandboxViolationEvent): Promise<void>;
  getViolations(filter?: { type?: string }): Promise<SandboxViolationEvent[]>;
  clear(): Promise<void>;
}
