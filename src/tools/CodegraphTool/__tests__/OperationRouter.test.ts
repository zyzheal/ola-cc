/**
 * OperationRouter 单元测试
 *
 * 测试 CLI/Engine/Hybrid 路由逻辑、getAvailable 可用操作列表。
 *
 * Run: bun test src/tools/CodegraphTool/__tests__/OperationRouter.test.ts
 */

import { describe, it, expect } from 'bun:test'
import { OperationRouter, type OperationTarget } from '../OperationRouter.js'

// ============================================================
// route() — CLI operations
// ============================================================

describe('OperationRouter.route', () => {
  describe('CLI operations', () => {
    const cliOps = [
      'codegraph_search',
      'codegraph_context',
      'codegraph_callers',
      'codegraph_callees',
      'codegraph_files',
      'codegraph_status',
      'codegraph_init',
      'codegraph_sync',
    ]

    for (const op of cliOps) {
      it(`${op} → cli when both available`, () => {
        const decision = OperationRouter.route(op, true, true)
        expect(decision.target).toBe('cli')
        expect(decision.reason).toBeTruthy()
      })

      it(`${op} → cli even when engine unavailable`, () => {
        const decision = OperationRouter.route(op, false, true)
        expect(decision.target).toBe('cli')
      })
    }

    it('codegraph_init → cli when CLI not available (auto-init)', () => {
      const decision = OperationRouter.route('codegraph_init', true, false)
      expect(decision.target).toBe('cli')
    })
  })

  // ── Engine operations ──

  describe('Engine operations', () => {
    const engineOps = [
      'codegraph_scc',
      'codegraph_toposort',
      'codegraph_pagerank',
      'codegraph_roles',
      'codegraph_community',
      'codegraph_centrality',
      'codegraph_slice',
      'codegraph_coupling',
      'codegraph_temporal',
    ]

    for (const op of engineOps) {
      it(`${op} → engine when GraphEngine available`, () => {
        const decision = OperationRouter.route(op, true, true)
        expect(decision.target).toBe('engine')
        expect(decision.reason).toContain('algorithm')
      })

      it(`${op} → cli fallback when engine unavailable`, () => {
        const decision = OperationRouter.route(op, false, true)
        expect(decision.target).toBe('cli')
      })
    }
  })

  // ── Hybrid operations ──

  describe('Hybrid operations', () => {
    it('codegraph_delta → hybrid when engine available', () => {
      const decision = OperationRouter.route('codegraph_delta', true, true)
      expect(decision.target).toBe('hybrid')
    })

    it('codegraph_delta → cli fallback when engine unavailable', () => {
      const decision = OperationRouter.route('codegraph_delta', false, true)
      expect(decision.target).toBe('cli')
    })

    it('codegraph_trace → hybrid when both available', () => {
      const decision = OperationRouter.route('codegraph_trace', true, true)
      expect(decision.target).toBe('hybrid')
    })

    it('codegraph_trace → cli when only CLI available', () => {
      const decision = OperationRouter.route('codegraph_trace', false, true)
      expect(decision.target).toBe('cli')
    })

    it('codegraph_trace → engine when only engine available', () => {
      const decision = OperationRouter.route('codegraph_trace', true, false)
      expect(decision.target).toBe('engine')
    })
  })

  // ── codegraph_impact depth-dependent routing ──

  describe('codegraph_impact', () => {
    it('depth=2 → cli', () => {
      const decision = OperationRouter.route('codegraph_impact', true, true, { depth: 2 })
      expect(decision.target).toBe('cli')
    })

    it('depth=1 → cli', () => {
      const decision = OperationRouter.route('codegraph_impact', true, true, { depth: 1 })
      expect(decision.target).toBe('cli')
    })

    it('depth=3 → engine', () => {
      const decision = OperationRouter.route('codegraph_impact', true, true, { depth: 3 })
      expect(decision.target).toBe('engine')
      expect(decision.reason).toContain('Deep impact')
    })

    it('depth=5 → engine', () => {
      const decision = OperationRouter.route('codegraph_impact', true, true, { depth: 5 })
      expect(decision.target).toBe('engine')
    })

    it('default depth (no opts) → cli', () => {
      const decision = OperationRouter.route('codegraph_impact', true, true)
      expect(decision.target).toBe('cli')
    })

    it('depth=3 but no engine → cli fallback', () => {
      const decision = OperationRouter.route('codegraph_impact', false, true, { depth: 3 })
      expect(decision.target).toBe('cli')
    })

    it('no CLI, has engine → engine', () => {
      const decision = OperationRouter.route('codegraph_impact', true, false)
      expect(decision.target).toBe('engine')
    })
  })

  // ── Unknown operations ──

  describe('unknown operations', () => {
    it('defaults to cli for unknown ops', () => {
      const decision = OperationRouter.route('codegraph_unknown', true, true)
      expect(decision.target).toBe('cli')
      expect(decision.reason).toContain('Unknown')
    })
  })
})

// ============================================================
// getAvailable()
// ============================================================

describe('OperationRouter.getAvailable', () => {
  it('returns CLI ops when only codegraph available', () => {
    const available = OperationRouter.getAvailable(true, false, false)
    expect(available).toContain('codegraph_search')
    expect(available).toContain('codegraph_context')
    expect(available).toContain('codegraph_init')
    expect(available).toContain('codegraph_status')
    expect(available).toContain('codegraph_impact')
    expect(available).toContain('codegraph_trace')
    expect(available).not.toContain('codegraph_scc')
  })

  it('returns engine ops when only GraphEngine available', () => {
    const available = OperationRouter.getAvailable(false, true, true)
    expect(available).toContain('codegraph_scc')
    expect(available).toContain('codegraph_pagerank')
    expect(available).toContain('codegraph_community')
    expect(available).toContain('codegraph_delta')
    expect(available).toContain('codegraph_impact')
    expect(available).toContain('codegraph_trace')
    expect(available).not.toContain('codegraph_search')
    expect(available).toContain('codegraph_status') // always available
  })

  it('returns all ops when both available', () => {
    const available = OperationRouter.getAvailable(true, true, true)
    expect(available).toContain('codegraph_search')
    expect(available).toContain('codegraph_scc')
    expect(available).toContain('codegraph_delta')
    expect(available).toContain('codegraph_impact')
    expect(available).toContain('codegraph_trace')
    expect(available.length).toBeGreaterThan(15)
  })

  it('always includes codegraph_status', () => {
    expect(OperationRouter.getAvailable(false, false, false)).toContain('codegraph_status')
    expect(OperationRouter.getAvailable(true, false, false)).toContain('codegraph_status')
  })

  it('returns sorted results', () => {
    const available = OperationRouter.getAvailable(true, true, true)
    const sorted = [...available].sort()
    expect(available).toEqual(sorted)
  })

  it('no duplicates', () => {
    const available = OperationRouter.getAvailable(true, true, true)
    const unique = new Set(available)
    expect(unique.size).toBe(available.length)
  })
})

// ============================================================
// RoutingDecision structure
// ============================================================

describe('RoutingDecision structure', () => {
  it('always has target and reason', () => {
    const decision = OperationRouter.route('codegraph_search', true, true)
    expect(decision).toHaveProperty('target')
    expect(decision).toHaveProperty('reason')
    expect(typeof decision.reason).toBe('string')
    expect(decision.reason.length).toBeGreaterThan(0)
  })

  it('target is one of cli/engine/hybrid', () => {
    const validTargets: OperationTarget[] = ['cli', 'engine', 'hybrid']
    const ops = ['codegraph_search', 'codegraph_scc', 'codegraph_delta', 'codegraph_impact']
    for (const op of ops) {
      const d = OperationRouter.route(op, true, true, { depth: 3 })
      expect(validTargets).toContain(d.target)
    }
  })
})
