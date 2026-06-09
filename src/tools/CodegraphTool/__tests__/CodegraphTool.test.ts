/**
 * CodegraphTool Tests — Phase 1a-3: Tool Schema Refactoring
 *
 * TDD tests for:
 * 1. Operation merge (codegraph_impact + codegraph_impact_deep → single codegraph_impact)
 * 2. Operation deletion (codegraph_explore removed)
 * 3. Three-layer descriptions (core / analysis / advanced)
 * 4. ToolSearch deferred registration for advanced operations
 */

import { describe, it, expect, mock } from 'bun:test'
import { codegraphTool, OPERATION_TIERS, DEFERRED_OPERATIONS, getOperationDescription } from '../CodegraphTool.js'

describe('CodegraphTool — Operation Schema', () => {
  describe('operation enum', () => {
    it('should NOT include codegraph_explore (deleted, redundant with codegraph_search)', () => {
      const schema = codegraphTool.inputSchema
      const enumValues = schema.shape.operation.options
      expect(enumValues).not.toContain('codegraph_explore')
    })

    it('should NOT include codegraph_impact_deep (merged into codegraph_impact)', () => {
      const schema = codegraphTool.inputSchema
      const enumValues = schema.shape.operation.options
      expect(enumValues).not.toContain('codegraph_impact_deep')
    })

    it('should include codegraph_impact with optional depth parameter', () => {
      const schema = codegraphTool.inputSchema
      const enumValues = schema.shape.operation.options
      expect(enumValues).toContain('codegraph_impact')
      // depth parameter should exist in the schema
      expect(schema.shape.depth).toBeDefined()
    })

    it('should have exactly 22 operations (20 after merge + codegraph_unresolved + codegraph_kind_map)', () => {
      const schema = codegraphTool.inputSchema
      const enumValues = schema.shape.operation.options
      // Original: 22 ops
      // Removed: codegraph_explore, codegraph_impact_deep
      // Added: codegraph_unresolved, codegraph_kind_map
      // Result: 22 ops
      expect(enumValues.length).toBe(22)
    })
  })

  describe('three-layer description system', () => {
    it('should export OPERATION_TIERS with core/analysis/advanced classification', () => {
      expect(OPERATION_TIERS).toBeDefined()
      expect(OPERATION_TIERS.core).toBeDefined()
      expect(OPERATION_TIERS.analysis).toBeDefined()
      expect(OPERATION_TIERS.advanced).toBeDefined()
    })

    it('should classify 4 core operations: search, status, callers, callees', () => {
      expect(OPERATION_TIERS.core).toContain('codegraph_search')
      expect(OPERATION_TIERS.core).toContain('codegraph_status')
      expect(OPERATION_TIERS.core).toContain('codegraph_callers')
      expect(OPERATION_TIERS.core).toContain('codegraph_callees')
      expect(OPERATION_TIERS.core.length).toBe(4)
    })

    it('should classify 3 analysis operations: impact, trace, context', () => {
      expect(OPERATION_TIERS.analysis).toContain('codegraph_impact')
      expect(OPERATION_TIERS.analysis).toContain('codegraph_trace')
      expect(OPERATION_TIERS.analysis).toContain('codegraph_context')
      expect(OPERATION_TIERS.analysis.length).toBe(3)
    })

    it('should classify remaining 15 operations as advanced (including CPU-intensive graph algorithms)', () => {
      expect(OPERATION_TIERS.advanced.length).toBe(15)
      expect(OPERATION_TIERS.advanced).toContain('codegraph_pagerank')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_community')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_roles')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_centrality')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_scc')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_toposort')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_init')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_files')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_sync')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_delta')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_slice')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_coupling')
      expect(OPERATION_TIERS.advanced).toContain('codegraph_temporal')
    })

    it('should provide tier-specific descriptions via getOperationDescription()', () => {
      // Core: short description
      const sccDesc = getOperationDescription('codegraph_scc', 'core')
      expect(sccDesc.length).toBeLessThan(80)

      // Analysis: medium description
      const communityDesc = getOperationDescription('codegraph_community', 'analysis')
      expect(communityDesc.length).toBeGreaterThan(sccDesc.length)
      expect(communityDesc.length).toBeLessThan(200)

      // Advanced: detailed description
      const sliceDesc = getOperationDescription('codegraph_slice', 'advanced')
      expect(sliceDesc.length).toBeGreaterThan(communityDesc.length)
    })
  })

  describe('ToolSearch deferred registration', () => {
    it('should have shouldDefer=false (tool itself is not deferred)', () => {
      expect(codegraphTool.shouldDefer).toBeFalsy()
    })

    it('should export DEFERRED_OPERATIONS list for ToolSearch integration', () => {
      expect(DEFERRED_OPERATIONS).toBeDefined()
      expect(Array.isArray(DEFERRED_OPERATIONS)).toBe(true)
      expect(DEFERRED_OPERATIONS.length).toBeGreaterThan(0)
    })

    it('should mark all advanced operations as deferred', () => {
      for (const op of OPERATION_TIERS.advanced) {
        expect(DEFERRED_OPERATIONS).toContain(op)
      }
    })

    it('should NOT mark core or analysis operations as deferred', () => {
      for (const op of [...OPERATION_TIERS.core, ...OPERATION_TIERS.analysis]) {
        expect(DEFERRED_OPERATIONS).not.toContain(op)
      }
    })
  })

  describe('backward compatibility', () => {
    it('should keep codegraph_impact with depth=2 working (old behavior)', async () => {
      // codegraph_impact with default depth should use CLI-based analysis
      const result = await codegraphTool.call(
        { operation: 'codegraph_impact', symbol: 'testFunc', depth: 2 },
        {} as any,
        async () => true,
        {} as any,
      )
      // Should not throw
      expect(result).toBeDefined()
    })
  })

  describe('Phase Z4 — new operations', () => {
    it('should include codegraph_unresolved in operation enum', () => {
      const schema = codegraphTool.inputSchema
      const enumValues = schema.shape.operation.options
      expect(enumValues).toContain('codegraph_unresolved')
    })

    it('should have 22 operations after adding codegraph_unresolved + codegraph_kind_map', () => {
      const schema = codegraphTool.inputSchema
      const enumValues = schema.shape.operation.options
      expect(enumValues.length).toBe(22)
    })

    it('should classify codegraph_unresolved as advanced', () => {
      expect(OPERATION_TIERS.advanced).toContain('codegraph_unresolved')
    })

    it('should have description for codegraph_unresolved', () => {
      const desc = getOperationDescription('codegraph_unresolved', 'advanced')
      expect(desc.length).toBeGreaterThan(0)
      expect(desc).toContain('unresolved')
    })
  })
})
