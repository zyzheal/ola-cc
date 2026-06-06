/**
 * Resolution module tests
 *
 * Tests for the 7 migrated helper modules:
 * - name-matcher: matchByFilePath, matchByQualifiedName, matchByExactName
 * - strip-comments: all 10 language handlers
 * - path-aliases: tsconfig paths parsing
 * - workspace-packages: monorepo package discovery
 * - frameworks/index: framework registration and detection
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// name-matcher
import {
  matchByFilePath,
  matchByQualifiedName,
  matchByExactName,
  matchMethodCall,
  matchFuzzy,
  matchReference,
} from '../resolution/name-matcher.js'

// strip-comments
import { stripCommentsForRegex, type CommentLang } from '../resolution/strip-comments.js'

// path-aliases
import { loadProjectAliases, applyAliases } from '../resolution/path-aliases.js'

// workspace-packages
import { loadWorkspacePackages, resolveWorkspaceImport } from '../resolution/workspace-packages.js'

// swift-objc-bridge
import {
  objcSelectorForSwiftMethod,
  objcSelectorForSwiftInit,
  objcAccessorsForSwiftProperty,
  swiftBaseNamesForObjcSelector,
  detectExplicitObjcName,
  isObjcExposed,
} from '../resolution/swift-objc-bridge.js'

// frameworks
import {
  getAllFrameworkResolvers,
  getFrameworkResolver,
  detectFrameworks,
  getApplicableFrameworks,
  registerFrameworkResolver,
  resetFrameworkResolvers,
} from '../resolution/frameworks/index.js'

// types
import type {
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
  FrameworkResolver,
} from '../resolution/types.js'
import type { NodeMetadata } from '../GraphStore.js'

// ============================================================
// Helpers
// ============================================================

function makeNode(overrides: Partial<NodeMetadata> = {}): NodeMetadata {
  return {
    id: 'n1',
    name: 'testFunc',
    kind: 'function',
    file: 'src/test.ts',
    line: 10,
    language: 'typescript',
    ...overrides,
  }
}

function makeRef(overrides: Partial<UnresolvedRef> = {}): UnresolvedRef {
  return {
    fromNodeId: 'n0',
    referenceName: 'testFunc',
    referenceKind: 'calls',
    line: 5,
    column: 0,
    filePath: 'src/main.ts',
    language: 'typescript',
    ...overrides,
  }
}

function makeContext(nodes: NodeMetadata[]): ResolutionContext {
  const byName = new Map<string, NodeMetadata[]>()
  const byQName = new Map<string, NodeMetadata[]>()
  const byLowerName = new Map<string, NodeMetadata[]>()

  for (const n of nodes) {
    const existing = byName.get(n.name) ?? []
    existing.push(n)
    byName.set(n.name, existing)

    if (n.qualified_name) {
      const qExisting = byQName.get(n.qualified_name) ?? []
      qExisting.push(n)
      byQName.set(n.qualified_name, qExisting)
    }

    const lower = n.name.toLowerCase()
    const lExisting = byLowerName.get(lower) ?? []
    lExisting.push(n)
    byLowerName.set(lower, lExisting)
  }

  return {
    getNodesInFile: (filePath: string) => nodes.filter(n => n.file === filePath),
    getNodesByName: (name: string) => byName.get(name) ?? [],
    getNodesByQualifiedName: (qn: string) => byQName.get(qn) ?? [],
    getNodesByKind: (kind: string) => nodes.filter(n => n.kind === kind),
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [...new Set(nodes.map(n => n.file))],
    getNodesByLowerName: (lower: string) => byLowerName.get(lower) ?? [],
    getImportMappings: () => [],
  }
}

// ============================================================
// name-matcher tests
// ============================================================

describe('name-matcher', () => {
  describe('matchByFilePath', () => {
    it('should return null for non-path references', () => {
      const ref = makeRef({ referenceName: 'foo' })
      const ctx = makeContext([])
      expect(matchByFilePath(ref, ctx)).toBeNull()
    })

    it('should match by exact file path on qualified_name', () => {
      const node = makeNode({
        id: 'file1',
        name: 'drawer-menu.liquid',
        kind: 'file',
        qualified_name: 'snippets/drawer-menu.liquid',
      })
      const ref = makeRef({ referenceName: 'snippets/drawer-menu.liquid' })
      const ctx = makeContext([node])

      const result = matchByFilePath(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('file1')
      expect(result!.confidence).toBe(0.95)
      expect(result!.resolvedBy).toBe('file-path')
    })

    it('should match by suffix path', () => {
      const node = makeNode({
        id: 'file2',
        name: 'foo.liquid',
        kind: 'file',
        file: 'src/snippets/foo.liquid',
        qualified_name: 'src/snippets/foo.liquid',
      })
      const ref = makeRef({ referenceName: 'snippets/foo.liquid' })
      const ctx = makeContext([node])

      const result = matchByFilePath(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.85)
    })

    it('should use lower confidence for single file node match', () => {
      const node = makeNode({
        id: 'file3',
        name: 'bar.liquid',
        kind: 'file',
        file: 'other/bar.liquid',
      })
      const ref = makeRef({ referenceName: 'any/bar.liquid' })
      const ctx = makeContext([node])

      const result = matchByFilePath(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.7)
    })
  })

  describe('matchByQualifiedName', () => {
    it('should return null for non-qualified references', () => {
      const ref = makeRef({ referenceName: 'simpleName' })
      const ctx = makeContext([])
      expect(matchByQualifiedName(ref, ctx)).toBeNull()
    })

    it('should match by exact qualified name', () => {
      const node = makeNode({
        id: 'n1',
        qualified_name: 'Foo::Bar::baz',
      })
      const ref = makeRef({ referenceName: 'Foo::Bar::baz' })
      const ctx = makeContext([node])

      const result = matchByQualifiedName(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.95)
      expect(result!.resolvedBy).toBe('qualified-name')
    })

    it('should match by partial qualified name', () => {
      const node = makeNode({
        id: 'n2',
        name: 'baz',
        qualified_name: 'Foo::Bar::baz',
      })
      const ref = makeRef({ referenceName: 'Bar::baz' })
      const ctx = makeContext([node])

      const result = matchByQualifiedName(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.85)
    })
  })

  describe('matchByExactName', () => {
    it('should return null when no candidates', () => {
      const ref = makeRef({ referenceName: 'nonexistent' })
      const ctx = makeContext([])
      expect(matchByExactName(ref, ctx)).toBeNull()
    })

    it('should match single candidate at 0.9 confidence', () => {
      const node = makeNode({ id: 'n1', name: 'myFunc', language: 'typescript' })
      const ref = makeRef({ referenceName: 'myFunc', language: 'typescript' })
      const ctx = makeContext([node])

      const result = matchByExactName(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.9)
      expect(result!.resolvedBy).toBe('exact-match')
    })

    it('should penalize cross-language matches at 0.5 confidence', () => {
      const node = makeNode({ id: 'n1', name: 'myFunc', language: 'python' })
      const ref = makeRef({ referenceName: 'myFunc', language: 'typescript' })
      const ctx = makeContext([node])

      const result = matchByExactName(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.5)
    })
  })

  describe('matchMethodCall', () => {
    it('should resolve dot-style method calls', () => {
      const cls = makeNode({
        id: 'cls1',
        name: 'Foo',
        kind: 'class',
        file: 'src/foo.ts',
        language: 'typescript',
      })
      const method = makeNode({
        id: 'm1',
        name: 'bar',
        kind: 'method',
        file: 'src/foo.ts',
        language: 'typescript',
        qualified_name: 'Foo::bar',
      })
      const ref = makeRef({
        referenceName: 'Foo.bar',
        language: 'typescript',
      })
      const ctx = makeContext([cls, method])

      const result = matchMethodCall(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('m1')
      expect(result!.confidence).toBe(0.85)
    })

    it('should return null for non-method patterns', () => {
      const ref = makeRef({ referenceName: 'simpleName' })
      const ctx = makeContext([])
      expect(matchMethodCall(ref, ctx)).toBeNull()
    })
  })

  describe('matchFuzzy', () => {
    it('should match case-insensitive single candidate', () => {
      const node = makeNode({
        id: 'n1',
        name: 'MyFunc',
        kind: 'function',
        language: 'typescript',
      })
      const ref = makeRef({ referenceName: 'myfunc', language: 'typescript' })
      const ctx = makeContext([node])

      const result = matchFuzzy(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.5)
      expect(result!.resolvedBy).toBe('fuzzy')
    })
  })

  describe('matchReference (integration)', () => {
    it('should try strategies in order and return first match', () => {
      const node = makeNode({
        id: 'n1',
        name: 'foo',
        kind: 'function',
        language: 'typescript',
      })
      const ref = makeRef({ referenceName: 'foo', language: 'typescript' })
      const ctx = makeContext([node])

      const result = matchReference(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.resolvedBy).toBe('exact-match')
    })

    it('should return null when nothing matches', () => {
      const ref = makeRef({ referenceName: 'nonexistent' })
      const ctx = makeContext([])
      expect(matchReference(ref, ctx)).toBeNull()
    })
  })
})

// ============================================================
// strip-comments tests
// ============================================================

describe('strip-comments', () => {
  const languages: CommentLang[] = [
    'python', 'javascript', 'typescript', 'php', 'ruby',
    'java', 'csharp', 'swift', 'go', 'rust',
  ]

  it.each(languages)('should strip line comments for %s', (lang) => {
    // All languages support // or # line comments
    let input: string
    if (lang === 'python' || lang === 'ruby') {
      input = 'code # comment\nmore'
    } else {
      input = 'code // comment\nmore'
    }
    const result = stripCommentsForRegex(input, lang)
    expect(result).toContain('code')
    expect(result).toContain('more')
    // Comment text should be blanked to spaces
    expect(result).not.toContain('comment')
  })

  it.each(languages.filter(l => l !== 'python' && l !== 'ruby'))(
    'should strip block comments for %s',
    (lang) => {
      const input = 'before /* block\ncomment */ after'
      const result = stripCommentsForRegex(input, lang)
      expect(result).toContain('before')
      expect(result).toContain('after')
      expect(result).not.toContain('block')
    }
  )

  it('should strip Python triple-quoted strings', () => {
    const input = 'x = 1\n"""docstring\nexample path(\'/fake/\')"""\ny = 2'
    const result = stripCommentsForRegex(input, 'python')
    expect(result).toContain('x = 1')
    expect(result).toContain('y = 2')
    expect(result).not.toContain('docstring')
  })

  it('should strip Ruby =begin/=end block comments', () => {
    const input = 'code\n=begin\nblock comment\n=end\nmore'
    const result = stripCommentsForRegex(input, 'ruby')
    expect(result).toContain('code')
    expect(result).toContain('more')
    expect(result).not.toContain('block comment')
  })

  it('should handle Rust nested block comments', () => {
    const input = 'code /* outer /* inner */ still_outer */ end'
    const result = stripCommentsForRegex(input, 'rust')
    expect(result).toContain('code')
    expect(result).toContain('end')
    expect(result).not.toContain('outer')
    expect(result).not.toContain('inner')
  })

  it('should preserve line numbers (newlines stay)', () => {
    const input = 'line1\n// comment\nline3'
    const result = stripCommentsForRegex(input, 'typescript')
    const lines = result.split('\n')
    expect(lines.length).toBe(3)
    expect(lines[0]).toContain('line1')
    expect(lines[2]).toContain('line3')
  })

  it('should handle Go raw string literals without crashing', () => {
    // Go raw strings (backtick) are skipped but NOT blanked in the original design
    // because they don't contain comment-like patterns that need neutralizing
    const input = 'code `raw string` end'
    const result = stripCommentsForRegex(input, 'go')
    expect(result).toContain('code')
    expect(result).toContain('end')
    // Backtick string content is preserved (skipped, not blanked)
    expect(result).toContain('raw string')
  })

  it('should strip PHP # line comments', () => {
    const input = 'code # php comment\nmore'
    const result = stripCommentsForRegex(input, 'php')
    expect(result).toContain('code')
    expect(result).toContain('more')
    expect(result).not.toContain('php comment')
  })

  it('should strip C# block and line comments', () => {
    const input = 'code // line\n/* block */ end'
    const result = stripCommentsForRegex(input, 'csharp')
    expect(result).toContain('code')
    expect(result).toContain('end')
    expect(result).not.toContain('line')
    expect(result).not.toContain('block')
  })

  it('should strip Swift comments', () => {
    const input = 'let x = 1 // swift comment\nlet y = 2'
    const result = stripCommentsForRegex(input, 'swift')
    expect(result).toContain('let x = 1')
    expect(result).toContain('let y = 2')
    expect(result).not.toContain('swift comment')
  })
})

// ============================================================
// path-aliases tests
// ============================================================

describe('path-aliases', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-aliases-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should return null when no tsconfig exists', () => {
    expect(loadProjectAliases(tmpDir)).toBeNull()
  })

  it('should parse tsconfig.json paths', () => {
    const tsconfig = {
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@/*': ['src/*'],
          '@components/*': ['src/components/*'],
        },
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(tsconfig))

    const aliases = loadProjectAliases(tmpDir)
    expect(aliases).not.toBeNull()
    expect(aliases!.patterns.length).toBe(2)
    // Longer prefix first
    expect(aliases!.patterns[0]!.prefix).toBe('@components/')
    expect(aliases!.patterns[1]!.prefix).toBe('@/')
  })

  it('should parse jsconfig.json as fallback', () => {
    const jsconfig = {
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '~/*': ['src/*'],
        },
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'jsconfig.json'), JSON.stringify(jsconfig))

    const aliases = loadProjectAliases(tmpDir)
    expect(aliases).not.toBeNull()
    expect(aliases!.patterns.length).toBe(1)
    expect(aliases!.patterns[0]!.prefix).toBe('~/')
  })

  it('should handle JSONC with comments', () => {
    const tsconfig = `{
  // This is a comment
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"] /* inline comment */
    }
  },
}`
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), tsconfig)

    const aliases = loadProjectAliases(tmpDir)
    expect(aliases).not.toBeNull()
    expect(aliases!.patterns.length).toBe(1)
  })

  it('should apply aliases correctly', () => {
    const tsconfig = {
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@/*': ['src/*'],
        },
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(tsconfig))

    const aliases = loadProjectAliases(tmpDir)!
    const results = applyAliases('@/components/Foo', aliases, tmpDir)
    expect(results.length).toBe(1)
    expect(results[0]).toBe('src/components/Foo')
  })

  it('should return empty when no alias matches', () => {
    const tsconfig = {
      compilerOptions: {
        baseUrl: '.',
        paths: {
          '@/*': ['src/*'],
        },
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(tsconfig))

    const aliases = loadProjectAliases(tmpDir)!
    const results = applyAliases('lodash', aliases, tmpDir)
    expect(results.length).toBe(0)
  })

  it('should return null when paths is missing', () => {
    const tsconfig = {
      compilerOptions: {
        baseUrl: '.',
      },
    }
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(tsconfig))

    expect(loadProjectAliases(tmpDir)).toBeNull()
  })
})

// ============================================================
// workspace-packages tests
// ============================================================

describe('workspace-packages', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('should return null when no package.json exists', () => {
    expect(loadWorkspacePackages(tmpDir)).toBeNull()
  })

  it('should return null when no workspaces field', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'root' }))
    expect(loadWorkspacePackages(tmpDir)).toBeNull()
  })

  it('should discover workspace packages from package.json', () => {
    // Create package.json with workspaces
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] })
    )

    // Create two workspace members
    fs.mkdirSync(path.join(tmpDir, 'packages', 'ui'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'packages', 'ui', 'package.json'),
      JSON.stringify({ name: '@scope/ui' })
    )
    fs.mkdirSync(path.join(tmpDir, 'packages', 'core'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@scope/core' })
    )

    const ws = loadWorkspacePackages(tmpDir)
    expect(ws).not.toBeNull()
    expect(ws!.byName.size).toBe(2)
    expect(ws!.byName.get('@scope/ui')).toBe('packages/ui')
    expect(ws!.byName.get('@scope/core')).toBe('packages/core')
  })

  it('should handle Yarn object-style workspaces', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['apps/*'] } })
    )
    fs.mkdirSync(path.join(tmpDir, 'apps', 'web'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: 'web' })
    )

    const ws = loadWorkspacePackages(tmpDir)
    expect(ws).not.toBeNull()
    expect(ws!.byName.get('web')).toBe('apps/web')
  })

  it('should discover packages from pnpm-workspace.yaml', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'root' }))
    fs.writeFileSync(
      path.join(tmpDir, 'pnpm-workspace.yaml'),
      'packages:\n  - "libs/*"\n'
    )
    fs.mkdirSync(path.join(tmpDir, 'libs', 'utils'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'libs', 'utils', 'package.json'),
      JSON.stringify({ name: 'utils' })
    )

    const ws = loadWorkspacePackages(tmpDir)
    expect(ws).not.toBeNull()
    expect(ws!.byName.get('utils')).toBe('libs/utils')
  })

  it('should resolve workspace imports', () => {
    const ws = {
      byName: new Map([
        ['@scope/ui', 'packages/ui'],
        ['@scope/core', 'packages/core'],
      ]),
    }

    expect(resolveWorkspaceImport('@scope/ui/widgets', ws)).toBe('packages/ui/widgets')
    expect(resolveWorkspaceImport('@scope/ui', ws)).toBe('packages/ui')
    expect(resolveWorkspaceImport('lodash', ws)).toBeNull()
  })

  it('should prefer longest matching package name', () => {
    const ws = {
      byName: new Map([
        ['@scope/ui', 'packages/ui'],
        ['@scope/ui/core', 'packages/ui-core'],
      ]),
    }

    expect(resolveWorkspaceImport('@scope/ui/core/foo', ws)).toBe('packages/ui-core/foo')
  })
})

// ============================================================
// swift-objc-bridge tests
// ============================================================

describe('swift-objc-bridge', () => {
  describe('objcSelectorForSwiftMethod', () => {
    it('should handle no-params', () => {
      expect(objcSelectorForSwiftMethod('play', [])).toBe('play')
    })

    it('should handle single unlabeled param', () => {
      expect(objcSelectorForSwiftMethod('play', [null])).toBe('play:')
    })

    it('should handle single labeled param', () => {
      expect(objcSelectorForSwiftMethod('play', ['song'])).toBe('playWithSong:')
    })

    it('should handle multi-param with unlabeled first', () => {
      expect(objcSelectorForSwiftMethod('play', [null, 'by'])).toBe('play:by:')
    })

    it('should handle multi-param with labeled first', () => {
      expect(objcSelectorForSwiftMethod('play', ['song', 'by'])).toBe('playWithSong:by:')
    })

    it('should handle explicit @objc override', () => {
      expect(objcSelectorForSwiftMethod('play', ['song'], 'custom:')).toBe('custom:')
    })

    it('should return null for empty baseName', () => {
      expect(objcSelectorForSwiftMethod('', [])).toBeNull()
    })
  })

  describe('objcSelectorForSwiftInit', () => {
    it('should handle no-params', () => {
      expect(objcSelectorForSwiftInit([], [])).toBe('init')
    })

    it('should handle labeled first param', () => {
      expect(objcSelectorForSwiftInit(['name'], ['name'])).toBe('initWithName:')
    })

    it('should handle unlabeled first param (uses internal name)', () => {
      expect(objcSelectorForSwiftInit([null], ['name'])).toBe('initWithName:')
    })

    it('should handle multi-param init', () => {
      expect(objcSelectorForSwiftInit(['name', 'age'], ['name', 'age'])).toBe('initWithName:age:')
    })
  })

  describe('objcAccessorsForSwiftProperty', () => {
    it('should produce getter and setter', () => {
      const result = objcAccessorsForSwiftProperty('name')
      expect(result).toEqual({ getter: 'name', setter: 'setName:' })
    })

    it('should handle explicit objc name', () => {
      const result = objcAccessorsForSwiftProperty('name', 'customName')
      expect(result).toEqual({ getter: 'customName', setter: 'setCustomName:' })
    })

    it('should return null for empty name', () => {
      expect(objcAccessorsForSwiftProperty('')).toBeNull()
    })
  })

  describe('swiftBaseNamesForObjcSelector', () => {
    it('should handle simple selector', () => {
      expect(swiftBaseNamesForObjcSelector('play')).toEqual(['play'])
    })

    it('should handle selector with colon', () => {
      expect(swiftBaseNamesForObjcSelector('play:')).toEqual(['play'])
    })

    it('should handle initWith prefix', () => {
      expect(swiftBaseNamesForObjcSelector('initWithName:')).toEqual(
        expect.arrayContaining(['initWithName', 'init'])
      )
    })

    it('should handle With preposition', () => {
      expect(swiftBaseNamesForObjcSelector('playWithSong:')).toEqual(
        expect.arrayContaining(['playWithSong', 'play'])
      )
    })

    it('should handle setter pattern', () => {
      expect(swiftBaseNamesForObjcSelector('setName:')).toEqual(
        expect.arrayContaining(['setName', 'name'])
      )
    })

    it('should return empty for empty selector', () => {
      expect(swiftBaseNamesForObjcSelector('')).toEqual([])
    })
  })

  describe('detectExplicitObjcName', () => {
    it('should detect @objc(custom:)', () => {
      expect(detectExplicitObjcName('@objc(custom:) ')).toBe('custom:')
    })

    it('should return null for plain @objc', () => {
      expect(detectExplicitObjcName('@objc ')).toBeNull()
    })

    it('should return null for no @objc', () => {
      expect(detectExplicitObjcName('func foo()')).toBeNull()
    })
  })

  describe('isObjcExposed', () => {
    it('should detect @objc', () => {
      expect(isObjcExposed('@objc func foo()')).toBe(true)
    })

    it('should NOT detect @objcMembers (word boundary)', () => {
      // @objc\b only matches @objc followed by non-word char, not @objcMembers
      expect(isObjcExposed('@objcMembers class Foo')).toBe(false)
    })

    it('should return false for @nonobjc', () => {
      expect(isObjcExposed('@nonobjc @objc func foo()')).toBe(false)
    })

    it('should return false for plain func', () => {
      expect(isObjcExposed('func foo()')).toBe(false)
    })
  })
})

// ============================================================
// frameworks/index tests
// ============================================================

describe('frameworks/index', () => {
  beforeEach(() => {
    resetFrameworkResolvers()
  })

  it('should start with empty registry', () => {
    expect(getAllFrameworkResolvers()).toEqual([])
  })

  it('should register and retrieve a framework resolver', () => {
    const resolver: FrameworkResolver = {
      name: 'test-framework',
      languages: ['typescript'],
      detect: () => true,
      resolve: () => null,
    }
    registerFrameworkResolver(resolver)

    expect(getAllFrameworkResolvers().length).toBe(1)
    expect(getFrameworkResolver('test-framework')).toBe(resolver)
  })

  it('should replace resolver with same name', () => {
    const resolver1: FrameworkResolver = {
      name: 'dup',
      detect: () => false,
      resolve: () => null,
    }
    const resolver2: FrameworkResolver = {
      name: 'dup',
      detect: () => true,
      resolve: () => null,
    }
    registerFrameworkResolver(resolver1)
    registerFrameworkResolver(resolver2)

    expect(getAllFrameworkResolvers().length).toBe(1)
    expect(getFrameworkResolver('dup')).toBe(resolver2)
  })

  it('should detect frameworks using context', () => {
    const resolver: FrameworkResolver = {
      name: 'detectable',
      detect: (ctx) => ctx.getProjectRoot() === '/my-project',
      resolve: () => null,
    }
    registerFrameworkResolver(resolver)

    const ctx = makeContext([])
    // Override getProjectRoot for this test
    const customCtx = { ...ctx, getProjectRoot: () => '/my-project' }
    expect(detectFrameworks(customCtx).length).toBe(1)

    const otherCtx = { ...ctx, getProjectRoot: () => '/other' }
    expect(detectFrameworks(otherCtx).length).toBe(0)
  })

  it('should handle detect throwing an error', () => {
    const resolver: FrameworkResolver = {
      name: 'throws',
      detect: () => { throw new Error('boom') },
      resolve: () => null,
    }
    registerFrameworkResolver(resolver)

    expect(detectFrameworks(makeContext([])).length).toBe(0)
  })

  it('should filter applicable frameworks by language', () => {
    const tsResolver: FrameworkResolver = {
      name: 'ts-only',
      languages: ['typescript'],
      detect: () => true,
      resolve: () => null,
    }
    const universalResolver: FrameworkResolver = {
      name: 'universal',
      detect: () => true,
      resolve: () => null,
    }

    const applicable = getApplicableFrameworks([tsResolver, universalResolver], 'typescript')
    expect(applicable.length).toBe(2)

    const pyOnly = getApplicableFrameworks([tsResolver, universalResolver], 'python')
    expect(pyOnly.length).toBe(1)
    expect(pyOnly[0]!.name).toBe('universal')
  })

  it('should return undefined for unknown framework', () => {
    expect(getFrameworkResolver('nonexistent')).toBeUndefined()
  })
})
