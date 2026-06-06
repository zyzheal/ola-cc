/**
 * Python Framework Resolver
 *
 * Handles Django, Flask, and FastAPI patterns.
 * Migrated from codegraph/src/resolution/frameworks/python.ts.
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

export const djangoResolver: FrameworkResolver = {
  name: 'django',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt')
    if (requirements && requirements.toLowerCase().includes('django')) return true
    const setup = context.readFile('setup.py')
    if (setup && setup.toLowerCase().includes('django')) return true
    const pyproject = context.readFile('pyproject.toml')
    if (pyproject && pyproject.toLowerCase().includes('django')) return true
    return context.fileExists('manage.py')
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('Model') || /^[A-Z][a-z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, MODEL_DIRS, context)
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' }
    }
    if (ref.referenceName.endsWith('View') || ref.referenceName.endsWith('ViewSet')) {
      const result = resolveByNameAndKind(ref.referenceName, VIEW_KINDS, VIEW_DIRS, context)
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' }
    }
    if (ref.referenceName.endsWith('Form')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, FORM_DIRS, context)
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' }
    }
    // ORM dynamic dispatch: QuerySet._fetch_all calls self._iterable_class(self)
    if (ref.referenceName === '_iterable_class') {
      const target = resolveModelIterableIter(context)
      if (target) return { original: ref, targetNodeId: target, confidence: 0.7, resolvedBy: 'framework' }
    }
    return null
  },

  claimsReference(name) {
    return name === '_iterable_class'
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] }

    const nodes: NodeMetadata[] = []
    const references: UnresolvedRef[] = []
    const now = Date.now()
    const safe = stripCommentsForRegex(content, 'python')

    // path('url', handler, name=...) / re_path(r'...', handler) / url(r'...', handler)
    const routeRegex = /\b(path|re_path|url)\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([\w.]+(?:\s*\([^)]*\))?)/g

    let match: RegExpExecArray | null
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, , urlPath, handlerExpr] = match
      const line = safe.slice(0, match.index).split('\n').length

      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:${urlPath}`,
        kind: 'route',
        name: urlPath!,
        qualified_name: `${filePath}::route:${urlPath}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: 'python',
        updated_at: now,
      }
      nodes.push(routeNode)

      const handler = handlerExpr!.trim()
      const target = resolveHandlerName(handler)
      if (target) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: target.name,
          referenceKind: target.kind,
          line,
          column: 0,
          filePath,
          language: 'python',
        })
      }
    }

    // DRF router registration: `router.register(r'articles', ArticleViewSet)`
    const routerRegex = /\.register\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([\w.]+)/g
    while ((match = routerRegex.exec(safe)) !== null) {
      const prefix = match[1]!.replace(/^\^|\/?\$$/g, '')
      const viewset = match[2]!.split('.').pop()!
      if (!/View(Set)?$/.test(viewset)) continue
      const line = safe.slice(0, match.index).split('\n').length
      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:VIEWSET:${prefix}`,
        kind: 'route',
        name: `VIEWSET /${prefix}`,
        qualified_name: `${filePath}::route:${prefix}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: 'python',
        updated_at: now,
      }
      nodes.push(routeNode)
      references.push({
        fromNodeId: routeNode.id,
        referenceName: viewset,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      })
    }

    return { nodes, references }
  },
}

function resolveModelIterableIter(context: ResolutionContext): string | null {
  const cls = context.getNodesByName('ModelIterable').find((n) => n.kind === 'class')
  if (!cls) return null
  const iter = context.getNodesByName('__iter__').find(
    (n) => n.file === cls.file && n.line >= cls.line && n.line <= cls.end_line
  )
  return iter ? iter.id : null
}

function resolveHandlerName(expr: string): { name: string; kind: 'references' | 'imports' } | null {
  const includeMatch = expr.match(/^include\s*\(\s*['"]([^'"]+)['"]/)
  if (includeMatch) return { name: includeMatch[1]!, kind: 'imports' }

  let head = expr.replace(/\.as_view\s*\([^)]*\)\s*$/, '')
  head = head.replace(/\.\w+\s*\([^)]*\)\s*$/, '')

  const dotted = head.split('.').filter(Boolean)
  if (dotted.length === 0) return null
  const last = dotted[dotted.length - 1]!
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return null

  return { name: last, kind: 'references' }
}

export const flaskResolver: FrameworkResolver = {
  name: 'flask',
  languages: ['python'],

  detect(context) {
    for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']) {
      const c = context.readFile(f)
      if (c && /\bflask\b/i.test(c)) return true
    }
    const entrypoints = context
      .getAllFiles()
      .filter((f) => /(?:^|\/)(app|application|main|wsgi|__init__)\.py$/.test(f))
      .slice(0, 50)
    for (const f of entrypoints) {
      const c = context.readFile(f)
      if (c && /\bFlask\s*\(/.test(c) && /\bimport\s+flask\b|\bfrom\s+flask\b/.test(c)) return true
    }
    return false
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('_bp') || ref.referenceName.endsWith('_blueprint')) {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, [], context)
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' }
    }
    return null
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] }
    const safe = stripCommentsForRegex(content, 'python')
    const decorator = extractDecoratorRoutes(filePath, safe, {
      decoratorRegex: /@(\w+)\.route\s*\(\s*['"]([^'"]*)['"](?:\s*,\s*methods\s*=\s*[[(]([^\])]+)[\])])?\s*\)/g,
      defaultMethod: 'GET',
      methodFromGroup: 3,
      pathGroup: 2,
      findHandler: true,
      language: 'python',
    })
    const restful = extractFlaskRestful(filePath, safe)
    return {
      nodes: [...decorator.nodes, ...restful.nodes],
      references: [...decorator.references, ...restful.references],
    }
  },
}

export const fastapiResolver: FrameworkResolver = {
  name: 'fastapi',
  languages: ['python'],

  detect(context) {
    const requirements = context.readFile('requirements.txt')
    if (requirements && /\bfastapi\b/i.test(requirements)) return true
    const pyproject = context.readFile('pyproject.toml')
    if (pyproject && /\bfastapi\b/i.test(pyproject)) return true
    for (const file of ['app.py', 'main.py', 'api.py']) {
      const content = context.readFile(file)
      if (content && content.includes('FastAPI(')) return true
    }
    return false
  },

  resolve(ref, context) {
    if (ref.referenceName.endsWith('_router') || ref.referenceName === 'router') {
      const result = resolveByNameAndKind(ref.referenceName, VARIABLE_KINDS, ROUTER_DIRS, context)
      if (result) return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' }
    }
    if (ref.referenceName.startsWith('get_') || ref.referenceName.startsWith('Depends')) {
      const result = resolveByNameAndKind(ref.referenceName, FUNCTION_KINDS, DEP_DIRS, context)
      if (result) return { original: ref, targetNodeId: result, confidence: 0.75, resolvedBy: 'framework' }
    }
    return null
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.py')) return { nodes: [], references: [] }
    return extractDecoratorRoutes(filePath, stripCommentsForRegex(content, 'python'), {
      decoratorRegex: /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]*)['"]/g,
      defaultMethod: '',
      methodGroup: 2,
      pathGroup: 3,
      findHandler: true,
      language: 'python',
    })
  },
}

// ------ Internal helpers ------

interface DecoratorRouteOpts {
  decoratorRegex: RegExp
  defaultMethod: string
  methodGroup?: number
  methodFromGroup?: number
  pathGroup: number
  handlerGroup?: number
  findHandler?: boolean
  language: 'python'
}

function extractDecoratorRoutes(filePath: string, content: string, opts: DecoratorRouteOpts): FrameworkExtractionResult {
  const nodes: NodeMetadata[] = []
  const references: UnresolvedRef[] = []
  const now = Date.now()
  let match: RegExpExecArray | null
  while ((match = opts.decoratorRegex.exec(content)) !== null) {
    const routePath = match[opts.pathGroup]
    let method = opts.defaultMethod
    if (opts.methodGroup && match[opts.methodGroup]) {
      method = match[opts.methodGroup]!.toUpperCase()
    } else if (opts.methodFromGroup && match[opts.methodFromGroup]) {
      const m = match[opts.methodFromGroup]!.match(/['"]([A-Z]+)['"]/i)
      if (m) method = m[1]!.toUpperCase()
    }
    const line = content.slice(0, match.index).split('\n').length
    const name = method ? `${method} ${routePath || '/'}` : (routePath || '/')
    const routeNode: NodeMetadata = {
      id: `route:${filePath}:${line}:${method}:${routePath}`,
      kind: 'route',
      name,
      qualified_name: `${filePath}::${method}:${routePath}`,
      file: filePath,
      line,
      end_line: line,
      start_column: 0,
      end_column: match[0].length,
      language: opts.language,
      updated_at: now,
    }
    nodes.push(routeNode)

    let handlerName: string | undefined
    if (opts.handlerGroup && match[opts.handlerGroup]) {
      handlerName = match[opts.handlerGroup]
    } else if (opts.findHandler) {
      const tail = content.slice(match.index + match[0].length)
      const defMatch = tail.match(/\n\s*(?:async\s+)?def\s+(\w+)/)
      if (defMatch) handlerName = defMatch[1]
    }
    if (handlerName) {
      references.push({
        fromNodeId: routeNode.id,
        referenceName: handlerName,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      })
    }
  }
  return { nodes, references }
}

function extractFlaskRestful(filePath: string, safe: string): FrameworkExtractionResult {
  const nodes: NodeMetadata[] = []
  const references: UnresolvedRef[] = []
  const now = Date.now()
  const re = /\.add\w*[Rr]esource\s*\(\s*(\w+)\s*,\s*((?:['"][^'"]+['"]\s*,?\s*)+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(safe)) !== null) {
    const className = m[1]!
    const paths = (m[2]!.match(/['"]([^'"]+)['"]/g) || []).map((s) => s.slice(1, -1))
    const line = safe.slice(0, m.index).split('\n').length
    for (const routePath of paths) {
      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:ANY:${routePath}`,
        kind: 'route',
        name: `ANY ${routePath}`,
        qualified_name: `${filePath}::ANY:${routePath}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: 0,
        language: 'python',
        updated_at: now,
      }
      nodes.push(routeNode)
      references.push({
        fromNodeId: routeNode.id,
        referenceName: className,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      })
    }
  }
  return { nodes, references }
}

const MODEL_DIRS = ['models', 'app/models', 'src/models']
const VIEW_DIRS = ['views', 'app/views', 'src/views', 'api/views']
const FORM_DIRS = ['forms', 'app/forms', 'src/forms']
const ROUTER_DIRS = ['/routers/', '/api/', '/routes/', '/endpoints/']
const DEP_DIRS = ['/dependencies/', '/deps/', '/core/']

const CLASS_KINDS = new Set(['class'])
const VIEW_KINDS = new Set(['class', 'function'])
const VARIABLE_KINDS = new Set(['variable'])
const FUNCTION_KINDS = new Set(['function'])

function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name)
  if (candidates.length === 0) return null

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind))
  if (kindFiltered.length === 0) return null

  if (preferredDirPatterns.length > 0) {
    const preferred = kindFiltered.filter((n) =>
      preferredDirPatterns.some((d) => n.file.includes(d))
    )
    if (preferred.length > 0) return preferred[0]!.id
  }

  return kindFiltered[0]!.id
}
