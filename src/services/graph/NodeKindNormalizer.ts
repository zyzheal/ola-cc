/**
 * NodeKindNormalizer — normalize LLM-output node kind values
 *
 * LLMs frequently output abbreviated or variant kind names (fn, cls, proc, etc.).
 * This module normalizes them to the canonical set used by GraphStore/SemanticModel.
 *
 * Design doc: Phase 6a — EdgeKind Mapping Verification + NodeKind Normalization
 */

// ============================================================
// Canonical kinds (the "truth" set)
// ============================================================

/** All valid canonical node kinds */
export const VALID_KINDS: readonly string[] = [
  // Type-like
  'class', 'interface', 'enum', 'type',
  'union', 'mixin', 'type_alias',
  // Method-like
  'function', 'method', 'constructor', 'getter', 'setter',
  'operator', 'lambda', 'closure', 'procedure', 'destructor',
  // Field-like
  'field', 'property', 'variable', 'constant', 'parameter',
  'enum_variant',
  // Module-like
  'module', 'namespace',
  // Decorator-like
  'decorator', 'annotation', 'macro',
  // Infrastructure
  'endpoint', 'service', 'middleware',
  'config', 'interface_field', 'schema',
  // Generic fallback
  'unknown',
] as const

const VALID_KIND_SET = new Set<string>(VALID_KINDS)

// ============================================================
// Alias map (LLM variant → canonical)
// ============================================================

const KIND_ALIASES: Record<string, string> = {
  // Abbreviations
  fn: 'function',
  func: 'function',
  cls: 'class',
  mod: 'module',
  ns: 'namespace',
  iface: 'interface',
  intf: 'interface',
  enum_type: 'enum',
  const: 'constant',
  var: 'variable',
  param: 'parameter',
  proc: 'procedure',
  comp: 'component',
  ctor: 'constructor',
  dtor: 'destructor',
  prop: 'property',
  deco: 'decorator',
  annot: 'annotation',
  // Language-specific → canonical
  struct: 'class',       // Rust/C: struct ≈ class
  trait: 'interface',    // Rust: trait ≈ interface
  protocol: 'interface', // Swift: protocol ≈ interface
  impl: 'method',        // Rust impl block → method
  class_method: 'method',
  instance_method: 'method',
  static_method: 'method',
  // Route/endpoint variants
  route: 'endpoint',
  handler: 'endpoint',
  controller: 'endpoint',
  // Type aliases
  typedef: 'type_alias',
  typealias: 'type_alias',
  using: 'type_alias',
  // Module variants
  package: 'module',
  component: 'module',
  // Misc
  accessor: 'getter',
  mutator: 'setter',
  indexer: 'property',
  delegate: 'function',
  callback: 'function',
  coroutine: 'function',
  async_function: 'function',
  generator: 'function',
  iterator: 'function',
  resolver: 'function',
  factory: 'function',
  builder: 'class',
  singleton: 'class',
  record: 'class',
  data_class: 'class',
  value_object: 'class',
  entity: 'class',
  aggregate: 'class',
  vo: 'class',
  dto: 'class',
  // Infrastructure aliases
  svc: 'service',
  mw: 'middleware',
  cfg: 'config',
  conf: 'config',
}

// ============================================================
// Public API
// ============================================================

/**
 * Normalize a kind string to its canonical form.
 *
 * Steps:
 * 1. Trim + lowercase
 * 2. Check alias map → return canonical
 * 3. Check if already canonical → return as-is
 * 4. Unknown → return 'unknown'
 */
export function normalizeKind(kind: string): string {
  if (!kind || typeof kind !== 'string') return 'unknown'

  const lower = kind.trim().toLowerCase()
  if (!lower) return 'unknown'

  // Check alias map first (use Object.hasOwn to avoid prototype collisions like 'constructor')
  if (Object.hasOwn(KIND_ALIASES, lower)) return KIND_ALIASES[lower]

  // Check if already a canonical kind
  if (VALID_KIND_SET.has(lower)) return lower

  // Fuzzy: strip common prefixes/suffixes
  const stripped = lower
    .replace(/^(abstract_|virtual_|inline_|async_|sync_)/, '')
    .replace(/(_type|_def|_declaration|_node)$/, '')

  if (VALID_KIND_SET.has(stripped)) return stripped
  if (Object.hasOwn(KIND_ALIASES, stripped)) return KIND_ALIASES[stripped]

  return 'unknown'
}

/**
 * Check if a kind string is a valid canonical kind (case-insensitive).
 */
export function isValidKind(kind: string): boolean {
  if (!kind || typeof kind !== 'string') return false
  return VALID_KIND_SET.has(kind.trim().toLowerCase())
}

/**
 * Get the full alias map (for diagnostics / codegraph_kind_map operation).
 */
export function getKindAliases(): Record<string, string> {
  return { ...KIND_ALIASES }
}
