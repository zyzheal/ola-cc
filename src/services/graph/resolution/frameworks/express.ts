/**
 * Express/Node.js Framework Resolver
 *
 * Handles Express and general Node.js patterns.
 * Migrated from codegraph/src/resolution/frameworks/express.ts.
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
  FrameworkExtractionResult,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types.js'
import { stripCommentsForRegex } from '../strip-comments.js'

function extractTailIdent(expr: string): string | null {
  const cleaned = expr.replace(/\s+/g, '').replace(/\(\)$/, '')
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/)
  return m ? m[1]! : null
}

function matchDelim(s: string, open: number, oc: string, cc: string): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch
      i++
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++ }
      continue
    }
    if (ch === oc) depth++
    else if (ch === cc) { depth--; if (depth === 0) return i }
  }
  return -1
}

const RESERVED_CALLS = new Set([
  'json', 'jsonp', 'send', 'sendStatus', 'sendFile', 'status', 'end', 'redirect',
  'render', 'set', 'get', 'header', 'type', 'format', 'attachment', 'download',
  'cookie', 'clearCookie', 'append', 'location', 'vary', 'links', 'accepts', 'is',
  'next', 'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race',
  'map', 'filter', 'forEach', 'reduce', 'find', 'push', 'pop', 'slice', 'splice',
  'includes', 'keys', 'values', 'entries', 'assign', 'parse', 'stringify',
  'log', 'error', 'warn', 'info', 'String', 'Number', 'Boolean', 'Array', 'Object',
  'Date', 'Math', 'JSON', 'Promise', 'require', 'fail', 'redirect',
])

export const expressResolver: FrameworkResolver = {
  name: 'express',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json')
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson)
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        if (deps.express || deps.fastify || deps.koa || deps.hapi) {
          return true
        }
      } catch {
        // Invalid JSON
      }
    }

    const allFiles = context.getAllFiles()
    for (const file of allFiles) {
      if (
        file.includes('routes') ||
        file.includes('controllers') ||
        file.includes('middleware')
      ) {
        const content = context.readFile(file)
        if (content && (content.includes('express') || content.includes('app.get') || content.includes('router.get'))) {
          return true
        }
      }
    }

    return false
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Middleware references
    if (isMiddlewareName(ref.referenceName)) {
      const result = resolveMiddleware(ref.referenceName, context)
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        }
      }
    }

    // Pattern 2: Controller method references
    const controllerMatch = ref.referenceName.match(/^(\w+)Controller\.(\w+)$/)
    if (controllerMatch) {
      const [, controller, method] = controllerMatch
      const result = resolveControllerMethod(controller!, method!, context)
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        }
      }
    }

    // Pattern 3: Service/helper references
    const serviceMatch = ref.referenceName.match(/^(\w+)(Service|Helper|Utils?)\.(\w+)$/)
    if (serviceMatch) {
      const [, name, suffix, method] = serviceMatch
      const result = resolveServiceMethod(name! + suffix!, method!, context)
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
    if (!/\.(m?js|tsx?|cjs)$/.test(filePath)) return { nodes: [], references: [] }
    const nodes: NodeMetadata[] = []
    const references: UnresolvedRef[] = []
    const now = Date.now()
    const lang = detectLanguage(filePath)
    const safe = stripCommentsForRegex(content, lang)
    const head = /\b(app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]\s*,/g
    let match: RegExpExecArray | null
    while ((match = head.exec(safe)) !== null) {
      const method = match[2]!
      const routePath = match[3]!
      if (method === 'use' && !routePath.startsWith('/')) continue
      const line = safe.slice(0, match.index).split('\n').length
      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:${method.toUpperCase()}:${routePath}`,
        kind: 'route',
        name: `${method.toUpperCase()} ${routePath}`,
        qualified_name: `${filePath}::${method.toUpperCase()}:${routePath}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: lang,
        updated_at: now,
      }
      nodes.push(routeNode)

      const openParen = safe.indexOf('(', match.index)
      const closeParen = openParen >= 0 ? matchDelim(safe, openParen, '(', ')') : -1
      const args = closeParen > openParen ? safe.slice(openParen + 1, closeParen) : ''
      const arrowAt = args.indexOf('=>')

      if (arrowAt >= 0) {
        const afterArrow = args.slice(arrowAt + 2)
        const braceAt = afterArrow.indexOf('{')
        let body = afterArrow
        if (braceAt >= 0 && afterArrow.slice(0, braceAt).trim() === '') {
          const end = matchDelim(afterArrow, braceAt, '{', '}')
          if (end > braceAt) body = afterArrow.slice(braceAt + 1, end)
        }
        const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g
        const seen = new Set<string>()
        let cm: RegExpExecArray | null
        while ((cm = callRe.exec(body)) !== null) {
          const name = cm[1]!
          if (seen.has(name) || RESERVED_CALLS.has(name)) continue
          seen.add(name)
          references.push({
            fromNodeId: routeNode.id,
            referenceName: name,
            referenceKind: 'calls',
            line,
            column: 0,
            filePath,
            language: lang,
          })
        }
      } else {
        const parts = args.split(',').map((s) => s.trim()).filter(Boolean)
        const last = parts[parts.length - 1]
        const handlerName = last ? extractTailIdent(last) : null
        if (handlerName) {
          references.push({
            fromNodeId: routeNode.id,
            referenceName: handlerName,
            referenceKind: 'references',
            line,
            column: 0,
            filePath,
            language: lang,
          })
        }
      }
    }
    return { nodes, references }
  },
}

function isMiddlewareName(name: string): boolean {
  const middlewarePatterns = [
    /^auth$/i,
    /^authenticate$/i,
    /^authorization$/i,
    /^validate/i,
    /^sanitize/i,
    /^rateLimit/i,
    /^cors$/i,
    /^helmet$/i,
    /^logger$/i,
    /^errorHandler$/i,
    /^notFound$/i,
    /Middleware$/i,
  ]
  return middlewarePatterns.some((p) => p.test(name))
}

function resolveMiddleware(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name)
  const match = candidates.find((n) =>
    n.name.toLowerCase() === name.toLowerCase() ||
    n.name.toLowerCase() === name.replace(/Middleware$/i, '').toLowerCase()
  )
  if (match) return match.id

  const baseName = name.replace(/Middleware$/i, '')
  if (baseName !== name) {
    const baseCandidates = context.getNodesByName(baseName)
    const MIDDLEWARE_DIRS = ['/middleware/', '/middlewares/']
    const preferred = baseCandidates.filter((n) =>
      MIDDLEWARE_DIRS.some((d) => n.file.includes(d))
    )
    if (preferred.length > 0) return preferred[0]!.id
    if (baseCandidates.length > 0) return baseCandidates[0]!.id
  }

  return null
}

function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  const methodCandidates = context.getNodesByName(method)
  const methodNodes = methodCandidates.filter(
    (n) => (n.kind === 'method' || n.kind === 'function') &&
      n.file.toLowerCase().includes(controller.toLowerCase())
  )
  if (methodNodes.length > 0) return methodNodes[0]!.id

  const controllerName = controller + 'Controller'
  const controllerCandidates = context.getNodesByName(controllerName)
  for (const ctrl of controllerCandidates) {
    const nodesInFile = context.getNodesInFile(ctrl.file)
    const methodNode = nodesInFile.find(
      (n) => (n.kind === 'method' || n.kind === 'function') && n.name === method
    )
    if (methodNode) return methodNode.id
  }

  return null
}

function resolveServiceMethod(
  serviceName: string,
  method: string,
  context: ResolutionContext
): string | null {
  const methodCandidates = context.getNodesByName(method)
  const stripped = serviceName.replace(/(Service|Helper|Utils?)$/i, '').toLowerCase()
  const methodNodes = methodCandidates.filter(
    (n) => (n.kind === 'method' || n.kind === 'function') &&
      n.file.toLowerCase().includes(stripped)
  )
  if (methodNodes.length > 0) return methodNodes[0]!.id
  return null
}

function detectLanguage(filePath: string): 'typescript' | 'javascript' {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript'
  return 'javascript'
}
