/**
 * ModuleImpactAnalyzer tests (F-104)
 */

import { describe, test, expect } from 'bun:test'
import { ModuleImpactAnalyzer } from '../ModuleImpactAnalyzer.js'
import { ContractRegistry } from '../ContractRegistry.js'
import { GraphEngine } from '../GraphEngine.js'
import { createStoreFromAdjacency } from './testHelpers.js'

function createImpactTestSetup() {
  // Module dependency graph:
  //   src/core.ts uses → src/utils.ts, src/types.ts
  //   src/api.ts uses → src/core.ts
  //   src/main.ts uses → src/api.ts, src/core.ts
  const store = createStoreFromAdjacency({
    'src/core.ts:processData': ['src/utils.ts:helper', 'src/types.ts:Data'],
    'src/core.ts:validate': ['src/types.ts:Data'],
    'src/api.ts:handleRequest': ['src/core.ts:processData', 'src/core.ts:validate'],
    'src/main.ts:main': ['src/api.ts:handleRequest', 'src/core.ts:processData'],
    'src/utils.ts:helper': [],
    'src/types.ts:Data': [],
  })

  // Set file metadata
  const nodes = [
    { id: 'src/core.ts:processData', file: 'src/core.ts', name: 'processData', kind: 'function', is_exported: true },
    { id: 'src/core.ts:validate', file: 'src/core.ts', name: 'validate', kind: 'function', is_exported: true },
    { id: 'src/api.ts:handleRequest', file: 'src/api.ts', name: 'handleRequest', kind: 'function', is_exported: true, signature: '@Get("/api") handleRequest()' },
    { id: 'src/main.ts:main', file: 'src/main.ts', name: 'main', kind: 'function' },
    { id: 'src/utils.ts:helper', file: 'src/utils.ts', name: 'helper', kind: 'function', is_exported: true },
    { id: 'src/types.ts:Data', file: 'src/types.ts', name: 'Data', kind: 'type', is_exported: true },
  ]

  for (const n of nodes) {
    const meta = store.nodeMeta.get(n.id)!
    Object.assign(meta, n)
  }

  const engine = new GraphEngine(store)
  const registry = new ContractRegistry(store)
  registry.extractAll()
  const analyzer = new ModuleImpactAnalyzer(store, engine, registry)

  return { store, engine, registry, analyzer }
}

describe('ModuleImpactAnalyzer', () => {
  describe('analyze', () => {
    test('returns stage1 with direct and indirect impact', () => {
      const { analyzer } = createImpactTestSetup()
      const result = analyzer.analyze('src/utils.ts')

      expect(result.stage1).toBeDefined()
      expect(Array.isArray(result.stage1.directImpact)).toBe(true)
      expect(Array.isArray(result.stage1.indirectImpact)).toBe(true)
      expect(typeof result.stage1.impactDepth).toBe('number')
    })

    test('changing utils.ts directly impacts core.ts', () => {
      const { analyzer } = createImpactTestSetup()
      const result = analyzer.analyze('src/utils.ts')

      // core.ts uses utils.ts helper
      expect(result.stage1.directImpact.some(f => f.includes('core'))).toBe(true)
    })

    test('changing core.ts impacts api.ts and main.ts', () => {
      const { analyzer } = createImpactTestSetup()
      const result = analyzer.analyze('src/core.ts')

      const allImpacted = [...result.stage1.directImpact, ...result.stage1.indirectImpact]
      expect(allImpacted.some(f => f.includes('api'))).toBe(true)
      expect(allImpacted.some(f => f.includes('main'))).toBe(true)
    })

    test('changing main.ts has no impact (leaf)', () => {
      const { analyzer } = createImpactTestSetup()
      const result = analyzer.analyze('src/main.ts')

      // main.ts is a leaf — nothing depends on it
      expect(result.stage1.directImpact.length).toBe(0)
      expect(result.stage1.indirectImpact.length).toBe(0)
    })

    test('stage2 returns affected contracts', () => {
      const { analyzer } = createImpactTestSetup()
      const result = analyzer.analyze('src/utils.ts')

      expect(result.stage2).toBeDefined()
      expect(Array.isArray(result.stage2.affectedApis)).toBe(true)
      expect(Array.isArray(result.stage2.affectedEvents)).toBe(true)
      expect(Array.isArray(result.stage2.affectedExports)).toBe(true)
      expect(['low', 'medium', 'high']).toContain(result.stage2.contractBreakRisk)
    })

    test('contractBreakRisk is "low" for minimal impact', () => {
      const { analyzer } = createImpactTestSetup()
      const result = analyzer.analyze('src/main.ts')

      expect(result.stage2.contractBreakRisk).toBe('low')
    })

    test('handles non-existent module gracefully', () => {
      const { analyzer } = createImpactTestSetup()
      const result = analyzer.analyze('nonexistent.ts')

      expect(result.stage1.directImpact.length).toBe(0)
      expect(result.stage1.indirectImpact.length).toBe(0)
      expect(result.stage1.impactDepth).toBe(0)
      expect(result.stage2.contractBreakRisk).toBe('low')
    })
  })

  describe('matchContracts', () => {
    test('exact match by file path', () => {
      const { analyzer } = createImpactTestSetup()
      const contracts = analyzer.matchContracts('src/core.ts')

      expect(contracts.length).toBe(1)
      expect(contracts[0].module).toBe('src/core.ts')
    })

    test('substring match', () => {
      const { analyzer } = createImpactTestSetup()
      const contracts = analyzer.matchContracts('core')

      expect(contracts.length).toBeGreaterThanOrEqual(1)
      expect(contracts.some(c => c.module.includes('core'))).toBe(true)
    })

    test('wildcard match with *', () => {
      const { analyzer } = createImpactTestSetup()
      const contracts = analyzer.matchContracts('src/*.ts')

      expect(contracts.length).toBeGreaterThan(0)
      for (const c of contracts) {
        expect(c.module).toMatch(/^src\/.*\.ts$/)
      }
    })

    test('returns empty for non-matching pattern', () => {
      const { analyzer } = createImpactTestSetup()
      const contracts = analyzer.matchContracts('nonexistent_pattern_xyz')

      expect(contracts.length).toBe(0)
    })
  })
})
