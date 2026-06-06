/**
 * Tree-sitter Extraction Types
 *
 * Re-exports from types.ts for backward compatibility.
 * The canonical type definitions live in types.ts.
 */

export type {
  Language,
  SyntaxNode,
  ExtractionNode,
  ExtractionEdge,
  UnresolvedRef,
  ExtractionError,
  ExtractionResult,
  ImportInfo,
  VariableInfo,
  ExtractorContext,
  LanguageExtractor,
} from './types.js'
