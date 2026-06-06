/**
 * VueSvelteResolver.test.ts — Phase 6c-1: Vue + Svelte framework resolver tests
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { vueResolver } from '../resolution/frameworks/vue.js'
import { svelteResolver } from '../resolution/frameworks/svelte.js'
import {
  registerFrameworkResolver,
  resetFrameworkResolvers,
  getAllFrameworkResolvers,
} from '../resolution/frameworks/index.js'
import type { ResolutionContext, UnresolvedRef, FrameworkExtractionResult } from '../resolution/types.js'
import type { NodeMetadata } from '../GraphStore.js'

// ============================================================
// Test helpers
// ============================================================

function makeContext(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    ...overrides,
  }
}

function makeRef(overrides: Partial<UnresolvedRef> = {}): UnresolvedRef {
  return {
    fromNodeId: 'node-1',
    referenceName: 'Foo',
    referenceKind: 'calls',
    line: 10,
    column: 0,
    filePath: 'src/App.vue',
    language: 'vue',
    ...overrides,
  }
}

// ============================================================
// Vue Resolver
// ============================================================

describe('Vue Resolver', () => {
  describe('detect', () => {
    it('detects vue in package.json dependencies', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ dependencies: { vue: '^3.0.0' } })
          }
          return null
        },
      })
      expect(vueResolver.detect(ctx)).toBe(true)
    })

    it('detects nuxt in devDependencies', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ devDependencies: { nuxt: '^3.0.0' } })
          }
          return null
        },
      })
      expect(vueResolver.detect(ctx)).toBe(true)
    })

    it('detects .vue files in project', () => {
      const ctx = makeContext({
        getAllFiles: () => ['src/App.vue', 'src/main.ts'],
      })
      expect(vueResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no vue indicators', () => {
      const ctx = makeContext({
        readFile: () => JSON.stringify({ dependencies: { react: '^18.0.0' } }),
        getAllFiles: () => ['src/App.tsx'],
      })
      expect(vueResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves Vue compiler macros (defineProps)', () => {
      const ref = makeRef({ referenceName: 'defineProps' })
      const result = vueResolver.resolve(ref, makeContext())
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('node-1')
      expect(result!.confidence).toBe(1.0)
      expect(result!.resolvedBy).toBe('framework')
    })

    it('resolves Nuxt auto-imports (useRoute)', () => {
      const ref = makeRef({ referenceName: 'useRoute' })
      const result = vueResolver.resolve(ref, makeContext())
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(1.0)
    })

    it('resolves @ alias imports', () => {
      const ctx = makeContext({
        fileExists: (path) => path === 'src/components/Foo.ts',
        getNodesInFile: (path) => {
          if (path === 'src/components/Foo.ts') {
            return [{ id: 'comp-1', name: 'Foo', kind: 'component', file: 'src/components/Foo.ts', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: '@/components/Foo', referenceKind: 'imports' })
      const result = vueResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('comp-1')
    })

    it('resolves PascalCase component references to .vue files', () => {
      const ctx = makeContext({
        getAllFiles: () => ['src/components/MyButton.vue'],
        getNodesInFile: () => [
          { id: 'btn-1', name: 'MyButton', kind: 'component', file: 'src/components/MyButton.vue', line: 1 },
        ],
      })
      const ref = makeRef({ referenceName: 'MyButton', referenceKind: 'calls' })
      const result = vueResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('btn-1')
      expect(result!.confidence).toBe(0.8)
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing', referenceKind: 'calls' })
      const result = vueResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('claimsReference', () => {
    it('claims Vue-specific names', () => {
      expect(vueResolver.claimsReference!('ref')).toBe(true)
      expect(vueResolver.claimsReference!('computed')).toBe(true)
      expect(vueResolver.claimsReference!('watch')).toBe(true)
      expect(vueResolver.claimsReference!('reactive')).toBe(true)
      expect(vueResolver.claimsReference!('onMounted')).toBe(true)
      expect(vueResolver.claimsReference!('defineProps')).toBe(true)
    })

    it('does not claim non-Vue names', () => {
      expect(vueResolver.claimsReference!('createStore')).toBe(false)
      expect(vueResolver.claimsReference!('useSelector')).toBe(false)
    })
  })

  describe('extract', () => {
    it('extracts Nuxt page routes', () => {
      const result = vueResolver.extract!('src/pages/about.vue', '<template></template>')
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.kind).toBe('route')
      expect(result.nodes[0]!.name).toBe('/about')
    })

    it('extracts Nuxt API routes', () => {
      const result = vueResolver.extract!('src/server/api/users.ts', 'export default {}')
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.kind).toBe('route')
      expect(result.nodes[0]!.name).toBe('/api/users')
    })

    it('returns empty for non-route files', () => {
      const result = vueResolver.extract!('src/utils/helper.ts', 'export const x = 1')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// Svelte Resolver
// ============================================================

describe('Svelte Resolver', () => {
  describe('detect', () => {
    it('detects svelte in package.json', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ devDependencies: { svelte: '^4.0.0' } })
          }
          return null
        },
      })
      expect(svelteResolver.detect(ctx)).toBe(true)
    })

    it('detects @sveltejs/kit in dependencies', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ dependencies: { '@sveltejs/kit': '^2.0.0' } })
          }
          return null
        },
      })
      expect(svelteResolver.detect(ctx)).toBe(true)
    })

    it('detects .svelte files', () => {
      const ctx = makeContext({
        getAllFiles: () => ['src/lib/Counter.svelte'],
      })
      expect(svelteResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no svelte indicators', () => {
      const ctx = makeContext({
        readFile: () => JSON.stringify({ dependencies: { react: '^18.0.0' } }),
        getAllFiles: () => ['src/App.tsx'],
      })
      expect(svelteResolver.detect(ctx)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves Svelte runes ($state)', () => {
      const ref = makeRef({ referenceName: '$state', filePath: 'src/lib/Counter.svelte', language: 'svelte' })
      const result = svelteResolver.resolve(ref, makeContext())
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(1.0)
      expect(result!.resolvedBy).toBe('framework')
    })

    it('resolves store auto-subscriptions', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'count') {
            return [{ id: 'store-1', name: 'count', kind: 'variable', file: 'src/lib/stores.ts', line: 5 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: '$count', filePath: 'src/App.svelte', language: 'svelte' })
      const result = svelteResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('store-1')
      expect(result!.confidence).toBe(0.85)
    })

    it('resolves $lib/ imports', () => {
      const ctx = makeContext({
        fileExists: (path) => path === 'src/lib/utils.ts',
        getNodesInFile: () => [
          { id: 'util-1', name: 'utils', kind: 'module', file: 'src/lib/utils.ts', line: 1 },
        ],
      })
      const ref = makeRef({ referenceName: '$lib/utils', referenceKind: 'imports', language: 'svelte' })
      const result = svelteResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('util-1')
    })

    it('resolves SvelteKit framework modules ($app/navigation)', () => {
      const ref = makeRef({ referenceName: '$app/navigation', referenceKind: 'imports', language: 'svelte' })
      const result = svelteResolver.resolve(ref, makeContext())
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(1.0)
    })

    it('resolves PascalCase component references to .svelte files', () => {
      const ctx = makeContext({
        getNodesByName: (name) => {
          if (name === 'MyWidget') {
            return [{ id: 'widget-1', name: 'MyWidget', kind: 'component', file: 'src/lib/MyWidget.svelte', line: 1 }]
          }
          return []
        },
      })
      const ref = makeRef({ referenceName: 'MyWidget', referenceKind: 'calls', language: 'svelte' })
      const result = svelteResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('widget-1')
      expect(result!.confidence).toBe(0.8)
    })

    it('returns null for unresolvable references', () => {
      const ref = makeRef({ referenceName: 'unknownThing', language: 'svelte' })
      const result = svelteResolver.resolve(ref, makeContext())
      expect(result).toBeNull()
    })
  })

  describe('claimsReference', () => {
    it('claims Svelte-specific names', () => {
      expect(svelteResolver.claimsReference!('writable')).toBe(true)
      expect(svelteResolver.claimsReference!('readable')).toBe(true)
      expect(svelteResolver.claimsReference!('derived')).toBe(true)
      expect(svelteResolver.claimsReference!('$state')).toBe(true)
      expect(svelteResolver.claimsReference!('$effect')).toBe(true)
    })

    it('does not claim non-Svelte names', () => {
      expect(svelteResolver.claimsReference!('ref')).toBe(false)
      expect(svelteResolver.claimsReference!('computed')).toBe(false)
    })
  })

  describe('extract', () => {
    it('extracts SvelteKit page routes', () => {
      const result = svelteResolver.extract!('src/routes/blog/[slug]/+page.svelte', '<h1>Hello</h1>')
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.kind).toBe('route')
      expect(result.nodes[0]!.name).toBe('/blog/:slug')
    })

    it('extracts SvelteKit API routes', () => {
      const result = svelteResolver.extract!('src/routes/api/users/+server.ts', 'export function GET() {}')
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.kind).toBe('route')
    })

    it('returns empty for non-route files', () => {
      const result = svelteResolver.extract!('src/lib/utils.ts', 'export const x = 1')
      expect(result.nodes.length).toBe(0)
    })
  })
})

// ============================================================
// Registration
// ============================================================

describe('Framework Registration', () => {
  beforeEach(() => {
    resetFrameworkResolvers()
  })

  it('registers vue and svelte resolvers', () => {
    registerFrameworkResolver(vueResolver)
    registerFrameworkResolver(svelteResolver)
    const all = getAllFrameworkResolvers()
    expect(all.length).toBe(2)
    expect(all.find((r) => r.name === 'vue')).toBeDefined()
    expect(all.find((r) => r.name === 'svelte')).toBeDefined()
  })

  it('replaces existing resolver with same name', () => {
    registerFrameworkResolver(vueResolver)
    const updated = { ...vueResolver, name: 'vue' }
    registerFrameworkResolver(updated)
    expect(getAllFrameworkResolvers().length).toBe(1)
  })
})
