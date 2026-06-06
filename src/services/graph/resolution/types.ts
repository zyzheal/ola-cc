/**
 * Reference Resolution Types
 *
 * Types for the reference resolution system.
 * Migrated from codegraph/src/resolution/types.ts — adapted to use
 * NodeMetadata/EdgeType from our GraphStore.
 */

import type { NodeMetadata, EdgeType } from '../GraphStore.js'

/**
 * An unresolved reference from extraction
 */
export interface UnresolvedRef {
  /** ID of the source node containing the reference */
  fromNodeId: string
  /** The name being referenced */
  referenceName: string
  /** Type of reference */
  referenceKind: EdgeType
  /** Line where reference occurs */
  line: number
  /** Column where reference occurs */
  column: number
  /** File path where reference occurs */
  filePath: string
  /** Language of the source file */
  language: string
  /** Possible qualified names it might resolve to */
  candidates?: string[]
}

/**
 * A resolved reference
 */
export interface ResolvedRef {
  /** Original unresolved reference */
  original: UnresolvedRef
  /** ID of the target node */
  targetNodeId: string
  /** Confidence score (0-1) */
  confidence: number
  /** How it was resolved */
  resolvedBy: 'exact-match' | 'import' | 'qualified-name' | 'framework' | 'fuzzy' | 'instance-method' | 'file-path'
}

/**
 * Result of resolution attempt
 */
export interface ResolutionResult {
  /** Successfully resolved references */
  resolved: ResolvedRef[]
  /** References that couldn't be resolved */
  unresolved: UnresolvedRef[]
  /** Statistics */
  stats: {
    total: number
    resolved: number
    unresolved: number
    byMethod: Record<string, number>
  }
}

/**
 * Context for resolution — provides access to the graph.
 * Uses NodeMetadata from our GraphStore.
 */
export interface ResolutionContext {
  /** Get all nodes in a file */
  getNodesInFile(filePath: string): NodeMetadata[]
  /** Get all nodes by name */
  getNodesByName(name: string): NodeMetadata[]
  /** Get all nodes by qualified name */
  getNodesByQualifiedName(qualifiedName: string): NodeMetadata[]
  /** Get all nodes of a kind */
  getNodesByKind(kind: string): NodeMetadata[]
  /** Check if a file exists */
  fileExists(filePath: string): boolean
  /** Read file content */
  readFile(filePath: string): string | null
  /** Get project root */
  getProjectRoot(): string
  /** Get all files */
  getAllFiles(): string[]
  /** Get nodes by lowercase name (O(1) lookup for fuzzy matching) */
  getNodesByLowerName(lowerName: string): NodeMetadata[]
  /** Get cached import mappings for a file */
  getImportMappings(filePath: string, language: string): ImportMapping[]
  /** Project import-path aliases */
  getProjectAliases?(): import('./path-aliases.js').AliasMap | null
  /** Monorepo workspace member packages */
  getWorkspacePackages?(): import('./workspace-packages.js').WorkspacePackages | null
  /** Re-exports declared by a file */
  getReExports?(filePath: string, language: string): ReExport[]
  /** List immediate subdirectories of relativePath */
  listDirectories?(relativePath: string): string[]
  /** C/C++ include search directories */
  getCppIncludeDirs?(): string[]
}

/**
 * Result of framework-specific file extraction.
 */
export interface FrameworkExtractionResult {
  /** Framework-specific nodes (e.g. routes) */
  nodes: NodeMetadata[]
  /** Framework-specific unresolved references (e.g. route -> handler) */
  references: UnresolvedRef[]
}

/**
 * Framework-specific resolver
 */
export interface FrameworkResolver {
  /** Framework name */
  name: string
  /** Languages this framework applies to. If omitted, applies to all languages. */
  languages?: string[]
  /** Detect if project uses this framework (project-level, called once at startup) */
  detect(context: ResolutionContext): boolean
  /** Resolve a reference using framework-specific patterns */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null
  /** Opt a reference NAME through the resolver's name-exists pre-filter */
  claimsReference?(name: string): boolean
  /** Extract framework-specific nodes and references from a file */
  extract?(filePath: string, content: string): FrameworkExtractionResult
  /** Cross-file finalization pass */
  postExtract?(context: ResolutionContext): NodeMetadata[]
}

/**
 * Import mapping from a file
 */
export interface ImportMapping {
  /** Local name used in the file */
  localName: string
  /** Original exported name (may differ due to aliasing) */
  exportedName: string
  /** Source module/path */
  source: string
  /** Whether it's a default import */
  isDefault: boolean
  /** Whether it's a namespace import (import * as X) */
  isNamespace: boolean
  /** Resolved file path (if local) */
  resolvedPath?: string
}

/**
 * Re-export from a file: `export { x } from './other'` or
 * `export * from './other'`.
 */
export type ReExport =
  | {
      kind: 'named'
      exportedName: string
      originalName: string
      source: string
    }
  | {
      kind: 'wildcard'
      source: string
    }
