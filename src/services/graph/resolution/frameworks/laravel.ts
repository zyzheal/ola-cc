/**
 * Laravel Framework Resolver
 *
 * Handles Laravel-specific patterns for reference resolution.
 * Migrated from codegraph/src/resolution/frameworks/laravel.ts.
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
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types.js'
import { stripCommentsForRegex } from '../strip-comments.js'

export const FACADE_MAPPINGS: Record<string, string> = {
  Auth: 'Illuminate\\Auth\\AuthManager',
  Cache: 'Illuminate\\Cache\\CacheManager',
  Config: 'Illuminate\\Config\\Repository',
  DB: 'Illuminate\\Database\\DatabaseManager',
  Event: 'Illuminate\\Events\\Dispatcher',
  File: 'Illuminate\\Filesystem\\Filesystem',
  Gate: 'Illuminate\\Auth\\Access\\Gate',
  Hash: 'Illuminate\\Hashing\\HashManager',
  Log: 'Illuminate\\Log\\LogManager',
  Mail: 'Illuminate\\Mail\\Mailer',
  Queue: 'Illuminate\\Queue\\QueueManager',
  Redis: 'Illuminate\\Redis\\RedisManager',
  Request: 'Illuminate\\Http\\Request',
  Response: 'Illuminate\\Http\\Response',
  Route: 'Illuminate\\Routing\\Router',
  Session: 'Illuminate\\Session\\SessionManager',
  Storage: 'Illuminate\\Filesystem\\FilesystemManager',
  URL: 'Illuminate\\Routing\\UrlGenerator',
  Validator: 'Illuminate\\Validation\\Factory',
  View: 'Illuminate\\View\\Factory',
}

export const laravelResolver: FrameworkResolver = {
  name: 'laravel',
  languages: ['php'],

  detect(context: ResolutionContext): boolean {
    return context.fileExists('artisan') || context.fileExists('app/Http/Kernel.php')
  },

  claimsReference(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*Controller@\w+$/.test(name)
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Model::method() - Eloquent static calls
    const modelMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+)::(\w+)$/)
    if (modelMatch) {
      const [, className, methodName] = modelMatch
      const result = resolveModelCall(className!, methodName!, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' }
      }
    }

    // Pattern 2: Facade calls - Auth::user(), Cache::get()
    const facadeMatch = ref.referenceName.match(/^(Auth|Cache|DB|Log|Mail|Queue|Session|Storage|Validator|Route|Request|Response)::(\w+)$/)
    if (facadeMatch) {
      return null // External, can't resolve to local node
    }

    // Pattern 3: Helper function calls
    if (['route', 'view', 'config', 'env', 'app', 'abort', 'redirect', 'response', 'request', 'session', 'url', 'asset', 'mix'].includes(ref.referenceName)) {
      return null
    }

    // Pattern 4: Controller method references
    const controllerMatch = ref.referenceName.match(/^([A-Z][a-zA-Z]+Controller)@(\w+)$/)
    if (controllerMatch) {
      const [, controller, method] = controllerMatch
      const result = resolveControllerMethod(controller!, method!, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.9, resolvedBy: 'framework' }
      }
    }

    return null
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.php')) return { nodes: [], references: [] }
    const nodes: NodeMetadata[] = []
    const references: UnresolvedRef[] = []
    const now = Date.now()
    const safe = stripCommentsForRegex(content, 'php')

    // Route::METHOD('/path', handler-expr)
    const routeRegex = /Route::(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g
    let match: RegExpExecArray | null
    while ((match = routeRegex.exec(safe)) !== null) {
      const [, method, routePath, handlerExpr] = match
      const line = safe.slice(0, match.index).split('\n').length
      const upper = method!.toUpperCase()
      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:${upper}:${routePath}`,
        kind: 'route',
        name: `${upper} ${routePath}`,
        qualified_name: `${filePath}::route:${routePath}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: 'php',
        updated_at: now,
      }
      nodes.push(routeNode)

      const handlerName = extractLaravelHandler(handlerExpr!)
      if (handlerName) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: handlerName,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: 'php',
        })
      }
    }

    // Route::resource('name', Controller::class) / Route::apiResource
    const resourceRegex = /Route::(resource|apiResource)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^)]+))?\)/g
    while ((match = resourceRegex.exec(safe)) !== null) {
      const [, , resourceName, handlerExpr] = match
      const line = safe.slice(0, match.index).split('\n').length
      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:RESOURCE:${resourceName}`,
        kind: 'route',
        name: `resource:${resourceName}`,
        qualified_name: `${filePath}::route:${resourceName}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: 'php',
        updated_at: now,
      }
      nodes.push(routeNode)

      if (handlerExpr) {
        const controllerName = extractLaravelHandler(handlerExpr)
        if (controllerName) {
          references.push({
            fromNodeId: routeNode.id,
            referenceName: controllerName,
            referenceKind: 'imports',
            line,
            column: 0,
            filePath,
            language: 'php',
          })
        }
      }
    }

    return { nodes, references }
  },
}

// ------ Internal helpers ------

function extractLaravelHandler(expr: string): string | null {
  const trimmed = expr.trim()
  const short = (s: string) => s.split('\\').pop()!

  // [Class::class, 'method'] → Class@method
  const tupleMatch = trimmed.match(/^\[\s*([A-Za-z_\\][\w\\]*)::class\s*,\s*['"]([^'"]+)['"]\s*\]/)
  if (tupleMatch) return `${short(tupleMatch[1]!)}@${tupleMatch[2]!}`

  // 'Controller@method' → Controller@method
  const atMatch = trimmed.match(/^['"]([^'"@]+)@([^'"]+)['"]$/)
  if (atMatch) return `${short(atMatch[1]!)}@${atMatch[2]!}`

  // Class::class → Class
  const classMatch = trimmed.match(/^([A-Za-z_\\][\w\\]*)::class/)
  if (classMatch) return short(classMatch[1]!)

  return null
}

function resolveModelCall(
  className: string,
  methodName: string,
  context: ResolutionContext
): string | null {
  // Try app/Models/ first (Laravel 8+)
  let modelPath = `app/Models/${className}.php`
  if (context.fileExists(modelPath)) {
    const nodes = context.getNodesInFile(modelPath)
    const methodNode = nodes.find((n) => n.kind === 'method' && n.name === methodName)
    if (methodNode) return methodNode.id
    const classNode = nodes.find((n) => n.kind === 'class' && n.name === className)
    if (classNode) return classNode.id
  }

  // Try app/ (Laravel 7 and below)
  modelPath = `app/${className}.php`
  if (context.fileExists(modelPath)) {
    const nodes = context.getNodesInFile(modelPath)
    const methodNode = nodes.find((n) => n.kind === 'method' && n.name === methodName)
    if (methodNode) return methodNode.id
    const classNode = nodes.find((n) => n.kind === 'class' && n.name === className)
    if (classNode) return classNode.id
  }

  return null
}

function resolveControllerMethod(
  controller: string,
  method: string,
  context: ResolutionContext
): string | null {
  const controllerPath = `app/Http/Controllers/${controller}.php`
  if (context.fileExists(controllerPath)) {
    const nodes = context.getNodesInFile(controllerPath)
    const methodNode = nodes.find((n) => n.kind === 'method' && n.name === method)
    if (methodNode) return methodNode.id
  }

  const controllerCandidates = context.getNodesByName(controller)
  for (const ctrl of controllerCandidates) {
    if (ctrl.kind === 'class' && ctrl.file.includes('Controllers')) {
      const nodesInFile = context.getNodesInFile(ctrl.file)
      const methodNode = nodesInFile.find((n) => n.kind === 'method' && n.name === method)
      if (methodNode) return methodNode.id
    }
  }

  return null
}
