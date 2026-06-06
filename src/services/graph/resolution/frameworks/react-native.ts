/**
 * React Native cross-language bridge resolver.
 *
 * Closes the JS <-> native flow gap in React Native projects. Covers:
 *
 * **Legacy bridge** (older / still-prevalent in mid-tier RN libs):
 *   - ObjC: `RCT_EXPORT_MODULE([opt_name])` declares a module; the module
 *     name defaults to the class name minus an `RCT` prefix when no
 *     argument is given. `RCT_EXPORT_METHOD(selector:(args))` declares a
 *     JS-callable method whose JS name is the selector's first keyword.
 *     `RCT_REMAP_METHOD(jsName, nativeSelector:(args))` overrides the JS
 *     name explicitly.
 *   - Java/Kotlin: `@ReactMethod` annotated methods on a
 *     `ReactContextBaseJavaModule` subclass; the module name comes from
 *     `getName()` returning a literal string.
 *
 * **TurboModules** (modern, used by react-native-svg, screens, FBSDK):
 *   - TS spec interface declared in a `Native<X>.ts` file exporting
 *     `TurboModuleRegistry.getEnforcing<Spec>('<ModuleName>')` (or
 *     `.get<Spec>('<ModuleName>')`). The Spec interface methods are the
 *     JS-callable surface; the matching native implementation is a class
 *     whose method names match.
 *
 * Migrated from codegraph/src/resolution/frameworks/react-native.ts
 *
 * Source mapping:
 *  codegraph Node      → NodeMetadata (from GraphStore)
 *  n.filePath          → n.file
 *  n.startLine         → n.line
 *  n.endLine           → n.end_line
 *  n.qualifiedName     → n.qualified_name
 *  n.isExported        → n.is_exported
 *  n.updatedAt         → n.updated_at
 */

import type { NodeMetadata } from '../../GraphStore.js'
import type { FrameworkResolver, ResolutionContext, UnresolvedRef, ResolvedRef } from '../types.js'

// ─── Native-side extraction ─────────────────────────────────────────────────

/**
 * Default ObjC module name when `RCT_EXPORT_MODULE()` has no argument:
 * strip a leading `RCT` prefix from the class name (Apple's convention)
 * and treat the rest as the JS-visible module name.
 */
function defaultObjcModuleName(className: string): string {
  return className.startsWith('RCT') && className.length > 3
    ? className.slice(3)
    : className
}

/**
 * Parse an ObjC `.m`/`.mm` file's source for `RCT_EXPORT_MODULE` and
 * `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` declarations.
 */
function parseObjcRNExports(
  source: string,
  className: string | null
): Array<{ moduleName: string; jsName: string; nativeSelectorFirstKw: string }> {
  const results: Array<{ moduleName: string; jsName: string; nativeSelectorFirstKw: string }> = []

  const moduleMatch = source.match(/RCT_EXPORT_MODULE\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\)/)
  const moduleName =
    moduleMatch?.[1] ??
    (className ? defaultObjcModuleName(className) : null)
  if (!moduleName) return results

  const exportRegex = /RCT_EXPORT_METHOD\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = exportRegex.exec(source)) !== null) {
    const kw = m[1]
    if (kw) results.push({ moduleName, jsName: kw, nativeSelectorFirstKw: kw })
  }

  const remapRegex =
    /RCT_REMAP_METHOD\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/g
  while ((m = remapRegex.exec(source)) !== null) {
    const jsName = m[1]
    const nativeKw = m[2]
    if (jsName && nativeKw) {
      results.push({ moduleName, jsName, nativeSelectorFirstKw: nativeKw })
    }
  }

  return results
}

/**
 * Find the `@implementation` class name in an ObjC file.
 */
function findObjcClassName(source: string): string | null {
  const m = source.match(/@implementation\s+([A-Za-z_][A-Za-z0-9_]*)/)
  return m?.[1] ?? null
}

/**
 * Parse a Java/Kotlin source file for `@ReactMethod` annotated methods
 * and the surrounding class's `getName()` return value.
 */
function parseJvmRNExports(
  source: string
): Array<{ moduleName: string; jsName: string }> {
  const results: Array<{ moduleName: string; jsName: string }> = []

  const getName = source.match(
    /\bgetName\s*\([^)]*\)\s*(?::\s*String)?\s*(?:=\s*|\{[^}]*return\s*)"([^"]+)"/
  )
  const classMatch =
    source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*ReactContextBaseJavaModule/) ??
    source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*ReactPackage/)
  const moduleName =
    getName?.[1] ?? (classMatch?.[1] ? classMatch[1].replace(/Module$/, '') : null)
  if (!moduleName) return results

  const methodRegex =
    /@ReactMethod\b[^{]*?(?:\bfun\s+|\bvoid\s+|\bpublic\s+\w[\w<>\[\]]*\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = methodRegex.exec(source)) !== null) {
    const jsName = m[1]
    if (jsName) results.push({ moduleName, jsName })
  }

  return results
}

/**
 * Parse a TS file for a TurboModule spec declaration.
 */
function parseTurboModuleSpec(
  source: string
): { moduleName: string; methods: string[] } | null {
  const regMatch = source.match(
    /TurboModuleRegistry\.(?:getEnforcing|get)\s*<[^>]*>\s*\(\s*['"]([^'"]+)['"]\s*\)/
  )
  if (!regMatch || !regMatch[1]) return null
  const moduleName = regMatch[1]

  const ifaceMatch = source.match(
    /export\s+interface\s+Spec\b[^{]*\{([\s\S]*?)\n\}/
  )
  if (!ifaceMatch || !ifaceMatch[1]) return null
  const body = ifaceMatch[1]

  const methods: string[] = []
  const methodRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm
  let m: RegExpExecArray | null
  while ((m = methodRegex.exec(body)) !== null) {
    const name = m[1]
    if (name) methods.push(name)
  }
  return { moduleName, methods }
}

// ─── Map building ───────────────────────────────────────────────────────────

/**
 * RCTEventEmitter built-ins that every emitter subclass inherits. JS code
 * doesn't directly call these — they're internal plumbing. Skip during
 * map building to avoid false-positive resolution of unrelated
 * `addListener` / `remove` calls.
 */
const RN_EMITTER_BUILTINS = new Set([
  'addListener',
  'removeListeners',
  'remove',
  'invalidate',
  'startObserving',
  'stopObserving',
])

interface NativeMethod {
  moduleName: string
  jsName: string
  node: NodeMetadata
}

const nativeMethodMaps: WeakMap<
  ResolutionContext,
  { byJsName: Map<string, NativeMethod[]> }
> = new WeakMap()

function buildRNMaps(context: ResolutionContext): { byJsName: Map<string, NativeMethod[]> } {
  const cached = nativeMethodMaps.get(context)
  if (cached) return cached

  const byJsName = new Map<string, NativeMethod[]>()
  const allFiles = context.getAllFiles()

  const objcMethodsByFirstKw = new Map<string, NodeMetadata[]>()
  const jvmMethodsByName = new Map<string, NodeMetadata[]>()
  for (const node of context.getNodesByKind('method')) {
    if (node.language === 'objc') {
      const firstKw = node.name.includes(':') ? node.name.split(':')[0] : node.name
      if (firstKw) {
        const arr = objcMethodsByFirstKw.get(firstKw)
        if (arr) arr.push(node)
        else objcMethodsByFirstKw.set(firstKw, [node])
      }
    } else if (node.language === 'java' || node.language === 'kotlin') {
      const arr = jvmMethodsByName.get(node.name)
      if (arr) arr.push(node)
      else jvmMethodsByName.set(node.name, [node])
    }
  }

  for (const file of allFiles) {
    // Legacy bridge — ObjC side.
    if (file.endsWith('.m') || file.endsWith('.mm')) {
      const source = context.readFile(file)
      if (!source) continue
      const className = findObjcClassName(source)
      const exports = parseObjcRNExports(source, className)
      for (const exp of exports) {
        if (RN_EMITTER_BUILTINS.has(exp.jsName)) continue
        const candidates = objcMethodsByFirstKw.get(exp.nativeSelectorFirstKw) ?? []
        const node = candidates.find((c) => c.file === file) ?? candidates[0]
        if (!node) continue
        const entry: NativeMethod = { moduleName: exp.moduleName, jsName: exp.jsName, node }
        const arr = byJsName.get(exp.jsName)
        if (arr) arr.push(entry)
        else byJsName.set(exp.jsName, [entry])
      }
    }

    // Legacy bridge — Java/Kotlin side.
    if (file.endsWith('.java') || file.endsWith('.kt')) {
      const source = context.readFile(file)
      if (!source) continue
      const exports = parseJvmRNExports(source)
      for (const exp of exports) {
        if (RN_EMITTER_BUILTINS.has(exp.jsName)) continue
        const candidates = jvmMethodsByName.get(exp.jsName) ?? []
        const node = candidates.find((c) => c.file === file) ?? candidates[0]
        if (!node) continue
        const entry: NativeMethod = { moduleName: exp.moduleName, jsName: exp.jsName, node }
        const arr = byJsName.get(exp.jsName)
        if (arr) arr.push(entry)
        else byJsName.set(exp.jsName, [entry])
      }
    }

    // TurboModule spec — TS side.
    if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      const source = context.readFile(file)
      if (!source) continue
      const spec = parseTurboModuleSpec(source)
      if (!spec) continue
      for (const methodName of spec.methods) {
        if (RN_EMITTER_BUILTINS.has(methodName)) continue
        const objcCands = objcMethodsByFirstKw.get(methodName) ?? []
        const jvmCands = jvmMethodsByName.get(methodName) ?? []
        for (const node of [...objcCands, ...jvmCands]) {
          const entry: NativeMethod = { moduleName: spec.moduleName, jsName: methodName, node }
          const arr = byJsName.get(methodName)
          if (arr) arr.push(entry)
          else byJsName.set(methodName, [entry])
        }
      }
    }
  }

  const result = { byJsName }
  nativeMethodMaps.set(context, result)
  return result
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export const reactNativeBridgeResolver: FrameworkResolver = {
  name: 'react-native-bridge',
  languages: ['javascript', 'typescript', 'tsx', 'jsx'],

  /**
   * Detect: package.json depends on `react-native`, OR any source file
   * uses the `RCT_EXPORT_MODULE` / `TurboModuleRegistry` markers.
   */
  detect(context: ResolutionContext): boolean {
    const pkg = context.readFile('package.json')
    if (pkg && /["']react-native["']\s*:/.test(pkg)) return true
    const files = context.getAllFiles()
    for (let i = 0; i < Math.min(files.length, 200); i++) {
      const f = files[i]
      if (!f) continue
      if (f.endsWith('.mm') || f.endsWith('.m')) {
        const src = context.readFile(f)
        if (src && /RCT_EXPORT_MODULE\b/.test(src)) return true
      }
      if (f.endsWith('.ts') || f.endsWith('.tsx')) {
        const src = context.readFile(f)
        if (src && /TurboModuleRegistry\.(?:get|getEnforcing)\s*</.test(src)) return true
      }
    }
    return false
  },

  claimsReference(_name: string): boolean {
    return false
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (
      ref.language !== 'javascript' &&
      ref.language !== 'typescript' &&
      ref.language !== 'tsx' &&
      ref.language !== 'jsx'
    ) {
      return null
    }

    const name = ref.referenceName.includes('.')
      ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
      : ref.referenceName

    const maps = buildRNMaps(context)
    const entries = maps.byJsName.get(name)
    if (!entries || entries.length === 0) return null

    const objc = entries.find((e) => e.node.language === 'objc')
    const target = objc ?? entries[0]
    if (!target) return null
    return {
      original: ref,
      targetNodeId: target.node.id,
      confidence: 0.6,
      resolvedBy: 'framework',
    }
  },
}
