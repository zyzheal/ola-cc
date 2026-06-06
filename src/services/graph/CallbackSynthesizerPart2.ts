/**
 * CallbackSynthesizer Part 2 — 7 framework synthesizers + main entry
 *
 * Phase 6b: codegraph callback-synthesizer migration (synthesizers 8-14)
 *
 * Synthesizers:
 * 8.  goGrpcStubImplEdges     — Go gRPC stub→impl bridge
 * 9.  reactJsxChildEdges      — React JSX child rendering
 * 10. vueTemplateEdges         — Vue SFC templates
 * 11. rnEventEdges             — React Native cross-language event channel
 * 12. fabricNativeImplEdges    — Fabric native impl bridge
 * 13. mybatisJavaXmlEdges      — MyBatis Java↔XML bridge
 * 14. ginMiddlewareChainEdges  — Gin middleware chain
 *
 * Main entry: synthesizeCallbackEdges() merges Part 1 + Part 2.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { GraphStore, NodeMetadata } from './GraphStore.js'
import type { SynthesizedEdge } from './CallbackSynthesizerTypes.js'
import {
  GraphStoreAdapter,
  JSX_TAG_RE,
  VUE_KEBAB_RE,
  VUE_HANDLER_RE,
  VUE_DESTRUCTURE_RE,
  RN_OBJC_SEND_RE,
  RN_SWIFT_SEND_RE,
  RN_JVM_EMIT_RE,
  FABRIC_NATIVE_SUFFIXES,
  GIN_DISPATCH_RE,
  GIN_REG_RE,
  MAX_CALLBACKS_PER_CHANNEL,
  EVENT_FANOUT_CAP,
  MAX_JSX_CHILDREN,
  sliceLines,
  kebabToPascal,
  enclosingFn,
  isGeneratedFile,
  stripCommentsForRegex,
  goBalancedArgs,
  goSplitArgs,
  goHandlerIdent,
} from './CallbackSynthesizerTypes.js'

// ============================================================
// Helpers
// ============================================================

/** Safe file read — returns null on any error */
function readFileSafe(projectRoot: string, filePath: string): string | null {
  try {
    return readFileSync(resolve(projectRoot, filePath), 'utf-8')
  } catch {
    return null
  }
}

// ============================================================
// 8. Go gRPC stub→impl bridge
// ============================================================

export function goGrpcStubImplEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()

  const STUB_RE = /^Unimplemented.*Server$/
  const isInternalMarker = (n: string) => n.startsWith('mustEmbed') || n === 'testEmbeddedByValue'

  // Methods directly contained by each Go struct
  const methodNamesByStruct = new Map<string, Set<string>>()
  const methodNodesByStruct = new Map<string, NodeMetadata[]>()
  const goStructs: NodeMetadata[] = []

  for (const s of adapter.getNodesByKind('struct')) {
    if (s.language !== 'go') continue
    goStructs.push(s)
    const ms = adapter
      .getOutgoingEdges(s.id, ['contains'])
      .map((e) => adapter.getNodeById(e.target))
      .filter((n): n is NodeMetadata => !!n && n.kind === 'method')
    methodNodesByStruct.set(s.id, ms)
    methodNamesByStruct.set(s.id, new Set(ms.map((m) => m.name)))
  }

  for (const stub of goStructs) {
    if (!STUB_RE.test(stub.name)) continue
    if (!isGeneratedFile(stub.file)) continue

    const stubMethods = (methodNodesByStruct.get(stub.id) ?? []).filter(
      (m) => !isInternalMarker(m.name),
    )
    if (stubMethods.length === 0) continue
    const stubMethodNames = stubMethods.map((m) => m.name)

    for (const cand of goStructs) {
      if (cand.id === stub.id) continue
      if (isGeneratedFile(cand.file)) continue

      const candNames = methodNamesByStruct.get(cand.id)
      if (!candNames) continue
      if (!stubMethodNames.every((n) => candNames.has(n))) continue

      const candMethods = methodNodesByStruct.get(cand.id) ?? []
      let added = 0
      for (const sm of stubMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break
        for (const cm of candMethods) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break
          if (cm.name !== sm.name) continue
          const key = `${sm.id}>${cm.id}`
          if (seen.has(key)) continue
          seen.add(key)
          edges.push({
            source: sm.id,
            target: cm.id,
            kind: 'calls',
            line: sm.line,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: 'go-grpc-stub-impl',
              via: cm.name,
              registeredAt: `${cm.file}:${cm.line}`,
            },
          })
          added++
        }
      }
    }
  }
  return edges
}

// ============================================================
// 9. React JSX child rendering
// ============================================================

export function reactJsxChildEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  const PARENT_KINDS = new Set(['method', 'function', 'component'])

  for (const file of adapter.getAllFiles()) {
    const content = readFileSafe(projectRoot, file)
    if (!content || (!content.includes('</') && !content.includes('/>'))) continue

    const parents = adapter.getNodesInFile(file).filter((n) => PARENT_KINDS.has(n.kind))
    for (const parent of parents) {
      const src = sliceLines(content, parent.line, parent.end_line)
      if (!src || (!src.includes('</') && !src.includes('/>'))) continue

      const names = new Set<string>()
      JSX_TAG_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = JSX_TAG_RE.exec(src))) names.add(m[1]!)

      let added = 0
      for (const name of names) {
        if (added >= MAX_JSX_CHILDREN) break
        const child = adapter.getNodesByName(name).find(
          (n) => n.kind === 'component' || n.kind === 'function' || n.kind === 'class',
        )
        if (!child || child.id === parent.id) continue
        const key = `${parent.id}>${child.id}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          source: parent.id,
          target: child.id,
          kind: 'calls',
          line: parent.line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'jsx-render', via: name },
        })
        added++
      }
    }
  }
  return edges
}

// ============================================================
// 10. Vue SFC templates
// ============================================================

export function vueTemplateEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  const COMPONENT_KINDS = new Set(['component', 'function', 'class'])
  const HANDLER_KINDS = new Set(['method', 'function'])
  const RETURN_KINDS = new Set(['method', 'function', 'variable', 'constant'])

  for (const file of adapter.getAllFiles()) {
    if (!file.endsWith('.vue')) continue
    const content = readFileSafe(projectRoot, file)
    const tpl = content && content.match(/<template[^>]*>([\s\S]*)<\/template>/i)?.[1]
    if (!tpl) continue
    const comp = adapter.getNodesInFile(file).find((n) => n.kind === 'component')
    if (!comp) continue

    // Composable-destructure map
    const script = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? ''
    const destructured = new Map<string, { composable: string; key: string }>()
    VUE_DESTRUCTURE_RE.lastIndex = 0
    let dm: RegExpExecArray | null
    while ((dm = VUE_DESTRUCTURE_RE.exec(script))) {
      if (!/^use[A-Z]/.test(dm[2]!)) continue
      for (const part of dm[1]!.split(',')) {
        const pm = part.trim().match(/^(\w+)\s*(?::\s*(\w+))?$/)
        if (pm) destructured.set(pm[2] || pm[1]!, { composable: dm[2]!, key: pm[1]! })
      }
    }

    let added = 0
    const addEdge = (target: NodeMetadata | undefined, meta: Record<string, unknown>) => {
      if (added >= MAX_JSX_CHILDREN || !target || target.id === comp.id) return
      const k = `${comp.id}>${target.id}>${meta.synthesizedBy}`
      if (seen.has(k)) return
      seen.add(k)
      edges.push({ source: comp.id, target: target.id, kind: 'calls', line: comp.line, provenance: 'heuristic', metadata: meta })
      added++
    }

    const resolve = (name: string, kinds: Set<string>): NodeMetadata | undefined => {
      const matches = adapter.getNodesByName(name).filter((n) => kinds.has(n.kind))
      return matches.find((n) => n.file === file) ?? matches[0]
    }

    let m: RegExpExecArray | null
    VUE_KEBAB_RE.lastIndex = 0
    while ((m = VUE_KEBAB_RE.exec(tpl))) addEdge(resolve(kebabToPascal(m[1]!), COMPONENT_KINDS), { synthesizedBy: 'jsx-render', via: m[1] })

    VUE_HANDLER_RE.lastIndex = 0
    while ((m = VUE_HANDLER_RE.exec(tpl))) {
      const event = m[1]!
      const expr = m[2]!.trim()
      if (expr.includes('=>') || expr.startsWith('$')) continue
      const name = expr.match(/^([A-Za-z_]\w*)/)?.[1]
      if (!name) continue
      const direct = resolve(name, HANDLER_KINDS)
      if (direct) { addEdge(direct, { synthesizedBy: 'vue-handler', event }); continue }
      const d = destructured.get(name)
      if (!d) continue
      const composable = resolve(d.composable, HANDLER_KINDS)
      const keyFn = composable
        ? adapter.getNodesByName(d.key).find((n) => RETURN_KINDS.has(n.kind) && n.file === composable.file)
        : undefined
      if (keyFn) addEdge(keyFn, { synthesizedBy: 'vue-handler', event, via: d.composable })
    }
  }
  return edges
}

// ============================================================
// 11. React Native cross-language event channel
// ============================================================

export function rnEventEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const nativeDispatchersByEvent = new Map<string, Set<string>>()
  const jsHandlersByEvent = new Map<string, Map<string, string>>()

  for (const file of adapter.getAllFiles()) {
    const content = readFileSafe(projectRoot, file)
    if (!content) continue

    const nodesInFile = adapter.getNodesInFile(file)
    const lineOf = (idx: number) => content.slice(0, idx).split('\n').length
    const addDispatcher = (event: string, line: number) => {
      const disp = enclosingFn(nodesInFile, line)
      if (!disp) return
      const set = nativeDispatchersByEvent.get(event) ?? new Set<string>()
      set.add(disp.id)
      nativeDispatchersByEvent.set(event, set)
    }

    // ObjC side
    if (file.endsWith('.m') || file.endsWith('.mm')) {
      RN_OBJC_SEND_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = RN_OBJC_SEND_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index))
      }
    }

    // Swift side
    if (file.endsWith('.swift')) {
      RN_SWIFT_SEND_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = RN_SWIFT_SEND_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index))
      }
    }

    // JVM side
    if (file.endsWith('.java') || file.endsWith('.kt')) {
      RN_JVM_EMIT_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = RN_JVM_EMIT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index))
      }
    }

    // JS subscribers
    if (
      file.endsWith('.js') ||
      file.endsWith('.jsx') ||
      file.endsWith('.ts') ||
      file.endsWith('.tsx') ||
      file.endsWith('.mjs') ||
      file.endsWith('.cjs')
    ) {
      const ADDLISTENER_ANY = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_][\w.]*)/g
      ADDLISTENER_ANY.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = ADDLISTENER_ANY.exec(content))) {
        const event = m[1]
        const arg = m[2]
        if (!event || !arg) continue
        const bareName = arg.includes('.') ? arg.slice(arg.lastIndexOf('.') + 1) : arg
        const namedHandler = adapter
          .getNodesByName(bareName)
          .find((n) => n.kind === 'function' || n.kind === 'method')
        let targetId: string | null = namedHandler?.id ?? null
        if (!targetId) {
          const enclosing = enclosingFn(nodesInFile, lineOf(m.index))
          targetId = enclosing?.id ?? null
        }
        if (!targetId) {
          const line = lineOf(m.index)
          let smallest: NodeMetadata | null = null
          for (const n of nodesInFile) {
            if (n.kind !== 'constant' && n.kind !== 'variable') continue
            const end = n.end_line ?? n.line
            if (n.line <= line && end >= line) {
              if (!smallest || n.line >= smallest.line) smallest = n
            }
          }
          targetId = smallest?.id ?? null
        }
        if (!targetId) continue
        const map = jsHandlersByEvent.get(event) ?? new Map<string, string>()
        map.set(targetId, `${file}:${lineOf(m.index)}`)
        jsHandlersByEvent.set(event, map)
      }
    }
  }

  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  for (const [event, dispatchers] of nativeDispatchersByEvent) {
    const handlers = jsHandlersByEvent.get(event)
    if (!handlers) continue
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue
    for (const d of dispatchers) {
      for (const [h, registeredAt] of handlers) {
        if (d === h) continue
        const key = `${d}>${h}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          source: d,
          target: h,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'rn-event-channel', event, registeredAt },
        })
      }
    }
  }
  return edges
}

// ============================================================
// 12. Fabric native impl bridge
// ============================================================

export function fabricNativeImplEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()

  const components = adapter.getNodesByKind('component').filter((n) => n.id.startsWith('fabric-component:'))
  if (components.length === 0) return edges

  const nativeClassesByName = new Map<string, NodeMetadata[]>()
  for (const n of adapter.getNodesByKind('class')) {
    if (n.language !== 'objc' && n.language !== 'kotlin' && n.language !== 'java' && n.language !== 'cpp') continue
    const arr = nativeClassesByName.get(n.name)
    if (arr) arr.push(n)
    else nativeClassesByName.set(n.name, [n])
  }

  for (const component of components) {
    for (const suffix of FABRIC_NATIVE_SUFFIXES) {
      const candidate = component.name + suffix
      const matches = nativeClassesByName.get(candidate)
      if (!matches || matches.length === 0) continue
      for (const native of matches) {
        const key = `${component.id}>${native.id}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          source: component.id,
          target: native.id,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'fabric-native-impl',
            viaSuffix: suffix || '(exact)',
            componentName: component.name,
          },
        })
      }
    }
  }

  return edges
}

// ============================================================
// 13. MyBatis Java↔XML bridge
// ============================================================

export function mybatisJavaXmlEdges(adapter: GraphStoreAdapter): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()

  const javaIndex = new Map<string, NodeMetadata[]>()
  for (const m of adapter.getNodesByKind('method')) {
    if (m.language !== 'java' && m.language !== 'kotlin') continue
    const qn = m.qualified_name
    if (!qn) continue
    const parts = qn.split('::')
    const last = parts[parts.length - 1]
    const cls = parts[parts.length - 2]
    if (!last || !cls) continue
    const key = `${cls}::${last}`
    const arr = javaIndex.get(key)
    if (arr) arr.push(m)
    else javaIndex.set(key, [m])
  }

  for (const xml of adapter.getNodesByKind('method')) {
    if (xml.language !== 'xml') continue
    const qn = xml.qualified_name
    if (!qn) continue
    const colonIdx = qn.lastIndexOf('::')
    if (colonIdx < 0) continue
    const namespace = qn.slice(0, colonIdx)
    const id = qn.slice(colonIdx + 2)
    if (!namespace || !id) continue
    const dotIdx = namespace.lastIndexOf('.')
    const className = dotIdx >= 0 ? namespace.slice(dotIdx + 1) : namespace
    const candidates = javaIndex.get(`${className}::${id}`)
    if (!candidates || candidates.length === 0) continue
    if (candidates.length > 1) continue
    const java = candidates[0]!
    const key = `${java.id}>${xml.id}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      source: java.id,
      target: xml.id,
      kind: 'calls',
      line: java.line,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'mybatis-java-xml',
        via: `${className}.${id}`,
        registeredAt: `${xml.file}:${xml.line}`,
      },
    })
  }
  return edges
}

// ============================================================
// 14. Gin middleware chain
// ============================================================

export function ginMiddlewareChainEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  // 1. Find the chain dispatcher(s)
  const dispatchers: NodeMetadata[] = []
  for (const n of adapter.getNodesByKind('method')) {
    if (n.language !== 'go') continue
    const content = readFileSafe(projectRoot, n.file)
    const src = content && sliceLines(content, n.line, n.end_line)
    if (src && GIN_DISPATCH_RE.test(src)) dispatchers.push(n)
  }
  if (dispatchers.length === 0) return []

  // 2. Collect handler identifiers registered via gin registration calls
  const registered = new Map<string, string>()
  for (const file of adapter.getAllFiles()) {
    if (!file.endsWith('.go')) continue
    const content = readFileSafe(projectRoot, file)
    if (!content || (!content.includes('.Use(') && !/\.(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\(/.test(content))) continue
    const safe = stripCommentsForRegex(content, 'go')
    GIN_REG_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = GIN_REG_RE.exec(safe))) {
      const parenIdx = m.index + m[0].length - 1
      const argStr = goBalancedArgs(safe, parenIdx)
      if (!argStr) continue
      const line = safe.slice(0, m.index).split('\n').length
      for (const arg of goSplitArgs(argStr)) {
        const name = goHandlerIdent(arg)
        if (name && !registered.has(name)) registered.set(name, `${file}:${line}`)
      }
    }
  }
  if (registered.size === 0) return []

  // 3. Link each dispatcher → each registered handler
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  for (const disp of dispatchers) {
    let added = 0
    for (const [name, registeredAt] of registered) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break
      const handler = adapter.getNodesByName(name).find(
        (n) => (n.kind === 'function' || n.kind === 'method') && n.language === 'go',
      )
      if (!handler || handler.id === disp.id) continue
      const key = `${disp.id}>${handler.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        source: disp.id,
        target: handler.id,
        kind: 'calls',
        line: disp.line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'gin-middleware-chain', via: name, registeredAt },
      })
      added++
    }
  }
  return edges
}

// ============================================================
// Main entry: synthesizeCallbackEdges
// ============================================================

/**
 * Synthesize all callback/observer edges. Merges Part 1 (7 synthesizers)
 * and Part 2 (7 synthesizers), deduplicates by source>target key, writes
 * to GraphStore, and returns the count of edges added.
 *
 * Part 1 synthesizers are imported dynamically to allow parallel development.
 */
export async function synthesizeCallbackEdges(store: GraphStore, projectRoot: string): Promise<number> {
  const adapter = new GraphStoreAdapter(store)

  // Part 2 synthesizers
  const part2Edges: SynthesizedEdge[] = [
    ...goGrpcStubImplEdges(adapter, projectRoot),
    ...reactJsxChildEdges(adapter, projectRoot),
    ...vueTemplateEdges(adapter, projectRoot),
    ...rnEventEdges(adapter, projectRoot),
    ...fabricNativeImplEdges(adapter, projectRoot),
    ...mybatisJavaXmlEdges(adapter),
    ...ginMiddlewareChainEdges(adapter, projectRoot),
  ]

  // Part 1 synthesizers (imported dynamically)
  let part1Edges: SynthesizedEdge[] = []
  try {
    const part1 = await import('./CallbackSynthesizer.js')
    if (part1.synthesizeCallbackEdgesPart1) {
      part1Edges = part1.synthesizeCallbackEdgesPart1(adapter, projectRoot)
    }
  } catch {
    // Part 1 not yet available — proceed with Part 2 only
  }

  // Merge and deduplicate
  const merged: SynthesizedEdge[] = []
  const seen = new Set<string>()
  for (const e of [...part1Edges, ...part2Edges]) {
    const key = `${e.source}>${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(e)
  }

  return adapter.insertSynthesizedEdges(merged)
}

/**
 * Synchronous variant — only runs Part 2 synthesizers.
 * Use when Part 1 is not available or not needed.
 */
export function synthesizeCallbackEdgesPart2(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  return [
    ...goGrpcStubImplEdges(adapter, projectRoot),
    ...reactJsxChildEdges(adapter, projectRoot),
    ...vueTemplateEdges(adapter, projectRoot),
    ...rnEventEdges(adapter, projectRoot),
    ...fabricNativeImplEdges(adapter, projectRoot),
    ...mybatisJavaXmlEdges(adapter),
    ...ginMiddlewareChainEdges(adapter, projectRoot),
  ]
}
