/**
 * CallbackSynthesizer — Part 1: 7 callback/observer edge synthesizers
 *
 * Adapted from codegraph/src/resolution/callback-synthesizer.ts.
 * Uses GraphStoreAdapter instead of QueryBuilder/ResolutionContext.
 *
 * Synthesizers:
 *  1. fieldChannelEdges       — field-backed observer channels
 *  2. closureCollectionEdges — closure-collection dynamic dispatch
 *  3. eventEmitterEdges       — string-keyed EventEmitter
 *  4. reactRenderEdges        — React class setState→render
 *  5. flutterBuildEdges       — Flutter setState→build
 *  6. cppOverrideEdges        — C++ virtual override
 *  7. interfaceOverrideEdges  — interface/abstract dispatch
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { NodeMetadata, EdgeType } from './GraphStore.js'
import type { SynthesizedEdge, GraphStoreAdapter } from './CallbackSynthesizerTypes.js'
import {
  REGISTRAR_NAME,
  DISPATCHER_NAME,
  ON_RE,
  EMIT_RE,
  SETSTATE_RE,
  FLUTTER_SETSTATE_RE,
  CC_DISPATCH_RE,
  CC_APPEND_WRITE_RE,
  CC_APPEND_DIRECT_RE,
  FN_KINDS,
  MAX_CALLBACKS_PER_CHANNEL,
  EVENT_FANOUT_CAP,
  CC_FANOUT_CAP,
  sliceLines,
  registrarField,
  dispatcherField,
  enclosingFn,
} from './CallbackSynthesizerTypes.js'

// ============================================================
// Helpers
// ============================================================

/** Read file content relative to projectRoot, return null on error. */
function readFile(adapter: GraphStoreAdapter, projectRoot: string, filePath: string): string | null {
  try {
    return readFileSync(resolve(projectRoot, filePath), 'utf-8')
  } catch {
    return null
  }
}

/** Stream method + function nodes from adapter. */
function* methodAndFunctionNodes(adapter: GraphStoreAdapter): IterableIterator<NodeMetadata> {
  yield* adapter.getNodesByKind('method')
  yield* adapter.getNodesByKind('function')
}

// ============================================================
// 1. fieldChannelEdges — Phase 1: field-backed observer channels
// ============================================================

/**
 * Field-backed observer: a registrar method stores callbacks in a field;
 * a dispatcher method iterates that field invoking each callback.
 * Links dispatcher → each named callback registered via the registrar.
 */
export function fieldChannelEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const registrars: Array<{ node: NodeMetadata; field: string }> = []
  const dispatchers: Array<{ node: NodeMetadata; field: string }> = []

  for (const m of methodAndFunctionNodes(adapter)) {
    const isReg = REGISTRAR_NAME.test(m.name)
    const isDisp = DISPATCHER_NAME.test(m.name)
    if (!isReg && !isDisp) continue
    const content = readFile(adapter, projectRoot, m.file)
    const src = content && sliceLines(content, m.line, m.end_line)
    if (!src) continue
    if (isReg) { const f = registrarField(src); if (f) registrars.push({ node: m, field: f }) }
    if (isDisp) { const f = dispatcherField(src); if (f) dispatchers.push({ node: m, field: f }) }
  }

  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  for (const reg of registrars) {
    const chDispatchers = dispatchers.filter(
      (d) => d.node.file === reg.node.file && d.field === reg.field,
    )
    if (chDispatchers.length === 0) continue
    const argRe = new RegExp(`${reg.node.name}\\s*\\(\\s*(?:this\\.)?(\\w+)`)
    let added = 0
    for (const e of adapter.getIncomingEdges(reg.node.id, ['calls'])) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break
      const caller = adapter.getNodeById(e.source)
      if (!caller) continue
      const lineIdx = e.metadata?.line as number | undefined ?? e.line
      if (!lineIdx) continue
      const fileContent = readFile(adapter, projectRoot, caller.file)
      const line = fileContent?.split('\n')[lineIdx - 1]
      const am = line?.match(argRe)
      if (!am) continue
      const fn = adapter.getNodesByName(am[1]!).find((n) => n.kind === 'method' || n.kind === 'function')
      if (!fn) continue
      for (const disp of chDispatchers) {
        if (disp.node.id === fn.id) continue
        const key = `${disp.node.id}>${fn.id}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          source: disp.node.id, target: fn.id, kind: 'calls' as EdgeType, line: disp.node.line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'callback', via: reg.node.name, field: reg.field,
            registeredAt: `${caller.file}:${lineIdx}`,
          },
        })
        added++
      }
    }
  }
  return edges
}

// ============================================================
// 2. closureCollectionEdges — closure-collection dynamic dispatch
// ============================================================

/**
 * Closure-collection dispatch: dispatcher iterates a closure-collection
 * property invoking each element; registrar appends a closure to the
 * same-named property. Links dispatcher → registrar.
 */
export function closureCollectionEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const dispatchers = new Map<string, Array<{ node: NodeMetadata; line: number }>>()
  const registrars = new Map<string, Array<{ node: NodeMetadata; line: number }>>()

  const addReg = (field: string | undefined, node: NodeMetadata, absLine: number) => {
    if (!field || /^\d+$/.test(field)) return
    const arr = registrars.get(field) ?? []
    if (!arr.some((r) => r.node.id === node.id)) arr.push({ node, line: absLine })
    registrars.set(field, arr)
  }

  for (const m of methodAndFunctionNodes(adapter)) {
    const content = readFile(adapter, projectRoot, m.file)
    const src = content && sliceLines(content, m.line, m.end_line)
    if (!src) continue
    const hasForEach = src.includes('.forEach')
    const hasAppend = src.includes('.append(') || src.includes('.add(') || src.includes('.push(') || src.includes('.insert(')
    if (!hasForEach && !hasAppend) continue
    const lineAt = (idx: number) => (m.line ?? 1) + src.slice(0, idx).split('\n').length - 1

    if (hasForEach) {
      CC_DISPATCH_RE.lastIndex = 0
      let d: RegExpExecArray | null
      while ((d = CC_DISPATCH_RE.exec(src))) {
        const arr = dispatchers.get(d[1]!) ?? []
        if (!arr.some((n) => n.node.id === m.id)) arr.push({ node: m, line: lineAt(d.index) })
        dispatchers.set(d[1]!, arr)
      }
    }
    if (hasAppend) {
      CC_APPEND_WRITE_RE.lastIndex = 0
      let w: RegExpExecArray | null
      while ((w = CC_APPEND_WRITE_RE.exec(src))) addReg(w[2] || w[1], m, lineAt(w.index))
      CC_APPEND_DIRECT_RE.lastIndex = 0
      let a: RegExpExecArray | null
      while ((a = CC_APPEND_DIRECT_RE.exec(src))) addReg(a[1], m, lineAt(a.index))
    }
  }

  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  for (const [field, disps] of dispatchers) {
    const regs = registrars.get(field)
    if (!regs || regs.length === 0) continue
    if (disps.length > CC_FANOUT_CAP || regs.length > CC_FANOUT_CAP) continue
    for (const disp of disps) for (const reg of regs) {
      if (disp.node.id === reg.node.id) continue
      const key = `${disp.node.id}>${reg.node.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        source: disp.node.id, target: reg.node.id, kind: 'calls' as EdgeType, line: disp.line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'closure-collection', field, registeredAt: `${reg.node.file}:${reg.line}` },
      })
    }
  }
  return edges
}

// ============================================================
// 3. eventEmitterEdges — Phase 2: string-keyed EventEmitter
// ============================================================

/**
 * EventEmitter: on('event', handler) ↔ emit('event').
 * Scans all files for emit/on patterns, resolves handlers by name.
 */
export function eventEmitterEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const emitsByEvent = new Map<string, Set<string>>()
  const handlersByEvent = new Map<string, Map<string, string>>()

  for (const file of adapter.getAllFiles()) {
    const content = readFile(adapter, projectRoot, file)
    if (!content) continue
    const hasEmit = content.includes('.emit(') || content.includes('.fire(') || content.includes('.dispatchEvent(')
    const hasOn = content.includes('.on(') || content.includes('.once(') || content.includes('.addListener(')
    if (!hasEmit && !hasOn) continue
    const nodesInFile = adapter.getNodesInFile(file)
    const lineOf = (idx: number) => content.slice(0, idx).split('\n').length

    if (hasEmit) {
      EMIT_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = EMIT_RE.exec(content))) {
        const disp = enclosingFn(nodesInFile, lineOf(m.index))
        if (!disp) continue
        const set = emitsByEvent.get(m[1]!) ?? new Set<string>()
        set.add(disp.id); emitsByEvent.set(m[1]!, set)
      }
    }
    if (hasOn) {
      ON_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = ON_RE.exec(content))) {
        const handlerName = m[2] || m[3]
        if (!handlerName) continue
        const handler = adapter.getNodesByName(handlerName).find((n) => n.kind === 'function' || n.kind === 'method')
        if (!handler) continue
        const map = handlersByEvent.get(m[1]!) ?? new Map<string, string>()
        map.set(handler.id, `${file}:${lineOf(m.index)}`); handlersByEvent.set(m[1]!, map)
      }
    }
  }

  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  for (const [event, dispatchers] of emitsByEvent) {
    const handlers = handlersByEvent.get(event)
    if (!handlers) continue
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue
    for (const d of dispatchers) for (const [h, registeredAt] of handlers) {
      if (d === h) continue
      const key = `${d}>${h}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: d, target: h, kind: 'calls' as EdgeType, provenance: 'heuristic', metadata: { synthesizedBy: 'event-emitter', event, registeredAt } })
    }
  }
  return edges
}

// ============================================================
// 4. reactRenderEdges — Phase 4: React class setState→render
// ============================================================

/**
 * React class-component re-render: methods calling this.setState() → render().
 * For each class with a render method, links sibling methods that call setState → render.
 */
export function reactRenderEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  for (const cls of adapter.getNodesByKind('class')) {
    const children = adapter.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => adapter.getNodeById(e.target))
      .filter((n): n is NodeMetadata => !!n && n.kind === 'method')
    const render = children.find((n) => n.name === 'render')
    if (!render) continue
    let added = 0
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break
      if (m.id === render.id) continue
      const content = readFile(adapter, projectRoot, m.file)
      const src = content && sliceLines(content, m.line, m.end_line)
      if (!src || !SETSTATE_RE.test(src)) continue
      const key = `${m.id}>${render.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        source: m.id, target: render.id, kind: 'calls' as EdgeType, line: m.line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'react-render', via: 'setState', registeredAt: `${render.file}:${render.line}` },
      })
      added++
    }
  }
  return edges
}

// ============================================================
// 5. flutterBuildEdges — Phase 4b: Flutter setState→build
// ============================================================

/**
 * Flutter setState → build: Dart State class methods calling setState() → build().
 * Gated to .dart files.
 */
export function flutterBuildEdges(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  for (const cls of adapter.getNodesByKind('class')) {
    const children = adapter.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => adapter.getNodeById(e.target))
      .filter((n): n is NodeMetadata => !!n && n.kind === 'method')
    const build = children.find((n) => n.name === 'build')
    if (!build || !build.file.endsWith('.dart')) continue
    let added = 0
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break
      if (m.id === build.id) continue
      const content = readFile(adapter, projectRoot, m.file)
      const src = content && sliceLines(content, m.line, m.end_line)
      if (!src || !FLUTTER_SETSTATE_RE.test(src)) continue
      const key = `${m.id}>${build.id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({
        source: m.id, target: build.id, kind: 'calls' as EdgeType, line: m.line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'flutter-build', via: 'setState', registeredAt: `${build.file}:${build.line}` },
      })
      added++
    }
  }
  return edges
}

// ============================================================
// 6. cppOverrideEdges — Phase 4c: C++ virtual override
// ============================================================

/**
 * C++ virtual override: base class method → subclass override of same name.
 * Links base method → subclass method for each extends relationship.
 */
export function cppOverrideEdges(adapter: GraphStoreAdapter): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  const methodsOf = (classId: string): NodeMetadata[] =>
    adapter
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => adapter.getNodeById(e.target))
      .filter((n): n is NodeMetadata => !!n && n.kind === 'method')
  for (const cls of adapter.getNodesByKind('class')) {
    const subMethods = methodsOf(cls.id).filter((n) => n.language === 'cpp')
    if (subMethods.length === 0) continue
    for (const ext of adapter.getOutgoingEdges(cls.id, ['inherits'])) {
      const base = adapter.getNodeById(ext.target)
      if (!base || base.language !== 'cpp' || base.id === cls.id) continue
      const baseMethods = new Map(methodsOf(base.id).map((m) => [m.name, m]))
      let added = 0
      for (const m of subMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break
        const bm = baseMethods.get(m.name)
        if (!bm || bm.id === m.id) continue
        const key = `${bm.id}>${m.id}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({
          source: bm.id,
          target: m.id,
          kind: 'calls' as EdgeType,
          line: bm.line,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'cpp-override', via: m.name, registeredAt: `${m.file}:${m.line}` },
        })
        added++
      }
    }
  }
  return edges
}

// ============================================================
// 7. interfaceOverrideEdges — Phase 5.5: interface/abstract dispatch
// ============================================================

const IFACE_OVERRIDE_LANGS = new Set([
  'java', 'kotlin', 'csharp', 'typescript', 'javascript', 'swift', 'scala',
])

/**
 * Interface/abstract dispatch: base/interface method → implementing class's
 * same-name override. Supports Java, Kotlin, C#, TypeScript, JavaScript, Swift, Scala.
 */
export function interfaceOverrideEdges(adapter: GraphStoreAdapter): SynthesizedEdge[] {
  const edges: SynthesizedEdge[] = []
  const seen = new Set<string>()
  const methodsOf = (classId: string): NodeMetadata[] =>
    adapter
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => adapter.getNodeById(e.target))
      .filter((n): n is NodeMetadata => !!n && n.kind === 'method')
  const concreteKinds = ['class', 'struct'] as const
  for (const kind of concreteKinds) {
    for (const cls of adapter.getNodesByKind(kind)) {
      const implMethods = methodsOf(cls.id).filter((n) => IFACE_OVERRIDE_LANGS.has(n.language ?? ''))
      if (implMethods.length === 0) continue
      for (const sup of adapter.getOutgoingEdges(cls.id, ['implements', 'inherits'])) {
        const base = adapter.getNodeById(sup.target)
        if (!base || !IFACE_OVERRIDE_LANGS.has(base.language ?? '') || base.id === cls.id) continue
        const implByName = new Map<string, NodeMetadata[]>()
        for (const m of implMethods) {
          const arr = implByName.get(m.name)
          if (arr) arr.push(m); else implByName.set(m.name, [m])
        }
        let added = 0
        for (const bm of methodsOf(base.id)) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break
          for (const m of implByName.get(bm.name) ?? []) {
            if (added >= MAX_CALLBACKS_PER_CHANNEL) break
            if (bm.id === m.id) continue
            const key = `${bm.id}>${m.id}`
            if (seen.has(key)) continue
            seen.add(key)
            edges.push({
              source: bm.id,
              target: m.id,
              kind: 'calls' as EdgeType,
              line: bm.line,
              provenance: 'heuristic',
              metadata: { synthesizedBy: 'interface-impl', via: m.name, registeredAt: `${m.file}:${m.line}` },
            })
            added++
          }
        }
      }
    }
  }
  return edges
}

// ============================================================
// Aggregate: synthesizeCallbackEdgesPart1
// ============================================================

/**
 * Run all 7 Part-1 synthesizers and return deduplicated merged edges.
 */
export function synthesizeCallbackEdgesPart1(adapter: GraphStoreAdapter, projectRoot: string): SynthesizedEdge[] {
  const allEdges = [
    ...fieldChannelEdges(adapter, projectRoot),
    ...closureCollectionEdges(adapter, projectRoot),
    ...eventEmitterEdges(adapter, projectRoot),
    ...reactRenderEdges(adapter, projectRoot),
    ...flutterBuildEdges(adapter, projectRoot),
    ...cppOverrideEdges(adapter),
    ...interfaceOverrideEdges(adapter),
  ]

  const merged: SynthesizedEdge[] = []
  const seen = new Set<string>()
  for (const e of allEdges) {
    const key = `${e.source}>${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(e)
  }
  return merged
}
