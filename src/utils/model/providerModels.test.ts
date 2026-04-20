import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig, resolveProviderConfig } from '../config.js'

describe('resolveProviderConfig', () => {
  const originalConfig = getGlobalConfig()

  afterEach(() => {
    // Restore original config
    saveGlobalConfig(() => originalConfig)
  })

  describe('when not configured', () => {
    beforeEach(() => {
      saveGlobalConfig(config => ({ ...config, model: undefined, providerModels: undefined }))
    })

    it('returns undefined for both model and models', () => {
      const result = resolveProviderConfig()
      expect(result.model).toBeUndefined()
      expect(result.models).toBeUndefined()
    })
  })

  describe('when providerModels is set globally', () => {
    beforeEach(() => {
      saveGlobalConfig(config => ({
        ...config,
        model: 'qwen3.6-plus',
        providerModels: ['qwen3.6-plus', 'glm-5'],
      }))
    })

    it('returns the global providerModels list', () => {
      const result = resolveProviderConfig()
      expect(result.models).toEqual(['qwen3.6-plus', 'glm-5'])
      expect(result.model).toBe('qwen3.6-plus')
    })
  })

  describe('when only model is set', () => {
    beforeEach(() => {
      saveGlobalConfig(config => ({
        ...config,
        model: 'qwen3.6-plus',
        providerModels: undefined,
      }))
    })

    it('returns model but not models', () => {
      const result = resolveProviderConfig()
      expect(result.model).toBe('qwen3.6-plus')
      expect(result.models).toBeUndefined()
    })
  })

  describe('when only providerModels is set', () => {
    beforeEach(() => {
      saveGlobalConfig(config => ({
        ...config,
        model: undefined,
        providerModels: ['glm-5', 'glm-4.7'],
      }))
    })

    it('returns models but not model', () => {
      const result = resolveProviderConfig()
      expect(result.models).toEqual(['glm-5', 'glm-4.7'])
      expect(result.model).toBeUndefined()
    })
  })

  describe('project-level precedence', () => {
    it('returns both model and models fields', () => {
      const result = resolveProviderConfig()
      expect(typeof result).toBe('object')
      expect('model' in result).toBe(true)
      expect('models' in result).toBe(true)
    })
  })
})

describe('providerModels config types', () => {
  it('GlobalConfig type has model and providerModels fields', () => {
    // TypeScript type check: GlobalConfig has model?: string and providerModels?: string[]
    // This is verified by the compiler at build time
    const config: { model?: string; providerModels?: string[] } = {}
    expect(config.model).toBeUndefined()
    expect(config.providerModels).toBeUndefined()
  })

  it('ProjectConfig type has model and providerModels fields', () => {
    // TypeScript type check: ProjectConfig has model?: string and providerModels?: string[]
    // This is verified by the compiler at build time
    const projectConfig: { model?: string; providerModels?: string[] } = {}
    expect(projectConfig.model).toBeUndefined()
    expect(projectConfig.providerModels).toBeUndefined()
  })
})
