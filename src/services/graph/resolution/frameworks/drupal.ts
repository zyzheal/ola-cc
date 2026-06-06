/**
 * Drupal Framework Resolver
 *
 * Supports Drupal 8/9/10/11 (Composer-based projects). Drupal 7 is not supported.
 * Migrated from codegraph/src/resolution/frameworks/drupal.ts.
 *
 * Source mapping:
 *  codegraph Node      → NodeMetadata (from GraphStore)
 *  n.filePath          → n.file
 *  n.startLine         → n.line
 *  n.endLine           → n.end_line
 *  n.qualifiedName     → n.qualified_name
 *  n.updatedAt         → n.updated_at
 *  n.startColumn       → n.start_column
 *  n.endColumn         → n.end_column
 */

import { createHash } from 'crypto'
import type { NodeMetadata } from '../../GraphStore.js'
import type {
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic node ID matching the tree-sitter extraction format.
 * Inlined from codegraph's tree-sitter-helpers.ts.
 */
function generateNodeId(filePath: string, kind: string, name: string, line: number): string {
  return createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32)
}

function lastSegment(fqcn: string): string | null {
  const clean = fqcn.replace(/^\\+/, '').trim()
  if (!clean.includes('\\')) return null
  const parts = clean.split('\\')
  return parts[parts.length - 1] ?? null
}

function moduleNameFromPath(filePath: string): string | null {
  // Handles both `dir/name.module` and `name.module` (root-level)
  const match = filePath.match(/(?:^|\/)([^/]+)\.[^./]+$/)
  return match ? match[1]! : null
}

// ---------------------------------------------------------------------------
// Route extraction helpers
// ---------------------------------------------------------------------------

function extractDrupalRoutes(
  filePath: string,
  content: string
): { nodes: NodeMetadata[]; references: UnresolvedRef[] } {
  const nodes: NodeMetadata[] = []
  const references: UnresolvedRef[] = []
  const now = Date.now()

  const lines = content.split('\n')

  type PendingRoute = { name: string; lineNum: number }
  let pending: PendingRoute | null = null
  let currentPath: string | null = null
  let handlerRefs: string[] = []
  let methods: string[] = []

  const flushRoute = () => {
    if (!pending || !currentPath) return

    const methodTag = methods.length > 0 ? ` [${methods.join(',')}]` : ''
    const routeNode: NodeMetadata = {
      id: `route:${filePath}:${pending.lineNum}:${currentPath}`,
      kind: 'route',
      name: `${currentPath}${methodTag}`,
      qualified_name: `${filePath}::${pending.name}`,
      file: filePath,
      line: pending.lineNum,
      end_line: pending.lineNum,
      start_column: 0,
      end_column: 0,
      language: 'yaml',
      updated_at: now,
    }
    nodes.push(routeNode)

    for (const handler of handlerRefs) {
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handler,
        referenceKind: 'references',
        line: pending.lineNum,
        column: 0,
        filePath,
        language: 'yaml',
      })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith('#')) continue

    // Top-level route name: no leading whitespace, ends with a colon
    if (/^\S.*:\s*$/.test(line) && !/^\s/.test(line)) {
      flushRoute()
      pending = { name: trimmed.slice(0, -1).trim(), lineNum: i + 1 }
      currentPath = null
      handlerRefs = []
      methods = []
      continue
    }

    const pathMatch = trimmed.match(/^path:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/)
    if (pathMatch) {
      currentPath = pathMatch[1]!.trim()
      continue
    }

    const controllerMatch = trimmed.match(/^_controller:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/)
    if (controllerMatch) {
      handlerRefs.push(controllerMatch[1]!.trim())
      continue
    }

    const formMatch = trimmed.match(/^_form:\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/)
    if (formMatch) {
      handlerRefs.push(formMatch[1]!.trim())
      continue
    }

    const entityMatch = trimmed.match(/^_(entity_form|entity_list|entity_view):\s*['"]?([^'"#\n]+?)['"]?\s*(?:#.*)?$/)
    if (entityMatch) {
      handlerRefs.push(entityMatch[2]!.trim())
      continue
    }

    const methodsMatch = trimmed.match(/^methods:\s*\[([^\]]+)\]/)
    if (methodsMatch) {
      methods = methodsMatch[1]!.split(',').map((m) => m.trim().toUpperCase()).filter(Boolean)
      continue
    }
  }

  flushRoute()
  return { nodes, references }
}

// ---------------------------------------------------------------------------
// Hook detection helpers
// ---------------------------------------------------------------------------

const HOOK_FILE_EXTENSIONS = ['.module', '.install', '.theme', '.inc']

function isDrupalHookFile(filePath: string): boolean {
  return HOOK_FILE_EXTENSIONS.some((ext) => filePath.endsWith(ext))
}

function extractDrupalHooks(
  filePath: string,
  content: string
): { nodes: NodeMetadata[]; references: UnresolvedRef[] } {
  const references: UnresolvedRef[] = []

  const funcLineMap = new Map<string, number>()
  const funcDef = /^function\s+(\w+)\s*\(/gm
  let fm: RegExpExecArray | null
  while ((fm = funcDef.exec(content)) !== null) {
    const name = fm[1]!
    if (!funcLineMap.has(name)) {
      funcLineMap.set(name, content.slice(0, fm.index).split('\n').length)
    }
  }

  const emitHookRef = (hookName: string, funcName: string) => {
    const lineNum = funcLineMap.get(funcName)
    if (lineNum === undefined) return
    const nodeId = generateNodeId(filePath, 'function', funcName, lineNum)
    references.push({
      fromNodeId: nodeId,
      referenceName: hookName,
      referenceKind: 'references',
      line: lineNum,
      column: 0,
      filePath,
      language: 'php',
    })
  }

  // Strategy A: docblock `Implements hook_X().`
  const docblockPattern =
    /\/\*\*[\s\S]*?(?:@|\*\s+)Implements\s+(hook_\w+)\s*\(\)[\s\S]*?\*\/\s*\n(?:\s*\n)*function\s+(\w+)\s*\(/g
  const docblockMatched = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = docblockPattern.exec(content)) !== null) {
    const [, hookName, funcName] = match
    emitHookRef(hookName!, funcName!)
    docblockMatched.add(funcName!)
  }

  // Strategy B: name-pattern fallback
  const moduleName = moduleNameFromPath(filePath)
  if (moduleName) {
    const prefix = moduleName + '_'
    for (const [funcName] of funcLineMap) {
      if (docblockMatched.has(funcName)) continue
      if (!funcName.startsWith(prefix)) continue
      const hookSuffix = funcName.slice(prefix.length)
      if (!hookSuffix) continue
      emitHookRef(`hook_${hookSuffix}`, funcName)
    }
  }

  return { nodes: [], references }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export const drupalResolver: FrameworkResolver = {
  name: 'drupal',
  languages: ['php', 'yaml'],

  claimsReference(name: string): boolean {
    return (
      name.startsWith('hook_') ||
      name.includes('\\') ||
      /^[A-Za-z_]\w*::?\w+$/.test(name)
    )
  },

  detect(context: ResolutionContext): boolean {
    const composer = context.readFile('composer.json')
    if (composer) {
      try {
        const json = JSON.parse(composer) as {
          name?: string
          type?: string
          require?: Record<string, string>
          'require-dev'?: Record<string, string>
        }
        if (typeof json.name === 'string' && json.name.startsWith('drupal/')) return true
        if (typeof json.type === 'string' && json.type.startsWith('drupal-')) return true
        const deps = { ...json.require, ...(json['require-dev'] ?? {}) }
        if (Object.keys(deps).some((k) => k.startsWith('drupal/'))) return true
      } catch {
        // malformed composer.json
      }
    }

    const files = context.getAllFiles()
    const hasInfoYml = files.some((f) => f.endsWith('.info.yml'))
    if (!hasInfoYml) return false
    return files.some(
      (f) =>
        f.endsWith('.routing.yml') ||
        f.endsWith('.module') ||
        f.endsWith('.install') ||
        f.endsWith('.theme')
    )
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName

    // _controller: '\Drupal\...\ClassName::methodName' or single-colon form
    const controllerMatch = name.match(/^\\?(?:Drupal\\[^:]+\\)?([^\\:]+):{1,2}(\w+)$/)
    if (controllerMatch) {
      const [, className, methodName] = controllerMatch
      const classNodes = context.getNodesByName(className!)
      for (const cls of classNodes) {
        if (cls.kind !== 'class') continue
        const fileNodes = context.getNodesInFile(cls.file)
        const method = fileNodes.find((n) => n.kind === 'method' && n.name === methodName)
        if (method) {
          return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' }
        }
        return { original: ref, targetNodeId: cls.id, confidence: 0.7, resolvedBy: 'framework' }
      }
    }

    // _form / _entity_form: bare FQCN
    if (name.includes('\\') && !name.includes(':')) {
      const className = lastSegment(name)
      if (className) {
        const classNodes = context.getNodesByName(className)
        const cls = classNodes.find((n) => n.kind === 'class')
        if (cls) {
          return { original: ref, targetNodeId: cls.id, confidence: 0.85, resolvedBy: 'framework' }
        }
      }
    }

    // hook_X
    if (name.startsWith('hook_')) {
      const hookSuffix = name.slice(5)
      const candidates = context.getNodesByKind('function').filter(
        (n) => n.name.endsWith(`_${hookSuffix}`) && isDrupalHookFile(n.file)
      )
      if (candidates.length > 0) {
        return {
          original: ref,
          targetNodeId: candidates[0]!.id,
          confidence: 0.75,
          resolvedBy: 'framework',
        }
      }
    }

    return null
  },

  extract(filePath: string, content: string): { nodes: NodeMetadata[]; references: UnresolvedRef[] } {
    if (filePath.endsWith('.routing.yml')) {
      return extractDrupalRoutes(filePath, content)
    }

    if (isDrupalHookFile(filePath) || filePath.endsWith('.php')) {
      return extractDrupalHooks(filePath, content)
    }

    return { nodes: [], references: [] }
  },
}
