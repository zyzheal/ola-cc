/**
 * Parser types for non-code file parsing.
 *
 * Each parser extracts nodes and edges from a specific file format,
 * producing a ParserResult that can be merged into GraphStore.
 */

export interface ParsedNode {
  id: string
  name: string
  kind: string       // e.g., 'service', 'job', 'step', 'endpoint', 'table', 'resource'
  file: string
  line: number
  metadata?: Record<string, unknown>
}

export interface ParsedEdge {
  from: string
  to: string
  type: string       // e.g., 'uses', 'depends', 'triggers', 'references', 'contains'
  metadata?: Record<string, unknown>
}

export interface ParserResult {
  nodes: ParsedNode[]
  edges: ParsedEdge[]
  file: string
  parser: string
}

export interface FileParser {
  /** Parser name (e.g., 'dockerfile', 'ci', 'yaml') */
  readonly name: string
  /** File extensions this parser handles (e.g., ['.yml', '.yaml']) */
  readonly extensions: string[]
  /** File name patterns this parser handles (e.g., 'Dockerfile') */
  readonly filePatterns?: string[]
  /** Parse a file and return nodes/edges, or null if not applicable */
  parse(filePath: string, content: string): ParserResult | null
}
