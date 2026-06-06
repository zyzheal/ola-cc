/**
 * Resolver.test.ts — Phase 6c-0: Core resolution orchestrator tests
 *
 * Tests for:
 * - ResolutionContext creation from GraphStore
 * - Built-in symbol filtering
 * - Exact match resolution
 * - Qualified name resolution
 * - Fuzzy match resolution
 * - Batch resolution
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { GraphStore, type NodeMetadata, type EdgeType } from '../GraphStore.js'
import { GraphStoreAdapter } from '../CallbackSynthesizerTypes.js'
import {
  ReferenceResolver,
  createResolver,
  type LocalUnresolvedRef,
  type LocalResolvedRef,
  type ResolutionResult,
} from '../resolution/Resolver.js'

// ============================================================
// Test helpers
// ============================================================

function createTestStore(uniqueKey: string): GraphStore {
  const store = GraphStore.getInstance(uniqueKey)
  const anyStore = store as any
  anyStore.loaded = true
  return store
}

function addNode(
  store: GraphStore,
  id: string,
  name: string,
  kind: string,
  file: string,
  line: number,
  opts?: {
    end_line?: number
    language?: string
    qualified_name?: string
    is_exported?: boolean
  },
) {
  store.nodeMeta.set(id, {
    id,
    name,
    kind,
    file,
    line,
    end_line: opts?.end_line ?? line + 10,
    language: opts?.language,
    qualified_name: opts?.qualified_name,
    is_exported: opts?.is_exported,
  })
}

function makeRef(
  fromNodeId: string,
  referenceName: string,
  opts?: {
    referenceKind?: LocalUnresolvedRef['referenceKind']
    line?: number
    column?: number
    filePath?: string
    language?: LocalUnresolvedRef['language']
  },
): LocalUnresolvedRef {
  return {
    fromNodeId,
    referenceName,
    referenceKind: opts?.referenceKind ?? 'calls',
    line: opts?.line ?? 10,
    column: opts?.column ?? 0,
    filePath: opts?.filePath ?? 'src/main.ts',
    language: opts?.language ?? 'typescript',
  }
}

// ============================================================
// Tests
// ============================================================

describe('ReferenceResolver', () => {
  let store: GraphStore
  let adapter: GraphStoreAdapter
  let projectRoot: string

  beforeEach(() => {
    const key = `resolver-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    store = createTestStore(key)
    adapter = new GraphStoreAdapter(store)
    projectRoot = '/tmp/resolver-test-project'
  })

  // ----------------------------------------------------------
  // ResolutionContext creation
  // ----------------------------------------------------------

  describe('ResolutionContext creation', () => {
    it('should create a context that can look up nodes by name', () => {
      addNode(store, 'fn1', 'handleRequest', 'function', 'src/handler.ts', 10, {
        language: 'typescript',
      })
      addNode(store, 'fn2', 'processData', 'function', 'src/data.ts', 20, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ctx = resolver.getContext()

      const results = ctx.getNodesByName('handleRequest')
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('fn1')
    })

    it('should create a context that can look up nodes in a file', () => {
      addNode(store, 'fn1', 'foo', 'function', 'src/a.ts', 10)
      addNode(store, 'fn2', 'bar', 'function', 'src/a.ts', 20)
      addNode(store, 'fn3', 'baz', 'function', 'src/b.ts', 10)

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ctx = resolver.getContext()

      const results = ctx.getNodesInFile('src/a.ts')
      expect(results).toHaveLength(2)
    })

    it('should create a context that can look up nodes by qualified name', () => {
      addNode(store, 'm1', 'save', 'method', 'src/user.ts', 10, {
        qualified_name: 'UserService::save',
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ctx = resolver.getContext()

      const results = ctx.getNodesByQualifiedName('UserService::save')
      expect(results).toHaveLength(1)
      expect(results[0]!.id).toBe('m1')
    })

    it('should return all files from context', () => {
      addNode(store, 'fn1', 'foo', 'function', 'src/a.ts', 10)
      addNode(store, 'fn2', 'bar', 'function', 'src/b.ts', 10)

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ctx = resolver.getContext()

      const files = ctx.getAllFiles()
      expect(files).toContain('src/a.ts')
      expect(files).toContain('src/b.ts')
    })
  })

  // ----------------------------------------------------------
  // Built-in filtering
  // ----------------------------------------------------------

  describe('built-in filtering', () => {
    it('should skip JavaScript built-in references', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const builtins = ['console', 'window', 'document', 'Promise', 'Array', 'setTimeout', 'fetch', 'require']
      for (const name of builtins) {
        const ref = makeRef('caller', name, { language: 'typescript' })
        const result = resolver.resolveOne(ref)
        expect(result).toBeNull()
      }
    })

    it('should skip React hook references', () => {
      addNode(store, 'caller', 'MyComponent', 'component', 'src/MyComponent.tsx', 1, {
        language: 'tsx',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const hooks = ['useState', 'useEffect', 'useContext', 'useCallback', 'useMemo', 'useRef']
      for (const name of hooks) {
        const ref = makeRef('caller', name, { language: 'tsx' })
        const result = resolver.resolveOne(ref)
        expect(result).toBeNull()
      }
    })

    it('should skip Python built-in references', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.py', 1, {
        language: 'python',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const builtins = ['print', 'len', 'range', 'str', 'int', 'list', 'dict', 'set']
      for (const name of builtins) {
        const ref = makeRef('caller', name, { language: 'python' })
        const result = resolver.resolveOne(ref)
        expect(result).toBeNull()
      }
    })

    it('should skip Python built-in method calls on built-in types', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.py', 1, {
        language: 'python',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const methodCalls = ['list.append', 'dict.update', 'set.add', 'str.split']
      for (const name of methodCalls) {
        const ref = makeRef('caller', name, { language: 'python' })
        const result = resolver.resolveOne(ref)
        expect(result).toBeNull()
      }
    })

    it('should skip Go stdlib package references', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.go', 1, {
        language: 'go',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const goRefs = ['fmt.Println', 'http.ListenAndServe', 'os.Open']
      for (const name of goRefs) {
        const ref = makeRef('caller', name, { language: 'go' })
        const result = resolver.resolveOne(ref)
        expect(result).toBeNull()
      }
    })

    it('should skip C/C++ std:: namespace references', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.cpp', 1, {
        language: 'cpp',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const ref = makeRef('caller', 'std::vector', { language: 'cpp' })
      const result = resolver.resolveOne(ref)
      expect(result).toBeNull()
    })

    it('should NOT skip user-defined symbols that collide with C builtins', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.c', 1, {
        language: 'c',
      })
      // User-defined 'malloc' in the codebase
      addNode(store, 'custom_malloc', 'malloc', 'function', 'src/alloc.c', 10, {
        language: 'c',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const ref = makeRef('caller', 'malloc', { language: 'c' })
      const result = resolver.resolveOne(ref)
      // Should resolve because user has a 'malloc' defined
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('custom_malloc')
    })

    it('should not skip console.Math.JSON prefixed calls when they are not built-in', () => {
      // console.log, Math.floor, JSON.parse are filtered
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const ref = makeRef('caller', 'console.log', { language: 'typescript' })
      const result = resolver.resolveOne(ref)
      expect(result).toBeNull()
    })
  })

  // ----------------------------------------------------------
  // Exact match resolution
  // ----------------------------------------------------------

  describe('exact match resolution', () => {
    it('should resolve a single exact name match with high confidence', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'target', 'processOrder', 'function', 'src/orders.ts', 30, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'processOrder', { language: 'typescript' })
      const result = resolver.resolveOne(ref)

      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('target')
      expect(result!.confidence).toBeGreaterThanOrEqual(0.8)
      expect(result!.resolvedBy).toBe('exact-match')
    })

    it('should prefer same-language matches over cross-language', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'ts_target', 'processData', 'function', 'src/data.ts', 10, {
        language: 'typescript',
      })
      addNode(store, 'py_target', 'processData', 'function', 'src/data.py', 10, {
        language: 'python',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'processData', { language: 'typescript' })
      const result = resolver.resolveOne(ref)

      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('ts_target')
    })

    it('should prefer same-file matches', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'same_file', 'helper', 'function', 'src/main.ts', 20, {
        language: 'typescript',
      })
      addNode(store, 'other_file', 'helper', 'function', 'src/other.ts', 10, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'helper', {
        language: 'typescript',
        filePath: 'src/main.ts',
      })
      const result = resolver.resolveOne(ref)

      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('same_file')
    })

    it('should return null for unresolved references with no matches', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'nonExistentFunction', { language: 'typescript' })
      const result = resolver.resolveOne(ref)

      expect(result).toBeNull()
    })
  })

  // ----------------------------------------------------------
  // Qualified name resolution
  // ----------------------------------------------------------

  describe('qualified name resolution', () => {
    it('should resolve by qualified name with high confidence', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'target', 'save', 'method', 'src/user.ts', 30, {
        language: 'typescript',
        qualified_name: 'UserService::save',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'UserService::save', { language: 'typescript' })
      const result = resolver.resolveOne(ref)

      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('target')
      expect(result!.confidence).toBeGreaterThanOrEqual(0.9)
      expect(result!.resolvedBy).toBe('qualified-name')
    })

    it('should resolve dot-notation qualified names', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'target', 'authenticate', 'method', 'src/auth.ts', 30, {
        language: 'typescript',
        qualified_name: 'AuthService.authenticate',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'AuthService.authenticate', { language: 'typescript' })
      const result = resolver.resolveOne(ref)

      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('target')
    })

    it('should fall back to partial qualified name match', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'target', 'save', 'method', 'src/user.ts', 30, {
        language: 'typescript',
        qualified_name: 'com.example.UserService.save',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      // Only the last part matches by name, but qualified name ends with the ref
      const ref = makeRef('caller', 'UserService.save', { language: 'typescript' })
      const result = resolver.resolveOne(ref)

      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('target')
    })
  })

  // ----------------------------------------------------------
  // Fuzzy match resolution
  // ----------------------------------------------------------

  describe('fuzzy match resolution', () => {
    it('should resolve via case-insensitive fuzzy match', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'target', 'ProcessOrder', 'function', 'src/orders.ts', 30, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      // Lowercase 'processorder' should fuzzy match 'ProcessOrder'
      const ref = makeRef('caller', 'processorder', { language: 'typescript' })
      const result = resolver.resolveOne(ref)

      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('target')
      expect(result!.resolvedBy).toBe('fuzzy')
      expect(result!.confidence).toBeLessThan(0.8)
    })

    it('should not fuzzy match when multiple candidates exist', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 't1', 'ProcessOrder', 'function', 'src/a.ts', 10, {
        language: 'typescript',
      })
      addNode(store, 't2', 'ProcessOrder', 'function', 'src/b.ts', 10, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'processorder', { language: 'typescript' })
      const result = resolver.resolveOne(ref)

      // Ambiguous — should not resolve
      expect(result).toBeNull()
    })
  })

  // ----------------------------------------------------------
  // Strategy priority
  // ----------------------------------------------------------

  describe('strategy priority', () => {
    it('should prefer qualified-name over exact-match when both match', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      // Exact match by name
      addNode(store, 'exact', 'save', 'function', 'src/other.ts', 10, {
        language: 'typescript',
      })
      // Qualified name match
      addNode(store, 'qualified', 'save', 'method', 'src/user.ts', 30, {
        language: 'typescript',
        qualified_name: 'UserService::save',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'UserService::save', { language: 'typescript' })
      const result = resolver.resolveOne(ref)

      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('qualified')
      expect(result!.resolvedBy).toBe('qualified-name')
    })
  })

  // ----------------------------------------------------------
  // Batch resolution
  // ----------------------------------------------------------

  describe('batch resolution', () => {
    it('should resolve a batch of references', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 't1', 'foo', 'function', 'src/foo.ts', 10, {
        language: 'typescript',
      })
      addNode(store, 't2', 'bar', 'function', 'src/bar.ts', 20, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const refs = [
        makeRef('caller', 'foo', { language: 'typescript' }),
        makeRef('caller', 'bar', { language: 'typescript' }),
        makeRef('caller', 'nonexistent', { language: 'typescript' }),
      ]

      const result = resolver.resolveBatch(refs)

      expect(result.stats.total).toBe(3)
      expect(result.stats.resolved).toBe(2)
      expect(result.stats.unresolved).toBe(1)
      expect(result.resolved).toHaveLength(2)
      expect(result.unresolved).toHaveLength(1)
    })

    it('should track resolution methods in stats', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 't1', 'foo', 'function', 'src/foo.ts', 10, {
        language: 'typescript',
      })
      addNode(store, 't2', 'save', 'method', 'src/user.ts', 30, {
        language: 'typescript',
        qualified_name: 'UserService::save',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const refs = [
        makeRef('caller', 'foo', { language: 'typescript' }),
        makeRef('caller', 'UserService::save', { language: 'typescript' }),
      ]

      const result = resolver.resolveBatch(refs)

      expect(result.stats.byMethod['exact-match']).toBe(1)
      expect(result.stats.byMethod['qualified-name']).toBe(1)
    })

    it('should handle empty batch', () => {
      const resolver = new ReferenceResolver(projectRoot, adapter)
      const result = resolver.resolveBatch([])

      expect(result.stats.total).toBe(0)
      expect(result.resolved).toHaveLength(0)
      expect(result.unresolved).toHaveLength(0)
    })

    it('should call progress callback', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 't1', 'foo', 'function', 'src/foo.ts', 10, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const progressCalls: Array<[number, number]> = []

      resolver.resolveBatch(
        [makeRef('caller', 'foo', { language: 'typescript' })],
        (current, total) => progressCalls.push([current, total]),
      )

      expect(progressCalls.length).toBeGreaterThan(0)
      // Last call should be (total, total)
      const last = progressCalls[progressCalls.length - 1]!
      expect(last[0]).toBe(last[1])
    })
  })

  // ----------------------------------------------------------
  // createResolver factory
  // ----------------------------------------------------------

  describe('createResolver', () => {
    it('should create a resolver via factory function', () => {
      addNode(store, 'fn1', 'test', 'function', 'src/test.ts', 1)

      const resolver = createResolver(projectRoot, adapter)
      expect(resolver).toBeInstanceOf(ReferenceResolver)
    })
  })

  // ----------------------------------------------------------
  // Cache management
  // ----------------------------------------------------------

  describe('cache management', () => {
    it('should clear caches without error', () => {
      addNode(store, 'fn1', 'test', 'function', 'src/test.ts', 1)

      const resolver = new ReferenceResolver(projectRoot, adapter)
      // Should not throw
      resolver.clearCaches()
    })

    it('should return consistent results after cache clear', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'target', 'foo', 'function', 'src/foo.ts', 10, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'foo', { language: 'typescript' })

      const result1 = resolver.resolveOne(ref)
      resolver.clearCaches()
      const result2 = resolver.resolveOne(ref)

      expect(result1).not.toBeNull()
      expect(result2).not.toBeNull()
      expect(result1!.targetNodeId).toBe(result2!.targetNodeId)
    })
  })

  // ----------------------------------------------------------
  // Edge creation from resolved refs
  // ----------------------------------------------------------

  describe('createEdges', () => {
    it('should create edges from resolved references', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'target', 'foo', 'function', 'src/foo.ts', 10, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const resolved: LocalResolvedRef[] = [
        {
          original: makeRef('caller', 'foo', {
            referenceKind: 'calls',
            line: 15,
            column: 5,
            language: 'typescript',
          }),
          targetNodeId: 'target',
          confidence: 0.9,
          resolvedBy: 'exact-match',
        },
      ]

      const edges = resolver.createEdges(resolved)

      expect(edges).toHaveLength(1)
      expect(edges[0]!.source).toBe('caller')
      expect(edges[0]!.target).toBe('target')
      expect(edges[0]!.kind).toBe('calls')
      expect(edges[0]!.line).toBe(15)
      expect(edges[0]!.metadata?.confidence).toBe(0.9)
      expect(edges[0]!.metadata?.resolvedBy).toBe('exact-match')
    })

    it('should promote calls to instantiates when target is a class', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'target', 'UserService', 'class', 'src/user.ts', 10, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const resolved: LocalResolvedRef[] = [
        {
          original: makeRef('caller', 'UserService', {
            referenceKind: 'calls',
            language: 'typescript',
          }),
          targetNodeId: 'target',
          confidence: 0.9,
          resolvedBy: 'exact-match',
        },
      ]

      const edges = resolver.createEdges(resolved)
      expect(edges[0]!.kind).toBe('instantiates')
    })

    it('should promote extends to implements when target is an interface', () => {
      addNode(store, 'caller', 'MyService', 'class', 'src/service.ts', 1, {
        language: 'typescript',
      })
      addNode(store, 'target', 'IService', 'interface', 'src/iface.ts', 10, {
        language: 'typescript',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const resolved: LocalResolvedRef[] = [
        {
          original: makeRef('caller', 'IService', {
            referenceKind: 'extends',
            language: 'typescript',
          }),
          targetNodeId: 'target',
          confidence: 0.9,
          resolvedBy: 'exact-match',
        },
      ]

      const edges = resolver.createEdges(resolved)
      expect(edges[0]!.kind).toBe('implements')
    })
  })

  // ----------------------------------------------------------
  // Language-specific edge cases
  // ----------------------------------------------------------

  describe('language-specific edge cases', () => {
    it('should not filter user-defined Python methods that collide with builtins', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.py', 1, {
        language: 'python',
      })
      // User-defined 'index' function in codebase
      addNode(store, 'target', 'index', 'function', 'src/views.py', 10, {
        language: 'python',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)
      const ref = makeRef('caller', 'index', { language: 'python' })
      const result = resolver.resolveOne(ref)

      // Should resolve because user has 'index' defined
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('target')
    })

    it('should handle Pascal built-in filtering', () => {
      addNode(store, 'caller', 'main', 'function', 'src/main.pas', 1, {
        language: 'pascal',
      })

      const resolver = new ReferenceResolver(projectRoot, adapter)

      const ref = makeRef('caller', 'WriteLn', { language: 'pascal' })
      const result = resolver.resolveOne(ref)
      expect(result).toBeNull()
    })
  })
})
