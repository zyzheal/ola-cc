import type { Logger, LoggerOptions } from '@opentelemetry/api-logs'

// Log severity levels (aligned with OTel semantic conventions)
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LEVEL_NUMBERS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
}

/**
 * Structured log entry with typed attributes.
 */
export type LogEntry = {
  level: LogLevel
  message: string
  /** Domain categorization for filtering */
  domain?: string
  /** Additional structured data */
  attributes?: Record<string, unknown>
  /** Error object (if applicable) */
  error?: Error
}

/**
 * Logger configuration.
 */
export type LoggerConfig = {
  /** Minimum level to emit (default: 'info') */
  minLevel?: LogLevel
  /** Sample rate for debug logs (0-1, default: 0.1) */
  debugSampleRate?: number
  /** OTel logger instance (optional) */
  otelLogger?: Logger
}

// Session-scoped singleton
let _structuredLogger: StructuredLogger | null = null

/**
 * Structured logger with OTel integration, sampling, and domain categorization.
 *
 * Features:
 * - Typed severity levels (debug/info/warn/error/fatal)
 * - Domain-based categorization (agent, tool, api, context, etc.)
 * - Configurable sampling for debug-level logs
 * - OTel logs SDK integration for external pipelines (ELK, Datadog)
 * - Fallback to console when OTel is not available
 */
export class StructuredLogger {
  private minLevel: LogLevel
  private debugSampleRate: number
  private otelLogger: Logger | null

  constructor(config?: LoggerConfig) {
    this.minLevel = config?.minLevel ?? 'info'
    this.debugSampleRate = config?.debugSampleRate ?? 0.1
    this.otelLogger = config?.otelLogger ?? null
  }

  /**
   * Get or create the session logger instance.
   */
  static getInstance(): StructuredLogger {
    if (!_structuredLogger) {
      _structuredLogger = new StructuredLogger({
        minLevel: (process.env.OLA_CC_LOG_LEVEL as LogLevel) ?? 'info',
        debugSampleRate: parseFloat(process.env.OLA_CC_DEBUG_SAMPLE_RATE ?? '0.1'),
      })
    }
    return _structuredLogger
  }

  /**
   * Reset the logger singleton (for testing).
   */
  static reset(): void {
    _structuredLogger = null
  }

  /**
   * Log a structured entry.
   */
  log(entry: LogEntry): void {
    // Level gate
    if (LEVEL_NUMBERS[entry.level] < LEVEL_NUMBERS[this.minLevel]) return

    // Debug sampling
    if (entry.level === 'debug' && Math.random() > this.debugSampleRate) return

    const otelAttrs: Record<string, string | number> = {
      level: entry.level,
      message: entry.message,
    }

    if (entry.domain) otelAttrs.domain = entry.domain
    if (entry.error) otelAttrs.error = entry.error.message

    // Merge custom attributes
    if (entry.attributes) {
      for (const [k, v] of Object.entries(entry.attributes)) {
        if (typeof v === 'string' || typeof v === 'number') {
          otelAttrs[k] = v
        } else {
          otelAttrs[k] = JSON.stringify(v)
        }
      }
    }

    // Emit to OTel if available
    if (this.otelLogger) {
      this.otelLogger.emit({
        severityText: entry.level,
        body: entry.message,
        attributes: otelAttrs,
      })
    } else {
      // Fallback to console
      const prefix = `[${entry.level.toUpperCase()}]`
      const domainPrefix = entry.domain ? `[${entry.domain}]` : ''
      const msg = `${prefix}${domainPrefix} ${entry.message}`

      switch (entry.level) {
        case 'error':
        case 'fatal':
          // eslint-disable-next-line no-console
          console.error(msg, entry.error ?? '')
          break
        case 'warn':
          // eslint-disable-next-line no-console
          console.warn(msg)
          break
        default:
          // eslint-disable-next-line no-console
          console.log(msg)
      }
    }
  }

  debug(message: string, domain?: string, attributes?: Record<string, unknown>): void {
    this.log({ level: 'debug', message, domain, attributes })
  }

  info(message: string, domain?: string, attributes?: Record<string, unknown>): void {
    this.log({ level: 'info', message, domain, attributes })
  }

  warn(message: string, domain?: string, attributes?: Record<string, unknown>): void {
    this.log({ level: 'warn', message, domain, attributes })
  }

  error(message: string, error?: Error, domain?: string, attributes?: Record<string, unknown>): void {
    this.log({ level: 'error', message, domain, attributes, error })
  }

  fatal(message: string, error?: Error, domain?: string, attributes?: Record<string, unknown>): void {
    this.log({ level: 'fatal', message, domain, attributes, error })
  }
}

/**
 * Convenience function for quick logging without singleton management.
 */
export function log(level: LogLevel, message: string, domain?: string, attributes?: Record<string, unknown>): void {
  StructuredLogger.getInstance().log({ level, message, domain, attributes })
}

// Re-export for convenience
export { StructuredLogger }
