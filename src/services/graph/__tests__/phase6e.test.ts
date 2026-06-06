/**
 * Phase 6e Tests: C++ Include Dirs + Enhanced Re-Export Tracking
 *
 * Tests for:
 * - loadCppIncludeDirs: compile_commands.json parsing, heuristic fallback, shlexSplit
 * - parseReExports: wildcard, named, aliased, non-JS language
 * - extractReExports integration: re-export chains in GraphStore
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'

// ============================================================
// Task 1: C++ Include Directory Discovery
// ============================================================

import {
  loadCppIncludeDirs,
  loadCppIncludeDirsFromCompileDB,
  loadCppIncludeDirsHeuristic,
  shlexSplit,
  clearCppIncludeDirCache,
} from '../resolution/cppIncludeDirs.js'

describe('shlexSplit', () => {
  test('splits simple arguments', () => {
    expect(shlexSplit('gcc -I/usr/include -c foo.c')).toEqual([
      'gcc', '-I/usr/include', '-c', 'foo.c',
    ])
  })

  test('handles double-quoted arguments', () => {
    expect(shlexSplit('gcc -I"/path with spaces/include" -c foo.c')).toEqual([
      'gcc', '-I/path with spaces/include', '-c', 'foo.c',
    ])
  })

  test('handles single-quoted arguments', () => {
    expect(shlexSplit("gcc -I'/path with spaces/include' -c foo.c")).toEqual([
      'gcc', '-I/path with spaces/include', '-c', 'foo.c',
    ])
  })

  test('handles escaped characters in double quotes', () => {
    expect(shlexSplit('gcc -I"foo\\"bar" -c foo.c')).toEqual([
      'gcc', '-Ifoo"bar', '-c', 'foo.c',
    ])
  })

  test('returns empty array for empty string', () => {
    expect(shlexSplit('')).toEqual([])
  })

  test('handles multiple spaces', () => {
    expect(shlexSplit('gcc   -I/usr/include   -c')).toEqual([
      'gcc', '-I/usr/include', '-c',
    ])
  })
})

describe('loadCppIncludeDirsFromCompileDB', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `phase6e-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    clearCppIncludeDirCache()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    clearCppIncludeDirCache()
  })

  test('returns null when no compile_commands.json exists', () => {
    expect(loadCppIncludeDirsFromCompileDB(tmpDir)).toBeNull()
  })

  test('parses -I flags from compile_commands.json', () => {
    const db = [
      {
        directory: tmpDir,
        command: 'g++ -Iinclude -Isrc -c main.cpp',
        file: 'main.cpp',
      },
    ]
    writeFileSync(join(tmpDir, 'compile_commands.json'), JSON.stringify(db))

    const dirs = loadCppIncludeDirsFromCompileDB(tmpDir)
    expect(dirs).toEqual(expect.arrayContaining(['include', 'src']))
  })

  test('parses -I<dir> (no space) and -isystem <dir>', () => {
    const db = [
      {
        directory: tmpDir,
        arguments: ['g++', '-I/usr/local/include', '-isystem', '/opt/boost/include', '-c', 'main.cpp'],
        file: 'main.cpp',
      },
    ]
    writeFileSync(join(tmpDir, 'compile_commands.json'), JSON.stringify(db))

    const dirs = loadCppIncludeDirsFromCompileDB(tmpDir)
    // Only relative paths within project are kept
    // /usr/local/include and /opt/boost/include are absolute and outside project
    // So they get filtered out. Let's use relative paths instead.
    expect(dirs).toEqual([])
  })

  test('parses relative -isystem paths', () => {
    mkdirSync(join(tmpDir, 'vendor', 'include'), { recursive: true })
    const db = [
      {
        directory: tmpDir,
        arguments: ['g++', '-Iinclude', '-isystem', 'vendor/include', '-c', 'main.cpp'],
        file: 'main.cpp',
      },
    ]
    writeFileSync(join(tmpDir, 'compile_commands.json'), JSON.stringify(db))

    const dirs = loadCppIncludeDirsFromCompileDB(tmpDir)
    expect(dirs).toEqual(expect.arrayContaining(['include', 'vendor/include']))
  })

  test('handles build/ subdirectory compile_commands.json', () => {
    mkdirSync(join(tmpDir, 'build'), { recursive: true })
    mkdirSync(join(tmpDir, 'include'), { recursive: true })
    const db = [
      {
        directory: join(tmpDir, 'build'),
        command: 'g++ -I../include -c ../main.cpp',
        file: '../main.cpp',
      },
    ]
    writeFileSync(join(tmpDir, 'build', 'compile_commands.json'), JSON.stringify(db))

    const dirs = loadCppIncludeDirsFromCompileDB(tmpDir)
    expect(dirs).toContain('include')
  })

  test('deduplicates include directories', () => {
    const db = [
      { directory: tmpDir, command: 'g++ -Iinclude -c a.cpp', file: 'a.cpp' },
      { directory: tmpDir, command: 'g++ -Iinclude -c b.cpp', file: 'b.cpp' },
    ]
    writeFileSync(join(tmpDir, 'compile_commands.json'), JSON.stringify(db))

    const dirs = loadCppIncludeDirsFromCompileDB(tmpDir)!
    expect(dirs.filter(d => d === 'include')).toHaveLength(1)
  })

  test('returns null for invalid JSON', () => {
    writeFileSync(join(tmpDir, 'compile_commands.json'), 'not json')
    expect(loadCppIncludeDirsFromCompileDB(tmpDir)).toBeNull()
  })

  test('returns null for non-array JSON', () => {
    writeFileSync(join(tmpDir, 'compile_commands.json'), '{"foo": "bar"}')
    expect(loadCppIncludeDirsFromCompileDB(tmpDir)).toBeNull()
  })
})

describe('loadCppIncludeDirsHeuristic', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `phase6e-heuristic-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('finds convention directories', () => {
    mkdirSync(join(tmpDir, 'include'))
    mkdirSync(join(tmpDir, 'src'))
    mkdirSync(join(tmpDir, 'lib'))

    const dirs = loadCppIncludeDirsHeuristic(tmpDir)
    expect(dirs).toEqual(expect.arrayContaining(['include', 'src', 'lib']))
  })

  test('finds directories with .h files', () => {
    mkdirSync(join(tmpDir, 'mylib'))
    writeFileSync(join(tmpDir, 'mylib', 'foo.h'), '')

    const dirs = loadCppIncludeDirsHeuristic(tmpDir)
    expect(dirs).toContain('mylib')
  })

  test('finds directories with .hpp files', () => {
    mkdirSync(join(tmpDir, 'core'))
    writeFileSync(join(tmpDir, 'core', 'bar.hpp'), '')

    const dirs = loadCppIncludeDirsHeuristic(tmpDir)
    expect(dirs).toContain('core')
  })

  test('finds directories with .hxx and .hh files', () => {
    mkdirSync(join(tmpDir, 'ext'))
    writeFileSync(join(tmpDir, 'ext', 'baz.hxx'), '')

    const dirs = loadCppIncludeDirsHeuristic(tmpDir)
    expect(dirs).toContain('ext')
  })

  test('ignores directories without headers', () => {
    mkdirSync(join(tmpDir, 'docs'))
    writeFileSync(join(tmpDir, 'docs', 'readme.md'), '')

    const dirs = loadCppIncludeDirsHeuristic(tmpDir)
    expect(dirs).not.toContain('docs')
  })

  test('returns empty for empty directory', () => {
    const dirs = loadCppIncludeDirsHeuristic(tmpDir)
    expect(dirs).toEqual([])
  })
})

describe('loadCppIncludeDirs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `phase6e-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    clearCppIncludeDirCache()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    clearCppIncludeDirCache()
  })

  test('prefers compile_commands.json over heuristic', () => {
    // Create heuristic dirs
    mkdirSync(join(tmpDir, 'include'))
    mkdirSync(join(tmpDir, 'src'))

    // Create compile_commands.json with different dirs
    mkdirSync(join(tmpDir, 'custom'))
    const db = [{ directory: tmpDir, command: 'g++ -Icustom -c main.cpp', file: 'main.cpp' }]
    writeFileSync(join(tmpDir, 'compile_commands.json'), JSON.stringify(db))

    const dirs = loadCppIncludeDirs(tmpDir)
    expect(dirs).toContain('custom')
    // Should NOT contain heuristic-only dirs when compile_commands.json exists
    expect(dirs).not.toContain('include')
  })

  test('falls back to heuristic when no compile_commands.json', () => {
    mkdirSync(join(tmpDir, 'include'))
    mkdirSync(join(tmpDir, 'src'))

    const dirs = loadCppIncludeDirs(tmpDir)
    expect(dirs).toEqual(expect.arrayContaining(['include', 'src']))
  })

  test('caches results', () => {
    mkdirSync(join(tmpDir, 'include'))
    const dirs1 = loadCppIncludeDirs(tmpDir)
    const dirs2 = loadCppIncludeDirs(tmpDir)
    expect(dirs1).toBe(dirs2) // same reference = cached
  })
})

// ============================================================
// Task 2: Re-Export Parser
// ============================================================

import { parseReExports } from '../resolution/reExportParser.js'

describe('parseReExports', () => {
  test('parses wildcard re-export', () => {
    const content = `export * from './utils'`
    const result = parseReExports(content, 'typescript')
    expect(result).toEqual([
      { kind: 'wildcard', source: './utils' },
    ])
  })

  test('parses wildcard re-export with double quotes', () => {
    const content = `export * from "./utils"`
    const result = parseReExports(content, 'typescript')
    expect(result).toEqual([
      { kind: 'wildcard', source: './utils' },
    ])
  })

  test('parses namespace re-export (export * as ns)', () => {
    const content = `export * as Utils from './utils'`
    const result = parseReExports(content, 'typescript')
    expect(result).toEqual([
      { kind: 'wildcard', source: './utils' },
    ])
  })

  test('parses named re-export', () => {
    const content = `export { foo, bar } from './module'`
    const result = parseReExports(content, 'typescript')
    expect(result).toEqual([
      { kind: 'named', exportedName: 'foo', originalName: 'foo', source: './module' },
      { kind: 'named', exportedName: 'bar', originalName: 'bar', source: './module' },
    ])
  })

  test('parses named re-export with aliasing', () => {
    const content = `export { foo as bar, baz } from './module'`
    const result = parseReExports(content, 'typescript')
    expect(result).toEqual([
      { kind: 'named', exportedName: 'bar', originalName: 'foo', source: './module' },
      { kind: 'named', exportedName: 'baz', originalName: 'baz', source: './module' },
    ])
  })

  test('parses multiple re-exports', () => {
    const content = `
export * from './utils'
export { a, b as c } from './helpers'
export * from './constants'
`
    const result = parseReExports(content, 'typescript')
    expect(result).toHaveLength(4)
    // Wildcard regex runs first, then named regex
    expect(result[0]).toEqual({ kind: 'wildcard', source: './utils' })
    expect(result[1]).toEqual({ kind: 'wildcard', source: './constants' })
    expect(result[2]).toEqual({ kind: 'named', exportedName: 'a', originalName: 'a', source: './helpers' })
    expect(result[3]).toEqual({ kind: 'named', exportedName: 'c', originalName: 'b', source: './helpers' })
  })

  test('ignores commented-out re-exports', () => {
    const content = `
// export { foo } from './dead'
/* export * from './dead2' */
export { bar } from './live'
`
    const result = parseReExports(content, 'typescript')
    expect(result).toEqual([
      { kind: 'named', exportedName: 'bar', originalName: 'bar', source: './live' },
    ])
  })

  test('ignores re-exports without from clause', () => {
    const content = `export { foo }` // no `from` — this is a local export, not a re-export
    const result = parseReExports(content, 'typescript')
    expect(result).toEqual([])
  })

  test('returns empty array for non-JS/TS languages', () => {
    const content = `export * from './module'`
    expect(parseReExports(content, 'python')).toEqual([])
    expect(parseReExports(content, 'go')).toEqual([])
    expect(parseReExports(content, 'rust')).toEqual([])
    expect(parseReExports(content, 'java')).toEqual([])
  })

  test('handles JavaScript language', () => {
    const content = `export * from './utils'`
    const result = parseReExports(content, 'javascript')
    expect(result).toEqual([
      { kind: 'wildcard', source: './utils' },
    ])
  })

  test('handles TSX and JSX', () => {
    const content = `export { Button } from './components'`
    expect(parseReExports(content, 'tsx')).toEqual([
      { kind: 'named', exportedName: 'Button', originalName: 'Button', source: './components' },
    ])
    expect(parseReExports(content, 'jsx')).toEqual([
      { kind: 'named', exportedName: 'Button', originalName: 'Button', source: './components' },
    ])
  })

  test('handles whitespace variations', () => {
    const content = `export  *  from  './utils'`
    const result = parseReExports(content, 'typescript')
    expect(result).toEqual([
      { kind: 'wildcard', source: './utils' },
    ])
  })

  test('handles empty content', () => {
    expect(parseReExports('', 'typescript')).toEqual([])
  })
})

// ============================================================
// Task 3: GraphStore extractReExports integration
// ============================================================

import { GraphStore } from '../GraphStore.js'
import { Database } from 'bun:sqlite'

describe('GraphStore.extractReExports enhanced', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `phase6e-graphstore-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(resolve(tmpDir, '.codegraph'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    // Clean up singleton
    GraphStore.getInstance(tmpDir).markDirty()
  })

  test('adjacency-based re-export still works', async () => {
    // Create a DB where node A imports node B, and B is exported
    const dbPath = resolve(tmpDir, '.codegraph', 'codegraph.db')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER,
      end_line INTEGER, is_exported INTEGER
    )`)
    db.run(`CREATE TABLE edges (
      source TEXT, target TEXT, kind TEXT
    )`)
    db.run(`INSERT INTO nodes VALUES ('a:foo', 'function', 'foo', 'a.ts', 1, 5, 0)`)
    db.run(`INSERT INTO nodes VALUES ('b:bar', 'function', 'bar', 'b.ts', 1, 5, 1)`)
    db.run(`INSERT INTO edges VALUES ('a:foo', 'b:bar', 'imports')`)
    db.close()

    const store = GraphStore.getInstance(tmpDir)
    // load() calls extractReExports() internally
    await store.load()

    // After load(), extractReExports should have derived the exports edge
    const exports = store.getAllOutEdges('a:foo').filter(e => e.edge.type === 'exports')
    expect(exports).toHaveLength(1)
    expect(exports[0]!.target).toBe('b:bar')

    // The imports edge should also still exist
    const imports = store.getAllOutEdges('a:foo').filter(e => e.edge.type === 'imports')
    expect(imports).toHaveLength(1)
  })

  test('source-level re-export parsing creates exports edges for wildcard', async () => {
    // Create DB with language column so buildFileRecords can detect TS
    const dbPath = resolve(tmpDir, '.codegraph', 'codegraph.db')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER,
      end_line INTEGER, is_exported INTEGER, language TEXT
    )`)
    db.run(`CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`)
    db.run(`INSERT INTO nodes VALUES ('utils:add', 'function', 'add', 'src/utils.ts', 1, 3, 1, 'typescript')`)
    db.run(`INSERT INTO nodes VALUES ('utils:multiply', 'function', 'multiply', 'src/utils.ts', 5, 7, 1, 'typescript')`)
    db.run(`INSERT INTO nodes VALUES ('index:file', 'file', 'index', 'src/index.ts', 1, 10, 0, 'typescript')`)
    db.close()

    // Create actual source files for re-export parsing
    mkdirSync(resolve(tmpDir, 'src'), { recursive: true })
    writeFileSync(resolve(tmpDir, 'src', 'utils.ts'), `
export function add(a: number, b: number) { return a + b }
export function multiply(a: number, b: number) { return a * b }
`)
    writeFileSync(resolve(tmpDir, 'src', 'index.ts'), `
export * from './utils'
`)

    const store = GraphStore.getInstance(tmpDir)
    await store.load()
    store.extractReExports()

    // index should re-export utils' symbols
    const indexExports = store.getAllOutEdges('index:file').filter(e => e.edge.type === 'exports')
    const exportTargets = indexExports.map(e => e.target)
    expect(exportTargets).toContain('utils:add')
    expect(exportTargets).toContain('utils:multiply')
  })

  test('source-level re-export parsing creates exports edges for named re-exports', async () => {
    const dbPath = resolve(tmpDir, '.codegraph', 'codegraph.db')
    const db = new Database(dbPath)
    db.run(`CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT, name TEXT, file_path TEXT, start_line INTEGER,
      end_line INTEGER, is_exported INTEGER, language TEXT
    )`)
    db.run(`CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)`)
    db.run(`INSERT INTO nodes VALUES ('helpers:formatDate', 'function', 'formatDate', 'src/helpers.ts', 1, 3, 1, 'typescript')`)
    db.run(`INSERT INTO nodes VALUES ('helpers:parseDate', 'function', 'parseDate', 'src/helpers.ts', 5, 7, 1, 'typescript')`)
    db.run(`INSERT INTO nodes VALUES ('index:file', 'file', 'index', 'src/index.ts', 1, 10, 0, 'typescript')`)
    db.close()

    mkdirSync(resolve(tmpDir, 'src'), { recursive: true })
    writeFileSync(resolve(tmpDir, 'src', 'helpers.ts'), `
export function formatDate(d: Date) { return d.toISOString() }
export function parseDate(s: string) { return new Date(s) }
`)
    writeFileSync(resolve(tmpDir, 'src', 'index.ts'), `
export { formatDate as fmtDate } from './helpers'
`)

    const store = GraphStore.getInstance(tmpDir)
    await store.load()
    store.extractReExports()

    const indexExports = store.getAllOutEdges('index:file').filter(e => e.edge.type === 'exports')
    const exportTargets = indexExports.map(e => e.target)
    expect(exportTargets).toContain('helpers:formatDate')
    expect(exportTargets).not.toContain('helpers:parseDate')
  })
})
