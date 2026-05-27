import { z } from 'zod/v4'
import { CONFIG_OPTIONS, storageAdapter } from './constants.js'

export interface WebFetchConfig {
  autoConfirm: {
    enabled: boolean
    timeout: number
    maxAttempts: number
  }
  behavior: {
    skipPreflight: boolean
    allowAcademic: boolean
    allowTrusted: boolean
  }
  preferences: {
    rememberDecisions: boolean
    smartSuggestions: boolean
    categoryBasedDefaults: boolean
  }
}

export const defaultConfig: WebFetchConfig = {
  autoConfirm: {
    enabled: true,
    timeout: 300000, // 5 minutes
    maxAttempts: 3,
  },
  behavior: {
    skipPreflight: false,
    allowAcademic: true,
    allowTrusted: false,
  },
  preferences: {
    rememberDecisions: true,
    smartSuggestions: true,
    categoryBasedDefaults: true,
  },
}

export const configSchema = z.object({
  autoConfirm: z.object({
    enabled: z.boolean().default(defaultConfig.autoConfirm.enabled),
    timeout: z.number().min(1000).max(3600000).default(defaultConfig.autoConfirm.timeout),
    maxAttempts: z.number().min(1).max(10).default(defaultConfig.autoConfirm.maxAttempts),
  }),
  behavior: z.object({
    skipPreflight: z.boolean().default(defaultConfig.behavior.skipPreflight),
    allowAcademic: z.boolean().default(defaultConfig.behavior.allowAcademic),
    allowTrusted: z.boolean().default(defaultConfig.behavior.allowTrusted),
  }),
  preferences: z.object({
    rememberDecisions: z.boolean().default(defaultConfig.preferences.rememberDecisions),
    smartSuggestions: z.boolean().default(defaultConfig.preferences.smartSuggestions),
    categoryBasedDefaults: z.boolean().default(defaultConfig.preferences.categoryBasedDefaults),
  }),
})

export type ValidatedConfig = z.infer<typeof configSchema>

export class WebFetchConfigManager {
  private config: WebFetchConfig
  private configKey = 'web_fetch_config'

  constructor() {
    this.config = this.loadConfig()
  }

  private loadConfig(): WebFetchConfig {
    try {
      const stored = storageAdapter.getItem(this.configKey)
      if (stored) {
        const parsed = JSON.parse(stored)
        // Validate and merge with defaults
        const validated = configSchema.parse(parsed)
        return {
          ...defaultConfig,
          ...validated,
        }
      }
    } catch (error) {
      console.warn('Failed to load WebFetch config:', error)
    }

    return { ...defaultConfig }
  }

  private saveConfig(): void {
    try {
      storageAdapter.setItem(this.configKey, JSON.stringify(this.config))
    } catch (error) {
      console.warn('Failed to save WebFetch config:', error)
    }
  }

  getConfig(): WebFetchConfig {
    return { ...this.config }
  }

  updateConfig(updates: Partial<WebFetchConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
    }
    this.saveConfig()
  }

  resetToDefaults(): void {
    this.config = { ...defaultConfig }
    this.saveConfig()
  }

  // Helper methods for common operations
  isAutoConfirmEnabled(): boolean {
    return this.config.autoConfirm.enabled
  }

  getAutoConfirmTimeout(): number {
    return this.config.autoConfirm.timeout
  }

  getMaxConfirmationAttempts(): number {
    return this.config.autoConfirm.maxAttempts
  }

  shouldSkipPreflight(): boolean {
    return this.config.behavior.skipPreflight
  }

  shouldAllowAcademic(): boolean {
    return this.config.behavior.allowAcademic
  }

  shouldRememberDecisions(): boolean {
    return this.config.preferences.rememberDecisions
  }

  shouldUseSmartSuggestions(): boolean {
    return this.config.preferences.smartSuggestions
  }

  shouldUseCategoryDefaults(): boolean {
    return this.config.preferences.categoryBasedDefaults
  }

  // Validate configuration
  validateConfig(config: Partial<WebFetchConfig>): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    try {
      const merged = {
        ...this.config,
        ...config,
      }
      configSchema.parse(merged)
    } catch (error) {
      if (error instanceof z.ZodError) {
        errors.push(...error.errors.map(e => e.message))
      } else {
        errors.push('Invalid configuration')
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  // Export configuration
  exportConfig(): string {
    return JSON.stringify(this.config, null, 2)
  }

  // Import configuration
  importConfig(configString: string): { success: boolean; errors: string[] } {
    try {
      const parsed = JSON.parse(configString)
      const validation = this.validateConfig(parsed)

      if (validation.valid) {
        this.config = parsed
        this.saveConfig()
        return { success: true, errors: [] }
      } else {
        return { success: false, errors: validation.errors }
      }
    } catch (error) {
      return {
        success: false,
        errors: [error instanceof Error ? error.message : 'Invalid configuration']
      }
    }
  }
}

// Global instance
export const webFetchConfigManager = new WebFetchConfigManager()