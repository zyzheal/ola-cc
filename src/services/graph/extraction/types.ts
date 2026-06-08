/**
 * Extraction types for the graph extraction subsystem.
 *
 * These types are used by specialized extractors (Vue, Svelte, Liquid, etc.)
 * and the core TreeSitterExtractor, mapping to GraphStore's NodeMetadata
 * with snake_case field naming.
 *
 * Field mapping from codegraph camelCase:
 *   filePath → file, startLine → line, endLine → end_line,
 *   qualifiedName → qualified_name, isExported → is_exported,
 *   fromNodeId → from_node_id, referenceName → reference_name,
 *   referenceKind → reference_kind
 */

import { Node as SyntaxNode } from 'web-tree-sitter'

// Re-export SyntaxNode for consumers
export type { SyntaxNode }

// ============================================================
// Language type
// ============================================================

export type Language =
  | 'typescript' | 'tsx' | 'javascript' | 'jsx'
  | 'python' | 'go' | 'rust' | 'java' | 'c' | 'cpp'
  | 'csharp' | 'php' | 'ruby' | 'swift' | 'kotlin'
  | 'dart' | 'pascal' | 'scala' | 'lua' | 'luau' | 'objc'
  | 'svelte' | 'vue' | 'liquid' | 'yaml' | 'twig' | 'xml'
  | 'properties' | 'unknown'

// ============================================================
// Core extraction result types (snake_case)
// ============================================================

export interface ExtractionNode {
  id: string
  kind: string
  name: string
  file: string
  line: number
  end_line?: number
  qualified_name?: string
  language?: string
  signature?: string
  docstring?: string
  visibility?: string
  is_exported?: boolean
  is_async?: boolean
  is_static?: boolean
  start_column?: number
  end_column?: number
  updated_at?: number
}

export interface ExtractionEdge {
  source: string
  target: string
  kind: string
  weight?: number
  line?: number
}

export interface UnresolvedRef {
  from_node_id: string
  reference_name: string
  reference_kind: string
  line: number
  column: number
  file?: string
  language?: string
}

export interface ExtractionError {
  message: string
  severity: 'error' | 'warning'
  code?: string
  line?: number
}

export interface ExtractionResult {
  nodes: ExtractionNode[]
  edges: ExtractionEdge[]
  unresolved_references: UnresolvedRef[]
  errors: ExtractionError[]
  duration_ms: number
}

// ============================================================
// Language Extractor Interface
// ============================================================

export interface ImportInfo {
  moduleName: string
  signature: string
  handledRefs?: boolean
}

export interface VariableInfo {
  name: string
  kind: string
  signature?: string
  delegateToFunction?: SyntaxNode
  positionNode?: SyntaxNode
}

export interface ExtractorContext {
  createNode(kind: string, name: string, node: SyntaxNode, extra?: Partial<ExtractionNode>): ExtractionNode | null
  visitNode(node: SyntaxNode): void
  visitFunctionBody(body: SyntaxNode, functionId: string): void
  addUnresolvedReference(ref: UnresolvedRef): void
  pushScope(nodeId: string): void
  popScope(): void
  readonly file: string
  readonly source: string
  readonly nodeStack: readonly string[]
  readonly nodes: readonly ExtractionNode[]
}

export interface LanguageExtractor {
  // --- Node type mappings ---
  functionTypes: string[]
  classTypes: string[]
  methodTypes: string[]
  interfaceTypes: string[]
  structTypes: string[]
  enumTypes: string[]
  enumMemberTypes?: string[]
  typeAliasTypes: string[]
  importTypes: string[]
  callTypes: string[]
  variableTypes: string[]
  fieldTypes?: string[]
  propertyTypes?: string[]

  // --- Field name mappings ---
  nameField: string
  bodyField: string
  paramsField?: string
  returnField?: string

  // --- Hooks ---
  resolveName?: (node: SyntaxNode, source: string) => string | undefined
  extractPropertyName?: (node: SyntaxNode, source: string) => string | null
  getSignature?: (node: SyntaxNode, source: string) => string | undefined
  getVisibility?: (node: SyntaxNode) => 'public' | 'private' | 'protected' | 'internal' | undefined
  isExported?: (node: SyntaxNode, source: string) => boolean
  isAsync?: (node: SyntaxNode) => boolean
  isStatic?: (node: SyntaxNode) => boolean
  isConst?: (node: SyntaxNode) => boolean

  // --- Config properties ---
  extraClassNodeTypes?: string[]
  methodsAreTopLevel?: boolean
  interfaceKind?: string

  // --- Advanced hooks ---
  visitNode?: (node: SyntaxNode, ctx: ExtractorContext) => boolean
  classifyClassNode?: (node: SyntaxNode) => 'class' | 'struct' | 'enum' | 'interface' | 'trait'
  resolveBody?: (node: SyntaxNode, bodyField: string) => SyntaxNode | null
  extractImport?: (node: SyntaxNode, source: string) => ImportInfo | null
  extractVariables?: (node: SyntaxNode, source: string) => VariableInfo[]
  getReceiverType?: (node: SyntaxNode, source: string) => string | undefined
  resolveTypeAliasKind?: (node: SyntaxNode, source: string) => string | undefined
  isMisparsedFunction?: (name: string, node: SyntaxNode) => boolean
  extractBareCall?: (node: SyntaxNode, source: string) => string | undefined
  packageTypes?: string[]
  extractPackage?: (node: SyntaxNode, source: string) => string | null
}
