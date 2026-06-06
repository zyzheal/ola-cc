/**
 * Play Framework (Scala/Java) resolver.
 *
 * Play declares HTTP routes in a dedicated `conf/routes` file (and included
 * `conf/*.routes`), Rails-style:
 *
 *   GET   /computers        controllers.Application.list(p: Int ?= 0)
 *   POST  /computers        controllers.Application.save
 *   GET   /assets/*file     controllers.Assets.versioned(path = "/public", file: Asset)
 *
 * Migrated from codegraph/src/resolution/frameworks/play.ts.
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

import type { NodeMetadata } from '../../GraphStore.js'
import type {
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types.js'

const ROUTE_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(.+)$/
const METHOD_KINDS = new Set(['method', 'function'])
const CLASS_KINDS = new Set(['class'])

/**
 * Check if a file path is a Play routes file.
 * Inlined from codegraph's grammars.ts (isPlayRoutesFile).
 */
function isPlayRoutesFile(filePath: string): boolean {
  // Play routes file: `conf/routes` or `conf/*.routes` (no extension)
  if (filePath === 'conf/routes') return true
  if (/^conf\/[^/]+\.routes$/.test(filePath)) return true
  return false
}

export const playResolver: FrameworkResolver = {
  name: 'play',
  languages: ['scala', 'java', 'yaml'],

  detect(context: ResolutionContext): boolean {
    const buildSbt = context.readFile('build.sbt')
    if (buildSbt && /playframework|"play"|sbt-plugin|PlayScala|PlayJava/i.test(buildSbt)) return true
    if (context.fileExists('conf/routes')) return true
    if (context.fileExists('conf/application.conf')) return true
    return false
  },

  claimsReference(name: string): boolean {
    return /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(name)
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const m = ref.referenceName.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/)
    if (!m) return null
    const [, className, methodName] = m
    const classNodes = context.getNodesByName(className!).filter((n) => CLASS_KINDS.has(n.kind))
    for (const cls of classNodes) {
      const method = context
        .getNodesInFile(cls.file)
        .find((n) => METHOD_KINDS.has(n.kind) && n.name === methodName)
      if (method) {
        return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' }
      }
    }
    return null
  },

  extract(filePath: string, content: string): { nodes: NodeMetadata[]; references: UnresolvedRef[] } {
    if (!isPlayRoutesFile(filePath)) return { nodes: [], references: [] }
    const nodes: NodeMetadata[] = []
    const references: UnresolvedRef[] = []
    const now = Date.now()

    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (!line || line.startsWith('#') || line.startsWith('->')) continue
      const m = line.match(ROUTE_LINE)
      if (!m) continue
      const [, method, routePath, action] = m

      // action: `controllers.Application.list(p: Int ?= 0)` → drop args, keep last 2 segments
      const fqn = action!.split('(')[0]!.trim()
      const parts = fqn.split('.').filter(Boolean)
      if (parts.length < 2) continue
      const handlerRef = parts.slice(-2).join('.')

      const lineNum = i + 1
      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${lineNum}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualified_name: `${filePath}::${method}:${routePath}`,
        file: filePath,
        line: lineNum,
        end_line: lineNum,
        start_column: 0,
        end_column: 0,
        language: 'scala',
        updated_at: now,
      }
      nodes.push(routeNode)
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerRef,
        referenceKind: 'references',
        line: lineNum,
        column: 0,
        filePath,
        language: 'scala',
      })
    }

    return { nodes, references }
  },
}
