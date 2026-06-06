/**
 * Tests for tree-sitter extraction types.
 * Validates that type interfaces are correctly defined and usable.
 */

import { describe, expect, test } from 'bun:test'
import type {
  ExtractionNode,
  ExtractionEdge,
  UnresolvedRef,
  ExtractionError,
  ExtractionResult,
  ImportInfo,
  VariableInfo,
  ExtractorContext,
  LanguageExtractor,
  Language,
} from '../types.js'

describe('ExtractionNode', () => {
  test('can create a valid ExtractionNode with required fields', () => {
    const node: ExtractionNode = {
      id: 'func:abc123',
      kind: 'function',
      name: 'testFunc',
      file: 'src/test.ts',
      line: 10,
      end_line: 20,
      start_column: 0,
      end_column: 5,
    }
    expect(node.id).toBe('func:abc123')
    expect(node.kind).toBe('function')
    expect(node.name).toBe('testFunc')
    expect(node.file).toBe('src/test.ts')
    expect(node.line).toBe(10)
    expect(node.end_line).toBe(20)
  })

  test('supports all optional metadata fields', () => {
    const node: ExtractionNode = {
      id: 'class:abc123',
      kind: 'class',
      name: 'MyClass',
      file: 'src/test.ts',
      line: 1,
      end_line: 100,
      start_column: 0,
      end_column: 1,
      qualified_name: 'src/test.ts::MyClass',
      language: 'typescript',
      signature: 'class MyClass',
      docstring: 'A test class',
      visibility: 'public',
      is_exported: true,
      is_async: false,
      is_static: false,
    }
    expect(node.qualified_name).toBe('src/test.ts::MyClass')
    expect(node.language).toBe('typescript')
    expect(node.visibility).toBe('public')
    expect(node.is_exported).toBe(true)
    expect(node.is_async).toBe(false)
    expect(node.is_static).toBe(false)
    expect(node.docstring).toBe('A test class')
  })
})

describe('ExtractionEdge', () => {
  test('can create a valid ExtractionEdge', () => {
    const edge: ExtractionEdge = {
      source: 'func:abc',
      target: 'func:def',
      kind: 'calls',
      line: 42,
    }
    expect(edge.source).toBe('func:abc')
    expect(edge.target).toBe('func:def')
    expect(edge.kind).toBe('calls')
    expect(edge.line).toBe(42)
  })
})

describe('UnresolvedRef', () => {
  test('can create a valid UnresolvedRef', () => {
    const ref: UnresolvedRef = {
      from_node_id: 'func:abc',
      reference_name: 'someFunction',
      reference_kind: 'calls',
      line: 10,
      column: 5,
      file: 'src/test.ts',
      language: 'typescript',
    }
    expect(ref.from_node_id).toBe('func:abc')
    expect(ref.reference_name).toBe('someFunction')
    expect(ref.reference_kind).toBe('calls')
  })
})

describe('ExtractionResult', () => {
  test('can create a valid ExtractionResult', () => {
    const result: ExtractionResult = {
      nodes: [],
      edges: [],
      unresolved_references: [],
      errors: [],
      duration_ms: 100,
    }
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
    expect(result.unresolved_references).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
    expect(result.duration_ms).toBe(100)
  })
})

describe('ExtractionError', () => {
  test('can create errors with severity levels', () => {
    const error: ExtractionError = {
      message: 'Parse error',
      severity: 'error',
      code: 'PARSE_ERROR',
      line: 5,
    }
    expect(error.severity).toBe('error')

    const warning: ExtractionError = {
      message: 'Deprecated syntax',
      severity: 'warning',
    }
    expect(warning.severity).toBe('warning')
  })
})

describe('Language type', () => {
  test('Language type accepts all expected values', () => {
    const languages: Language[] = [
      'typescript', 'javascript', 'tsx', 'jsx',
      'python', 'go', 'rust', 'java',
      'c', 'cpp', 'csharp', 'php',
      'ruby', 'swift', 'kotlin', 'dart',
      'pascal', 'scala', 'lua', 'luau', 'objc',
      'svelte', 'vue', 'liquid',
      'yaml', 'twig', 'xml', 'properties',
      'unknown',
    ]
    expect(languages).toHaveLength(29)
  })
})

describe('LanguageExtractor interface', () => {
  test('TypeScript extractor satisfies LanguageExtractor', async () => {
    const { typescriptExtractor } = await import('../languages/typescript.js')
    const extractor: LanguageExtractor = typescriptExtractor
    expect(extractor.functionTypes).toContain('function_declaration')
    expect(extractor.classTypes).toContain('class_declaration')
    expect(extractor.nameField).toBe('name')
    expect(extractor.bodyField).toBe('body')
  })
})
