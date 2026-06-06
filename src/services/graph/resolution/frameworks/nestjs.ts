/**
 * NestJS Framework Resolver
 *
 * Handles NestJS decorator-based routing across its transport layers:
 *   - HTTP:          @Controller(prefix) + @Get/@Post/@Put/@Patch/@Delete/@Head/@Options/@All
 *   - GraphQL:       @Resolver + @Query/@Mutation/@Subscription
 *   - Microservices: @MessagePattern / @EventPattern
 *   - WebSockets:    @WebSocketGateway(namespace) + @SubscribeMessage(event)
 *
 * Migrated from codegraph/src/resolution/frameworks/nestjs.ts.
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

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

type JsLang = 'typescript' | 'javascript'

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All']
const GQL_OPS = ['Query', 'Mutation', 'Subscription']

export const nestjsResolver: FrameworkResolver = {
  name: 'nestjs',
  languages: ['typescript', 'javascript'],

  detect(context: ResolutionContext): boolean {
    // Primary, fast path: any @nestjs/* dependency in package.json.
    const packageJson = context.readFile('package.json')
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson)
        const deps = { ...pkg.dependencies, ...pkg.devDependencies }
        if (Object.keys(deps).some((k) => k.startsWith('@nestjs/'))) {
          return true
        }
      } catch {
        // Invalid JSON — fall through to the source scan.
      }
    }

    // Fallback: NestJS-specific decorators in conventionally named files.
    const allFiles = context.getAllFiles()
    for (const file of allFiles) {
      if (
        file.endsWith('.controller.ts') ||
        file.endsWith('.controller.js') ||
        file.endsWith('.module.ts') ||
        file.endsWith('.resolver.ts') ||
        file.endsWith('.gateway.ts')
      ) {
        const content = context.readFile(file)
        if (
          content &&
          (content.includes('@nestjs/') ||
            content.includes('@Controller') ||
            content.includes('@Module(') ||
            content.includes('@Resolver(') ||
            content.includes('@WebSocketGateway('))
        ) {
          return true
        }
      }
    }

    return false
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Resolve provider/controller references (e.g. constructor-injected
    // `UsersService`) to their class, preferring the Nest file-name
    // convention (`*.service.ts`, `*.controller.ts`, …).
    for (const [suffix, convention] of PROVIDER_CONVENTIONS) {
      if (!suffix.test(ref.referenceName)) continue
      const candidates = context
        .getNodesByName(ref.referenceName)
        .filter((n) => n.kind === 'class')
      if (candidates.length === 0) return null
      const preferred = candidates.find((n) => n.file.includes(convention))
      const target = preferred ?? candidates[0]!
      return {
        original: ref,
        targetNodeId: target.id,
        confidence: preferred ? 0.85 : 0.7,
        resolvedBy: 'framework',
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

    const addRoute = (
      index: number,
      method: string,
      path: string,
      length: number,
      handler: string | null
    ): void => {
      const line = lineAt(safe, index)
      const node: NodeMetadata = {
        id: `route:${filePath}:${line}:${method}:${path}`,
        kind: 'route',
        name: `${method} ${path}`,
        qualified_name: `${filePath}::${method}:${path}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: length,
        language: lang,
        updated_at: now,
      }
      nodes.push(node)
      if (handler) {
        references.push({
          fromNodeId: node.id,
          referenceName: handler,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        })
      }
    }

    const scopes = buildClassScopes(safe)

    // HTTP routes: method decorator path joined onto the enclosing controller's prefix.
    for (const hit of findDecorators(safe, HTTP_METHODS)) {
      const scope = scopeFor(scopes, hit.index)
      const prefix = scope && scope.kind === 'controller' ? scope.prefix : ''
      const path = joinHttpPath(prefix, parseStringArg(hit.args))
      addRoute(hit.index, hit.name.toUpperCase(), path, hit.length, methodNameAfter(safe, hit.end))
    }

    // GraphQL operations: only inside an @Resolver class
    for (const hit of findDecorators(safe, GQL_OPS)) {
      const scope = scopeFor(scopes, hit.index)
      if (!scope || scope.kind !== 'resolver') continue
      const handler = methodNameAfter(safe, hit.end)
      const name = parseGraphqlName(hit.args, handler)
      addRoute(hit.index, hit.name.toUpperCase(), name, hit.length, handler)
    }

    // Microservice message/event handlers.
    for (const hit of findDecorators(safe, ['MessagePattern', 'EventPattern'])) {
      const verb = hit.name === 'EventPattern' ? 'EVENT' : 'MESSAGE'
      const handler = methodNameAfter(safe, hit.end)
      addRoute(hit.index, verb, parseStringArg(hit.args) || handler || '', hit.length, handler)
    }

    // WebSocket message handlers
    for (const hit of findDecorators(safe, ['SubscribeMessage'])) {
      const scope = scopeFor(scopes, hit.index)
      const namespace = scope && scope.kind === 'gateway' ? scope.prefix : ''
      const handler = methodNameAfter(safe, hit.end)
      const event = parseStringArg(hit.args) || handler || ''
      addRoute(hit.index, 'WS', namespace ? `${namespace}:${event}` : event, hit.length, handler)
    }

    return { nodes, references }
  },

  /**
   * Cross-file finalization for RouterModule.register([...]).
   */
  postExtract(context: ResolutionContext): NodeMetadata[] {
    const moduleToPrefix = new Map<string, string>()
    const controllerToModule = new Map<string, string>()

    for (const filePath of context.getAllFiles()) {
      if (!/\.module\.(m?[jt]s|cjs)$/.test(filePath)) continue
      const content = context.readFile(filePath)
      if (!content) continue
      const safe = stripCommentsForRegex(content, detectLanguage(filePath))
      collectRouterModuleRegistrations(safe, moduleToPrefix)
      collectModuleControllers(safe, controllerToModule)
    }

    const controllerToPrefix = new Map<string, string>()
    for (const [controller, module] of controllerToModule) {
      const prefix = moduleToPrefix.get(module)
      if (prefix && prefix !== '' && prefix !== '/') {
        controllerToPrefix.set(controller, prefix)
      }
    }

    if (controllerToPrefix.size === 0) return []

    const updates: NodeMetadata[] = []
    for (const [controllerName, prefix] of controllerToPrefix) {
      const classes = context
        .getNodesByName(controllerName)
        .filter((n) => n.kind === 'class')
      for (const cls of classes) {
        const routes = context
          .getNodesInFile(cls.file)
          .filter((n) => n.kind === 'route')
        for (const route of routes) {
          if (route.line < cls.line || route.line > (cls.end_line ?? cls.line)) {
            continue
          }
          const updated = applyModulePrefix(route, prefix)
          if (updated && updated.name !== route.name) updates.push(updated)
        }
      }
    }

    return updates
  },
}

// ---------------------------------------------------------------------------
// Provider resolution conventions
// ---------------------------------------------------------------------------

const PROVIDER_CONVENTIONS: Array<[RegExp, string]> = [
  [/Service$/, '.service.'],
  [/Controller$/, '.controller.'],
  [/Resolver$/, '.resolver.'],
  [/Gateway$/, '.gateway.'],
  [/Repository$/, '.repository.'],
  [/Guard$/, '.guard.'],
  [/Interceptor$/, '.interceptor.'],
  [/Pipe$/, '.pipe.'],
  [/Module$/, '.module.'],
]

// ---------------------------------------------------------------------------
// Decorator scanning
// ---------------------------------------------------------------------------

interface DecoratorHit {
  name: string
  args: string
  index: number
  end: number
  length: number
}

function findDecorators(safe: string, names: string[]): DecoratorHit[] {
  const hits: DecoratorHit[] = []
  const re = new RegExp(`@(${names.join('|')})\\s*\\(`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(safe)) !== null) {
    const openIndex = m.index + m[0].length - 1
    const parsed = readArgs(safe, openIndex)
    if (!parsed) continue
    hits.push({
      name: m[1]!,
      args: parsed.args,
      index: m.index,
      end: parsed.end,
      length: parsed.end - m.index,
    })
    re.lastIndex = parsed.end
  }
  return hits
}

function readArgs(s: string, openIndex: number): { args: string; end: number } | null {
  if (s[openIndex] !== '(') return null
  let depth = 0
  let inStr: string | null = null
  for (let i = openIndex; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return { args: s.slice(openIndex + 1, i), end: i + 1 }
    }
  }
  return null
}

function methodNameAfter(safe: string, start: number): string | null {
  let i = start
  const ws = /\s*/y
  const decoName = /@[\w.]+/y
  const modifier = /(?:public|private|protected|async|static)\b/y
  const ident = /([A-Za-z_$][\w$]*)\s*\(/y

  const eatWs = (): void => {
    ws.lastIndex = i
    if (ws.exec(safe)) i = ws.lastIndex
  }

  for (;;) {
    eatWs()
    if (safe[i] !== '@') break
    decoName.lastIndex = i
    if (!decoName.exec(safe)) break
    i = decoName.lastIndex
    eatWs()
    if (safe[i] === '(') {
      const parsed = readArgs(safe, i)
      if (!parsed) return null
      i = parsed.end
    }
  }

  for (;;) {
    eatWs()
    modifier.lastIndex = i
    if (modifier.exec(safe) && modifier.lastIndex > i) {
      i = modifier.lastIndex
      continue
    }
    break
  }

  eatWs()
  ident.lastIndex = i
  const m = ident.exec(safe)
  return m ? m[1]! : null
}

// ---------------------------------------------------------------------------
// Class scopes
// ---------------------------------------------------------------------------

type ClassKind = 'controller' | 'resolver' | 'gateway' | 'other'

interface ClassScope {
  kind: ClassKind
  prefix: string
  start: number
  end: number
}

function buildClassScopes(safe: string): ClassScope[] {
  const defs: Array<{ kind: ClassKind; name: string; prefixOf: (a: string) => string }> = [
    { kind: 'controller', name: 'Controller', prefixOf: parseControllerPrefix },
    { kind: 'resolver', name: 'Resolver', prefixOf: () => '' },
    { kind: 'gateway', name: 'WebSocketGateway', prefixOf: parseGatewayNamespace },
    { kind: 'other', name: 'Injectable', prefixOf: () => '' },
    { kind: 'other', name: 'Module', prefixOf: () => '' },
    { kind: 'other', name: 'Catch', prefixOf: () => '' },
  ]

  const raw: Array<{ kind: ClassKind; prefix: string; index: number }> = []
  for (const def of defs) {
    for (const hit of findDecorators(safe, [def.name])) {
      raw.push({ kind: def.kind, prefix: def.prefixOf(hit.args), index: hit.index })
    }
  }
  raw.sort((a, b) => a.index - b.index)

  return raw.map((r, i) => ({
    kind: r.kind,
    prefix: r.prefix,
    start: r.index,
    end: i + 1 < raw.length ? raw[i + 1]!.index : safe.length,
  }))
}

function scopeFor(scopes: ClassScope[], index: number): ClassScope | null {
  for (const s of scopes) {
    if (index >= s.start && index < s.end) return s
  }
  return null
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseStringArg(args: string): string {
  const m = args.match(/['"`]([^'"`]*)['"`]/)
  return m ? m[1]! : ''
}

function parseControllerPrefix(args: string): string {
  const obj = args.match(/path\s*:\s*['"`]([^'"`]*)['"`]/)
  if (obj) return obj[1]!
  return parseStringArg(args)
}

function parseGatewayNamespace(args: string): string {
  const m = args.match(/namespace\s*:\s*['"`]([^'"`]*)['"`]/)
  return m ? m[1]! : ''
}

function parseGraphqlName(args: string, handler: string | null): string {
  const named = args.match(/name\s*:\s*['"`]([^'"`]*)['"`]/)
  if (named) return named[1]!
  const lead = args.match(/^\s*['"`]([^'"`]*)['"`]/)
  if (lead) return lead[1]!
  return handler ?? ''
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function joinHttpPath(prefix: string, sub: string): string {
  const parts = [prefix, sub]
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
  return '/' + parts.join('/')
}

function lineAt(safe: string, index: number): number {
  return safe.slice(0, index).split('\n').length
}

function detectLanguage(filePath: string): JsLang {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript'
  return 'javascript'
}

// ---------------------------------------------------------------------------
// RouterModule + @Module walkers (used by postExtract)
// ---------------------------------------------------------------------------

function collectRouterModuleRegistrations(safe: string, out: Map<string, string>): void {
  const re = /\bRouterModule\s*\.\s*(?:register|forRoot|forChild)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(safe)) !== null) {
    const openIndex = m.index + m[0].length - 1
    const parsed = readArgs(safe, openIndex)
    if (!parsed) continue
    const items = parseRoutesArray(parsed.args)
    walkRoutesTree(items, '', out)
    re.lastIndex = parsed.end
  }
}

interface RouteItem {
  path: string
  moduleName: string | null
  children: RouteItem[]
}

function parseRoutesArray(args: string): RouteItem[] {
  const trimmed = args.trim()
  if (!trimmed.startsWith('[')) return []
  const close = matchingClose(trimmed, 0)
  if (close < 0) return []
  return parseRouteObjects(trimmed.slice(1, close))
}

function parseRouteObjects(s: string): RouteItem[] {
  const items: RouteItem[] = []
  for (const obj of splitTopLevelObjects(s)) {
    const path = parseStringField(obj, 'path')
    const moduleName = parseIdentField(obj, 'module')
    const childrenStr = parseArrayField(obj, 'children')
    const children = childrenStr ? parseRouteObjects(childrenStr) : []
    items.push({ path, moduleName, children })
  }
  return items
}

function walkRoutesTree(
  items: RouteItem[],
  parentPrefix: string,
  out: Map<string, string>
): void {
  for (const item of items) {
    const myPrefix = joinHttpPath(parentPrefix, item.path)
    if (item.moduleName && !out.has(item.moduleName)) {
      out.set(item.moduleName, myPrefix)
    }
    if (item.children.length > 0) {
      walkRoutesTree(item.children, myPrefix, out)
    }
  }
}

function collectModuleControllers(safe: string, out: Map<string, string>): void {
  for (const hit of findDecorators(safe, ['Module'])) {
    const className = classNameAfter(safe, hit.end)
    if (!className) continue
    for (const controller of parseControllersField(hit.args)) {
      if (!out.has(controller)) out.set(controller, className)
    }
  }
}

function parseControllersField(args: string): string[] {
  const inner = parseArrayField(args, 'controllers')
  if (inner === null) return []
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s))
}

function classNameAfter(safe: string, start: number): string | null {
  let i = start
  const ws = /\s*/y
  const decoName = /@[\w.]+/y
  const classDecl = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/y

  const eatWs = (): void => {
    ws.lastIndex = i
    if (ws.exec(safe)) i = ws.lastIndex
  }

  for (;;) {
    eatWs()
    if (safe[i] !== '@') break
    decoName.lastIndex = i
    if (!decoName.exec(safe)) break
    i = decoName.lastIndex
    eatWs()
    if (safe[i] === '(') {
      const parsed = readArgs(safe, i)
      if (!parsed) return null
      i = parsed.end
    }
  }

  eatWs()
  classDecl.lastIndex = i
  const m = classDecl.exec(safe)
  return m ? m[1]! : null
}

function applyModulePrefix(route: NodeMetadata, prefix: string): NodeMetadata | null {
  const sep = '::'
  const qn = route.qualified_name ?? ''
  const idx = qn.indexOf(sep)
  if (idx < 0) return null
  const tail = qn.slice(idx + sep.length)
  const colon = tail.indexOf(':')
  if (colon < 0) return null
  const method = tail.slice(0, colon)
  const original = tail.slice(colon + 1)
  const newName = `${method} ${joinHttpPath(prefix, original)}`
  return { ...route, name: newName, updated_at: Date.now() }
}

// ---------------------------------------------------------------------------
// Small string utilities
// ---------------------------------------------------------------------------

function matchingClose(s: string, open: number): number {
  const opener = s[open]
  if (opener !== '[' && opener !== '{' && opener !== '(') return -1
  let depth = 0
  let inStr: string | null = null
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function splitTopLevelObjects(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let objStart = -1
  let inStr: string | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue }
    if (depth === 0 && ch === '{') {
      depth = 1
      objStart = i
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      if (depth === 0 && objStart >= 0 && ch === '}') {
        out.push(s.slice(objStart + 1, i))
        objStart = -1
      }
    }
  }
  return out
}

function parseStringField(obj: string, name: string): string {
  const re = new RegExp(`(?:^|[,{\\s])${name}\\s*:\\s*['"\`]([^'"\`]*)['"\`]`)
  const m = obj.match(re)
  return m ? m[1]! : ''
}

function parseIdentField(obj: string, name: string): string | null {
  const re = new RegExp(`(?:^|[,{\\s])${name}\\s*:\\s*([A-Za-z_$][\\w$]*)`)
  const m = obj.match(re)
  return m ? m[1]! : null
}

function parseArrayField(obj: string, name: string): string | null {
  const re = new RegExp(`(?:^|[,{\\s])${name}\\s*:\\s*\\[`)
  const m = re.exec(obj)
  if (!m) return null
  const open = m.index + m[0].length - 1
  const close = matchingClose(obj, open)
  if (close < 0) return null
  return obj.slice(open + 1, close)
}
