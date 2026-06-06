/**
 * React Native Fabric / Codegen view components resolver.
 *
 * In the new RN architecture, JS-visible view components are declared via
 * Codegen TS spec files of the shape:
 *
 *   import { codegenNativeComponent } from 'react-native';
 *   import type { ViewProps } from 'react-native';
 *   export interface NativeProps extends ViewProps { color?: string; }
 *   export default codegenNativeComponent<NativeProps>('MyComponent');
 *
 * This resolver also handles legacy Paper view-manager declarations via
 * RCT_EXPORT_VIEW_PROPERTY macros in ObjC and @ReactProp annotations in
 * Java/Kotlin.
 *
 * Migrated from codegraph/src/resolution/frameworks/fabric.ts
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

const CODEGEN_DECL_RE =
  /codegenNativeComponent\s*(?:<[^>]+>)?\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g

/**
 * Legacy Paper view manager macros — RCT_EXPORT_VIEW_PROPERTY,
 * RCT_CUSTOM_VIEW_PROPERTY, RCT_REMAP_VIEW_PROPERTY.
 * Capture the FIRST argument — that's the JS-visible prop name.
 */
const RCT_VIEW_PROP_RE =
  /\bRCT_(?:EXPORT|CUSTOM|REMAP)_VIEW_PROPERTY\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * ObjC `@implementation Foo` extraction.
 */
const OBJC_IMPL_RE = /@implementation\s+([A-Za-z_][A-Za-z0-9_]*)/

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Derive the JS-visible component name from a native ViewManager class.
 * Strip a trailing `Manager` (and optionally `ViewManager`), and a leading
 * `RCT` prefix.
 */
function deriveComponentNameFromManager(className: string): string {
  let name = className.startsWith('RCT') ? className.slice(3) : className
  if (name.endsWith('ViewManager')) name = name.slice(0, -'ViewManager'.length)
  else if (name.endsWith('Manager')) name = name.slice(0, -'Manager'.length)
  return name
}

/**
 * Cheap source-level detector — must contain `codegenNativeComponent` to
 * be worth parsing.
 */
function isFabricSpec(source: string): boolean {
  return source.includes('codegenNativeComponent')
}

/**
 * Pull the `NativeProps` interface body out of a Fabric spec source.
 */
function findNativePropsBody(source: string): string | null {
  const m = source.match(/export\s+interface\s+NativeProps\b[^{]*\{([\s\S]*?)\n\}/)
  return m?.[1] ?? null
}

/**
 * Parse the NativeProps interface body and return prop names.
 */
function extractPropNames(body: string): string[] {
  const props: string[] = []
  const regex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm
  let m: RegExpExecArray | null
  while ((m = regex.exec(body)) !== null) {
    const name = m[1]!
    // Only skip actual method declarations: `name(` without `?:` before `(`.
    // Props like `onTap?: () => void` should NOT be skipped — the `(` is in
    // the type annotation, not a method signature.
    const fullMatch = m[0]
    if (!fullMatch.includes('?') && !fullMatch.includes(':')) {
      // Check if this looks like `name(` — a method declaration
      const afterName = body.slice(m.index + name.length, m.index + name.length + 20)
      if (/^\s*\(/.test(afterName)) continue
    }
    props.push(name)
  }
  return props
}

// ─── Extractors ─────────────────────────────────────────────────────────────

/**
 * Extract Fabric Codegen component and property nodes from a TS/TSX spec file.
 */
function extractFabricNodes(filePath: string, source: string): NodeMetadata[] {
  if (!isFabricSpec(source)) return []

  const now = Date.now()
  const nodes: NodeMetadata[] = []

  CODEGEN_DECL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CODEGEN_DECL_RE.exec(source)) !== null) {
    const componentName = m[1]!
    const before = source.slice(0, m.index)
    const startLine = before.split('\n').length
    const startColumn = before.length - before.lastIndexOf('\n') - 1

    const componentId = `fabric-component:${filePath}:${componentName}:${startLine}`
    nodes.push({
      id: componentId,
      kind: 'component',
      name: componentName,
      qualified_name: `${filePath}::${componentName}`,
      file: filePath,
      language: filePath.endsWith('.tsx') ? 'tsx' : 'typescript',
      line: startLine,
      end_line: startLine,
      start_column: startColumn,
      end_column: startColumn + 'codegenNativeComponent'.length,
      docstring: `Fabric/Codegen native component '${componentName}'`,
      signature: `codegenNativeComponent<NativeProps>('${componentName}')`,
      is_exported: true,
      updated_at: now,
    })
  }

  // Props from the NativeProps interface
  const body = findNativePropsBody(source)
  if (body) {
    const props = extractPropNames(body)
    for (const propName of props) {
      const propBefore = source.indexOf(propName, source.indexOf(body))
      const propLine =
        propBefore >= 0 ? source.slice(0, propBefore).split('\n').length : 1
      nodes.push({
        id: `fabric-prop:${filePath}:${propName}:${propLine}`,
        kind: 'property',
        name: propName,
        qualified_name: `${filePath}::NativeProps.${propName}`,
        file: filePath,
        language: filePath.endsWith('.tsx') ? 'tsx' : 'typescript',
        line: propLine,
        end_line: propLine,
        start_column: 0,
        end_column: propName.length,
        docstring: `Fabric NativeProps prop '${propName}'`,
        is_exported: true,
        updated_at: now,
      })
    }
  }

  return nodes
}

/**
 * Extract legacy Paper view-manager declarations from a .m/.mm file.
 */
function extractLegacyViewManagerNodes(filePath: string, source: string): NodeMetadata[] {
  if (!source.includes('RCT_EXPORT_VIEW_PROPERTY') &&
      !source.includes('RCT_CUSTOM_VIEW_PROPERTY') &&
      !source.includes('RCT_REMAP_VIEW_PROPERTY')) {
    return []
  }
  const implMatch = source.match(OBJC_IMPL_RE)
  if (!implMatch || !implMatch[1]) return []
  const className = implMatch[1]
  if (!className.endsWith('Manager') && !className.endsWith('ViewManager')) return []
  const componentName = deriveComponentNameFromManager(className)
  if (!componentName) return []

  const now = Date.now()
  const nodes: NodeMetadata[] = []

  const before = source.slice(0, implMatch.index ?? 0)
  const startLine = before.split('\n').length
  nodes.push({
    id: `fabric-component:${filePath}:${componentName}:${startLine}`,
    kind: 'component',
    name: componentName,
    qualified_name: `${filePath}::${componentName}`,
    file: filePath,
    language: 'objc',
    line: startLine,
    end_line: startLine,
    start_column: 0,
    end_column: componentName.length,
    docstring: `Legacy Paper ViewManager component '${componentName}' (from @implementation ${className})`,
    signature: `RCT_EXPORT_MODULE() // ViewManager: ${className}`,
    is_exported: true,
    updated_at: now,
  })

  // Property nodes per RCT_EXPORT_VIEW_PROPERTY macro.
  const seen = new Set<string>()
  RCT_VIEW_PROP_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RCT_VIEW_PROP_RE.exec(source)) !== null) {
    const propName = m[1]!
    if (seen.has(propName)) continue
    seen.add(propName)
    const propBefore = source.slice(0, m.index)
    const propLine = propBefore.split('\n').length
    nodes.push({
      id: `fabric-prop:${filePath}:${propName}:${propLine}`,
      kind: 'property',
      name: propName,
      qualified_name: `${filePath}::${componentName}.${propName}`,
      file: filePath,
      language: 'objc',
      line: propLine,
      end_line: propLine,
      start_column: 0,
      end_column: propName.length,
      docstring: `Legacy Paper view prop '${propName}' on ${componentName}`,
      is_exported: true,
      updated_at: now,
    })
  }
  return nodes
}

/**
 * Java/Kotlin `@ReactProp("name")` extraction.
 */
function extractJvmViewManagerNodes(filePath: string, source: string): NodeMetadata[] {
  if (!source.includes('@ReactProp')) return []

  const classMatch = source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/)
  if (!classMatch || !classMatch[1]) return []
  const className = classMatch[1]
  if (!className.endsWith('Manager') && !className.endsWith('ViewManager')) return []
  const componentName = deriveComponentNameFromManager(className)
  if (!componentName) return []

  const language: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java'
  const now = Date.now()
  const nodes: NodeMetadata[] = []

  const classBefore = source.slice(0, classMatch.index ?? 0)
  const startLine = classBefore.split('\n').length
  nodes.push({
    id: `fabric-component:${filePath}:${componentName}:${startLine}`,
    kind: 'component',
    name: componentName,
    qualified_name: `${filePath}::${componentName}`,
    file: filePath,
    language,
    line: startLine,
    end_line: startLine,
    start_column: 0,
    end_column: componentName.length,
    docstring: `Android view-manager component '${componentName}' (from class ${className})`,
    signature: `class ${className} : ViewManager`,
    is_exported: true,
    updated_at: now,
  })

  const REACT_PROP_RE = /@ReactProp\s*\(\s*(?:name\s*=\s*)?"([^"]+)"/g
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = REACT_PROP_RE.exec(source)) !== null) {
    const propName = m[1]!
    if (seen.has(propName)) continue
    seen.add(propName)
    const propBefore = source.slice(0, m.index)
    const propLine = propBefore.split('\n').length
    nodes.push({
      id: `fabric-prop:${filePath}:${propName}:${propLine}`,
      kind: 'property',
      name: propName,
      qualified_name: `${filePath}::${componentName}.${propName}`,
      file: filePath,
      language,
      line: propLine,
      end_line: propLine,
      start_column: 0,
      end_column: propName.length,
      docstring: `Android @ReactProp prop '${propName}' on ${componentName}`,
      is_exported: true,
      updated_at: now,
    })
  }
  return nodes
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export const fabricViewResolver: FrameworkResolver = {
  name: 'fabric-view',
  languages: ['typescript', 'tsx', 'objc', 'java', 'kotlin'],

  detect(context: ResolutionContext): boolean {
    const checkPkg = (relativePath: string) => {
      const pkg = context.readFile(relativePath)
      return pkg ? /["']react-native["']\s*:/.test(pkg) : false
    }
    if (checkPkg('package.json')) return true
    const list = context.listDirectories
    if (!list) return false
    for (const root of ['packages', 'apps', 'modules', 'libraries']) {
      for (const sub of list(root) ?? []) {
        if (checkPkg(`${root}/${sub}/package.json`)) return true
      }
    }
    return false
  },

  extract(filePath: string, source: string): FrameworkExtractionResult {
    let nodes: NodeMetadata[] = []
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      nodes = extractFabricNodes(filePath, source)
    } else if (filePath.endsWith('.m') || filePath.endsWith('.mm')) {
      nodes = extractLegacyViewManagerNodes(filePath, source)
    } else if (filePath.endsWith('.java') || filePath.endsWith('.kt')) {
      nodes = extractJvmViewManagerNodes(filePath, source)
    }
    return { nodes, references: [] }
  },

  resolve() {
    return null
  },
}
