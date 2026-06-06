/**
 * TreeSitterExtractor tests
 *
 * Tests the core extraction logic for TypeScript, JavaScript, and Python.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { TreeSitterExtractor, extractFromSource } from '../tree-sitter.js'
import { init_grammars, load_grammars_for_languages } from '../grammars.js'

describe('TreeSitterExtractor', () => {
  beforeAll(async () => {
    await init_grammars()
    await load_grammars_for_languages(['typescript', 'javascript', 'python'])
  })

  describe('TypeScript extraction', () => {
    test('extracts function declarations', () => {
      const source = `
export function hello(name: string): void {
  console.log(name)
}
`
      const result = extractFromSource('test.ts', source, 'typescript')

      const funcNode = result.nodes.find(n => n.kind === 'function' && n.name === 'hello')
      expect(funcNode).toBeDefined()
      expect(funcNode!.file).toBe('test.ts')
      expect(funcNode!.is_exported).toBe(true)
      expect(funcNode!.line).toBeGreaterThan(0)
      expect(funcNode!.end_line).toBeGreaterThan(funcNode!.line)
    })

    test('extracts class declarations', () => {
      const source = `
class Animal {
  name: string
  constructor(name: string) {
    this.name = name
  }
  speak(): string {
    return this.name
  }
}
`
      const result = extractFromSource('test.ts', source, 'typescript')

      const classNode = result.nodes.find(n => n.kind === 'class' && n.name === 'Animal')
      expect(classNode).toBeDefined()

      const methodNode = result.nodes.find(n => n.kind === 'method' && n.name === 'speak')
      expect(methodNode).toBeDefined()
    })

    test('extracts interface declarations', () => {
      const source = `
interface Printable {
  print(): void
}
`
      const result = extractFromSource('test.ts', source, 'typescript')

      const ifaceNode = result.nodes.find(n => n.kind === 'interface' && n.name === 'Printable')
      expect(ifaceNode).toBeDefined()
    })

    test('extracts enum declarations', () => {
      const source = `
enum Color {
  Red,
  Green,
  Blue,
}
`
      const result = extractFromSource('test.ts', source, 'typescript')

      const enumNode = result.nodes.find(n => n.kind === 'enum' && n.name === 'Color')
      expect(enumNode).toBeDefined()
    })

    test('extracts imports', () => {
      const source = `
import { foo } from './bar'
import path from 'path'
`
      const result = extractFromSource('test.ts', source, 'typescript')

      const importNodes = result.nodes.filter(n => n.kind === 'import')
      expect(importNodes.length).toBeGreaterThanOrEqual(2)
    })

    test('extracts call references', () => {
      const source = `
function doWork() {
  console.log('hello')
  Math.random()
}
`
      const result = extractFromSource('test.ts', source, 'typescript')

      const funcNode = result.nodes.find(n => n.kind === 'function' && n.name === 'doWork')
      expect(funcNode).toBeDefined()

      // Should have unresolved references for calls
      const callRefs = result.unresolved_references.filter(r => r.reference_kind === 'calls')
      expect(callRefs.length).toBeGreaterThanOrEqual(2)
    })

    test('extracts type alias', () => {
      const source = `
type StringOrNumber = string | number
`
      const result = extractFromSource('test.ts', source, 'typescript')

      const aliasNode = result.nodes.find(n => n.kind === 'type_alias' && n.name === 'StringOrNumber')
      expect(aliasNode).toBeDefined()
    })

    test('extracts variable declarations', () => {
      const source = `
const MAX_SIZE = 100
let count = 0
`
      const result = extractFromSource('test.ts', source, 'typescript')

      const constNode = result.nodes.find(n => n.kind === 'constant' && n.name === 'MAX_SIZE')
      expect(constNode).toBeDefined()

      const varNode = result.nodes.find(n => n.kind === 'variable' && n.name === 'count')
      expect(varNode).toBeDefined()
    })

    test('extracts file node', () => {
      const source = `const x = 1`
      const result = extractFromSource('test.ts', source, 'typescript')

      const fileNode = result.nodes.find(n => n.kind === 'file')
      expect(fileNode).toBeDefined()
      expect(fileNode!.name).toBe('test.ts')
    })
  })

  describe('Python extraction', () => {
    test('extracts function definitions', () => {
      const source = `
def greet(name):
    print(f"Hello {name}")
`
      const result = extractFromSource('test.py', source, 'python')

      const funcNode = result.nodes.find(n => n.kind === 'function' && n.name === 'greet')
      expect(funcNode).toBeDefined()
      expect(funcNode!.file).toBe('test.py')
    })

    test('extracts class definitions', () => {
      const source = `
class Dog:
    def bark(self):
        return "woof"
`
      const result = extractFromSource('test.py', source, 'python')

      const classNode = result.nodes.find(n => n.kind === 'class' && n.name === 'Dog')
      expect(classNode).toBeDefined()

      const methodNode = result.nodes.find(n => n.kind === 'method' && n.name === 'bark')
      expect(methodNode).toBeDefined()
    })

    test('extracts imports', () => {
      const source = `
import os
from sys import argv
`
      const result = extractFromSource('test.py', source, 'python')

      const importNodes = result.nodes.filter(n => n.kind === 'import')
      expect(importNodes.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('snake_case field verification', () => {
    test('all node fields use snake_case', () => {
      const source = `
export function test(): void {}
`
      const result = extractFromSource('test.ts', source, 'typescript')

      for (const node of result.nodes) {
        // Verify snake_case fields exist
        expect(typeof node.file).toBe('string')
        expect(typeof node.line).toBe('number')
        expect(node.end_line === undefined || typeof node.end_line === 'number').toBe(true)
        expect(node.qualified_name === undefined || typeof node.qualified_name === 'string').toBe(true)
        expect(node.is_exported === undefined || typeof node.is_exported === 'boolean').toBe(true)
        expect(node.start_column === undefined || typeof node.start_column === 'number').toBe(true)
        expect(node.end_column === undefined || typeof node.end_column === 'number').toBe(true)

        // Verify camelCase fields do NOT exist
        expect((node as any).filePath).toBeUndefined()
        expect((node as any).startLine).toBeUndefined()
        expect((node as any).endLine).toBeUndefined()
        expect((node as any).qualifiedName).toBeUndefined()
        expect((node as any).isExported).toBeUndefined()
      }
    })

    test('unresolved_references use snake_case', () => {
      const source = `
function test() {
  foo()
}
`
      const result = extractFromSource('test.ts', source, 'typescript')

      for (const ref of result.unresolved_references) {
        expect(typeof ref.from_node_id).toBe('string')
        expect(typeof ref.reference_name).toBe('string')
        expect(typeof ref.reference_kind).toBe('string')
        expect(typeof ref.line).toBe('number')
        expect(typeof ref.column).toBe('number')

        // Verify camelCase fields do NOT exist
        expect((ref as any).fromNodeId).toBeUndefined()
        expect((ref as any).referenceName).toBeUndefined()
        expect((ref as any).referenceKind).toBeUndefined()
      }
    })

    test('result uses snake_case duration_ms', () => {
      const source = `const x = 1`
      const result = extractFromSource('test.ts', source, 'typescript')

      expect(typeof result.duration_ms).toBe('number')
      expect(result.duration_ms).toBeGreaterThanOrEqual(0)
      expect((result as any).durationMs).toBeUndefined()
    })
  })

  describe('edge extraction', () => {
    test('creates contains edges for class members', () => {
      const source = `
class Foo {
  bar(): void {}
}
`
      const result = extractFromSource('test.ts', source, 'typescript')

      const classNode = result.nodes.find(n => n.kind === 'class' && n.name === 'Foo')
      const methodNode = result.nodes.find(n => n.kind === 'method' && n.name === 'bar')

      expect(classNode).toBeDefined()
      expect(methodNode).toBeDefined()

      const containsEdge = result.edges.find(
        e => e.source === classNode!.id && e.target === methodNode!.id && e.kind === 'contains'
      )
      expect(containsEdge).toBeDefined()
    })
  })
})
