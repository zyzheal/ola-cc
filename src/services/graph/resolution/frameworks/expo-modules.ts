/**
 * Expo Modules framework resolver — close the JS -> native flow for Expo SDK
 * packages.
 *
 * Expo Modules use a Swift / Kotlin DSL distinct from the React Native legacy
 * bridge. Each native module is a class extending `Module` whose
 * `definition()` body declares the JS surface via literal `Name(...)`,
 * `Function(...)`, `AsyncFunction(...)`, `Property(...)`, and `View {...}`
 * calls.
 *
 * This framework extractor walks the file source for those declarative
 * literals and emits method nodes attributed to the Swift / Kotlin file.
 *
 * Migrated from codegraph/src/resolution/frameworks/expo-modules.ts
 *
 * Source mapping:
 *  codegraph Node      → NodeMetadata (from GraphStore)
 *  n.filePath          → n.file
 *  n.startLine         → n.line
 *  n.endLine           → n.end_line
 *  n.qualifiedName     → n.qualified_name
 *  n.isExported        → n.is_exported
 *  n.updatedAt         → n.updated_at
 *  n.startColumn       → n.start_column
 *  n.endColumn         → n.end_column
 */

import type { NodeMetadata } from '../../GraphStore.js'
import type { FrameworkResolver, FrameworkExtractionResult, ResolutionContext } from '../types.js'

// ─── Regex patterns ─────────────────────────────────────────────────────────

/**
 * Match `Function("name")`, `AsyncFunction("name")`, or `Property("name")`
 * at the start of an expression.
 */
const EXPO_DECL_RE =
  /\b(Function|AsyncFunction|Property|Constants)\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g

/**
 * Match the module name literal `Name("ExpoX")`.
 */
const EXPO_MODULE_NAME_RE = /\bName\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/

/**
 * Heuristic class-name match — `class XxxModule: Module` (Swift) or
 * `class XxxModule : Module` (Kotlin).
 */
const EXPO_CLASS_RE =
  /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Module\b/

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Detect whether a file is plausibly an Expo Module — looking for both
 * the `: Module` inheritance and at least one declarative DSL literal.
 */
function isExpoModuleSource(source: string): boolean {
  if (!EXPO_CLASS_RE.test(source)) return false
  EXPO_DECL_RE.lastIndex = 0
  return EXPO_DECL_RE.test(source)
}

/**
 * Extract Expo Module method declarations from a Swift / Kotlin source file.
 */
function extractExpoMethods(filePath: string, source: string, language: 'swift' | 'kotlin'): NodeMetadata[] {
  if (!isExpoModuleSource(source)) return []
  const nodes: NodeMetadata[] = []

  const nameMatch = source.match(EXPO_MODULE_NAME_RE)
  const classMatch = source.match(EXPO_CLASS_RE)
  const moduleName = nameMatch?.[1] ?? classMatch?.[1] ?? 'ExpoModule'

  const now = Date.now()
  const seenAtLine = new Set<string>()
  EXPO_DECL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXPO_DECL_RE.exec(source)) !== null) {
    const kind = m[1]!
    const methodName = m[2]!
    const before = source.slice(0, m.index)
    const startLine = before.split('\n').length
    const dedupKey = `${methodName}:${startLine}`
    if (seenAtLine.has(dedupKey)) continue
    seenAtLine.add(dedupKey)

    const startColumn = before.length - before.lastIndexOf('\n') - 1
    nodes.push({
      id: `expo-module:${filePath}:${moduleName}:${methodName}:${startLine}`,
      kind: 'method',
      name: methodName,
      qualified_name: `${filePath}::${moduleName}.${methodName}`,
      file: filePath,
      language,
      line: startLine,
      end_line: startLine,
      start_column: startColumn,
      end_column: startColumn + kind.length + 2 + methodName.length + 2,
      docstring: `Expo Modules ${kind}("${methodName}") in ${moduleName}`,
      signature: `${kind}("${methodName}")`,
      is_exported: true,
      updated_at: now,
    })
  }

  return nodes
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export const expoModulesResolver: FrameworkResolver = {
  name: 'expo-modules',
  languages: ['swift', 'kotlin'],

  detect(context: ResolutionContext): boolean {
    const pkg = context.readFile('package.json')
    if (pkg && /["']expo-modules-core["']\s*:/.test(pkg)) return true
    const files = context.getAllFiles()
    for (let i = 0; i < Math.min(files.length, 200); i++) {
      const f = files[i]
      if (!f) continue
      if (f.endsWith('.swift') || f.endsWith('.kt')) {
        const src = context.readFile(f)
        if (src && isExpoModuleSource(src)) return true
      }
    }
    return false
  },

  extract(filePath: string, source: string): FrameworkExtractionResult {
    const language = filePath.endsWith('.kt') ? 'kotlin' : 'swift'
    return {
      nodes: extractExpoMethods(filePath, source, language),
      references: [],
    }
  },

  resolve() {
    return null
  },
}
