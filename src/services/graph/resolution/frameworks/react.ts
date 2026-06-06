/**
 * React Framework Resolver
 *
 * Handles React, Next.js, and React Router patterns.
 * Migrated from codegraph/src/resolution/frameworks/react.ts.
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
import type {
  FrameworkResolver,
  FrameworkExtractionResult,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types.js'

// ============================================================
// Resolver
// ============================================================

export const reactResolver: FrameworkResolver = {
  name: 'react',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    // Check for React in package.json
    const packageJson = context.readFile('package.json')
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson)
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        if (deps.react || deps.next || deps['react-native']) {
          return true
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .jsx/.tsx files
    const allFiles = context.getAllFiles()
    return allFiles.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'))
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Component references (PascalCase)
    if (isPascalCase(ref.referenceName) && !isBuiltInType(ref.referenceName)) {
      const result = resolveComponent(ref.referenceName, ref.filePath, context)
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        }
      }
    }

    // Pattern 2: Hook references (use*)
    if (ref.referenceName.startsWith('use') && ref.referenceName.length > 3) {
      const result = resolveHook(ref.referenceName, context)
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        }
      }
    }

    // Pattern 3: Context references
    if (ref.referenceName.endsWith('Context') || ref.referenceName.endsWith('Provider')) {
      const result = resolveContext(ref.referenceName, context)
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        }
      }
    }

    return null
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const nodes: NodeMetadata[] = []
    const references: UnresolvedRef[] = []
    const now = Date.now()

    // ----------------------------------------------------------
    // Extract component definitions
    // ----------------------------------------------------------
    const componentPatterns = [
      // Function components: function Foo(
      /(?:export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g,
      // Arrow function components: const Foo = (...) =>
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_]*)\s*=>/g,
      // forwardRef components: const Foo = forwardRef / React.forwardRef
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?forwardRef/g,
      // memo components: const Foo = memo / React.memo
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?memo/g,
    ]

    for (const pattern of componentPatterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(content)) !== null) {
        const [fullMatch, name] = match
        const line = content.slice(0, match.index).split('\n').length

        // Check if it returns JSX (rough heuristic)
        const afterMatch = content.slice(
          match.index + fullMatch.length,
          match.index + fullMatch.length + 500,
        )
        const hasJSX =
          afterMatch.includes('<') && (afterMatch.includes('/>') || afterMatch.includes('</'))

        if (hasJSX) {
          nodes.push({
            id: `component:${filePath}:${name}:${line}`,
            kind: 'component',
            name: name!,
            qualified_name: `${filePath}::${name}`,
            file: filePath,
            line,
            end_line: line,
            start_column: 0,
            end_column: fullMatch.length,
            language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
            is_exported: fullMatch.includes('export'),
            updated_at: now,
          })
        }
      }
    }

    // ----------------------------------------------------------
    // Extract custom hooks
    // ----------------------------------------------------------
    const hookPattern = /(?:export\s+)?(?:function|const|let)\s+(use[A-Z][a-zA-Z0-9]*)\s*[=(]/g
    let hookMatch: RegExpExecArray | null
    while ((hookMatch = hookPattern.exec(content)) !== null) {
      const [fullMatch, name] = hookMatch
      const line = content.slice(0, hookMatch.index).split('\n').length

      nodes.push({
        id: `hook:${filePath}:${name}:${line}`,
        kind: 'function',
        name: name!,
        qualified_name: `${filePath}::${name}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: fullMatch.length,
        language:
          filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript',
        is_exported: fullMatch.includes('export'),
        updated_at: now,
      })
    }

    // ----------------------------------------------------------
    // React Router: <Route path="/x" component={Comp}/> (v5) or
    // <Route path="/x" element={<Comp/>}/> (v6)
    // ----------------------------------------------------------
    const routeTagRegex = /<Route\b/g
    let routeMatch: RegExpExecArray | null
    while ((routeMatch = routeTagRegex.exec(content)) !== null) {
      const win = content.slice(routeMatch.index, routeMatch.index + 400)
      const pathMatch = win.match(/\bpath\s*=\s*["']([^"']+)["']/)
      if (!pathMatch) continue // index/layout routes without a path
      const routePath = pathMatch[1]!
      const compMatch =
        win.match(/\bcomponent\s*=\s*\{\s*([A-Z][A-Za-z0-9_]*)/) ||
        win.match(/\belement\s*=\s*\{\s*<\s*([A-Z][A-Za-z0-9_]*)/)
      const line = content.slice(0, routeMatch.index).split('\n').length
      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:${routePath}`,
        kind: 'route',
        name: routePath,
        qualified_name: `${filePath}::route:${routePath}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: 0,
        language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
        updated_at: now,
      }
      nodes.push(routeNode)
      if (compMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: compMatch[1]!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
        })
      }
    }

    // ----------------------------------------------------------
    // React Router data-router (v6.4+): createBrowserRouter([...])
    // ----------------------------------------------------------
    if (
      /\b(?:createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements)\b/.test(
        content,
      )
    ) {
      const objPathRe = /\bpath\s*:\s*['"]([^'"]*)['"]/g
      let om: RegExpExecArray | null
      while ((om = objPathRe.exec(content)) !== null) {
        const win = content.slice(om.index, om.index + 300)
        const compMatch =
          win.match(/\belement\s*:\s*<\s*([A-Z][A-Za-z0-9_]*)/) ||
          win.match(/\bComponent\s*:\s*([A-Z][A-Za-z0-9_]*)/)
        if (!compMatch) continue
        const routePath = om[1] || '/'
        const line = content.slice(0, om.index).split('\n').length
        const routeNode: NodeMetadata = {
          id: `route:${filePath}:${line}:${routePath}`,
          kind: 'route',
          name: routePath,
          qualified_name: `${filePath}::route:${routePath}`,
          file: filePath,
          line,
          end_line: line,
          start_column: 0,
          end_column: 0,
          language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
          updated_at: now,
        }
        nodes.push(routeNode)
        references.push({
          fromNodeId: routeNode.id,
          referenceName: compMatch[1]!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
        })
      }
    }

    // ----------------------------------------------------------
    // Next.js pages/routes (pages directory convention)
    // ----------------------------------------------------------
    if (filePath.includes('pages/') || filePath.includes('app/')) {
      if (content.includes('export default')) {
        const routePath = filePathToRoute(filePath)
        if (routePath) {
          const line = content.indexOf('export default')
          const lineNum = content.slice(0, line).split('\n').length

          nodes.push({
            id: `route:${filePath}:${routePath}:${lineNum}`,
            kind: 'route',
            name: routePath,
            qualified_name: `${filePath}::route:${routePath}`,
            file: filePath,
            line: lineNum,
            end_line: lineNum,
            start_column: 0,
            end_column: 0,
            language: filePath.endsWith('.tsx')
              ? 'tsx'
              : filePath.endsWith('.ts')
                ? 'typescript'
                : 'javascript',
            updated_at: now,
          })
        }
      }
    }

    return { nodes, references }
  },
}

// ============================================================
// Helpers
// ============================================================

function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str)
}

function isBuiltInType(name: string): boolean {
  return BUILT_IN_TYPES.has(name)
}

const BUILT_IN_TYPES = new Set([
  'Array',
  'Boolean',
  'Date',
  'Error',
  'Function',
  'JSON',
  'Math',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'String',
  'Symbol',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'React',
  'Component',
  'Fragment',
  'Suspense',
  'StrictMode',
])

const COMPONENT_KINDS = new Set(['component', 'function', 'class'])

const COMPONENT_DIRS = [
  '/components/',
  '/src/components/',
  '/app/components/',
  '/pages/',
  '/src/pages/',
  '/views/',
  '/src/views/',
]

const HOOK_DIRS = ['/hooks/', '/src/hooks/', '/lib/hooks/', '/utils/hooks/']

const CONTEXT_DIRS = [
  '/context/',
  '/contexts/',
  '/src/context/',
  '/src/contexts/',
  '/providers/',
  '/src/providers/',
]

/**
 * Resolve a component reference using name-based lookup
 */
function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name)
  if (candidates.length === 0) return null

  const components = candidates.filter((n) => COMPONENT_KINDS.has(n.kind))
  if (components.length === 0) return null

  // Prefer same directory
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'))
  const sameDir = components.filter((n) => n.file.startsWith(fromDir))
  if (sameDir.length > 0) return sameDir[0]!.id

  // Prefer component directories
  const preferred = components.filter((n) => COMPONENT_DIRS.some((d) => n.file.includes(d)))
  if (preferred.length > 0) return preferred[0]!.id

  return components[0]!.id
}

/**
 * Resolve a custom hook reference using name-based lookup
 */
function resolveHook(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name)
  if (candidates.length === 0) return null

  const hooks = candidates.filter((n) => n.kind === 'function' && n.name.startsWith('use'))
  if (hooks.length === 0) return null

  // Prefer hooks directories
  const preferred = hooks.filter((n) => HOOK_DIRS.some((d) => n.file.includes(d)))
  if (preferred.length > 0) return preferred[0]!.id

  return hooks[0]!.id
}

/**
 * Resolve a context reference using name-based lookup
 */
function resolveContext(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name)
  if (candidates.length === 0) {
    // Try without Context/Provider suffix
    const baseName = name.replace(/Context$|Provider$/, '')
    if (baseName !== name) {
      const baseCandidates = context.getNodesByName(baseName)
      if (baseCandidates.length > 0) return baseCandidates[0]!.id
    }
    return null
  }

  // Prefer context directories
  const preferred = candidates.filter((n) => CONTEXT_DIRS.some((d) => n.file.includes(d)))
  if (preferred.length > 0) return preferred[0]!.id

  return candidates[0]!.id
}

/**
 * Convert file path to Next.js route
 */
function filePathToRoute(filePath: string): string | null {
  const base = filePath.split('/').pop() ?? ''
  if (!/\.(tsx?|jsx?)$/.test(base)) return null
  if (base.startsWith('_') || /\.config\.[a-z]+$/.test(base)) return null

  if (/(?:^|\/)pages\//.test(filePath)) {
    let route = filePath
      .replace(/^.*pages\//, '/')
      .replace(/\/index\.(tsx?|jsx?)$/, '')
      .replace(/\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1')

    if (route === '') route = '/'
    return route
  }

  if (/(?:^|\/)app\//.test(filePath)) {
    // App router - only page.tsx files are routes
    if (!filePath.includes('page.')) {
      return null
    }

    let route = filePath
      .replace(/^.*app\//, '/')
      .replace(/\/page\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1')

    if (route === '') route = '/'
    return route
  }

  return null
}
