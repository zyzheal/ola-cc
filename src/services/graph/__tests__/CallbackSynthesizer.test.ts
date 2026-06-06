/**
 * CallbackSynthesizer Part 1 — 7 synthesizer tests
 *
 * Uses in-memory GraphStore + temp files for file reading.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { resolve } from 'path'
import { GraphStore, type EdgeType } from '../GraphStore.js'
import { GraphStoreAdapter } from '../CallbackSynthesizerTypes.js'
import {
  fieldChannelEdges,
  closureCollectionEdges,
  eventEmitterEdges,
  reactRenderEdges,
  flutterBuildEdges,
  cppOverrideEdges,
  interfaceOverrideEdges,
  synthesizeCallbackEdgesPart1,
} from '../CallbackSynthesizer.js'

const TMP_DIR = resolve('/tmp', `callback-synth-test-${Date.now()}`)

// ============================================================
// Test helpers
// ============================================================

function createTestStore(uniqueKey: string): GraphStore {
  const store = GraphStore.getInstance(uniqueKey)
  const anyStore = store as any
  anyStore.loaded = true
  return store
}

function addNode(
  store: GraphStore,
  id: string,
  name: string,
  kind: string,
  file: string,
  line: number,
  opts?: { end_line?: number; language?: string; qualified_name?: string },
) {
  store.nodeMeta.set(id, {
    id,
    name,
    kind,
    file,
    line,
    end_line: opts?.end_line ?? line + 10,
    language: opts?.language,
    qualified_name: opts?.qualified_name,
  })
}

function addEdge(store: GraphStore, from: string, to: string, type: EdgeType, metadata?: Record<string, unknown>) {
  store.addEdge(from, to, type, 1, 'EXTRACTED')
  // Attach metadata if provided
  if (metadata) {
    const fromMap = store.adjacency.get(from)
    const arr = fromMap?.get(to)
    if (arr) {
      const edge = arr.find(e => e.type === type)
      if (edge) edge.metadata = metadata
    }
  }
}

function createTmpFile(relPath: string, content: string): string {
  const full = resolve(TMP_DIR, relPath)
  const dir = full.substring(0, full.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(full, content, 'utf-8')
  return relPath
}

// ============================================================
// Tests
// ============================================================

describe('CallbackSynthesizer', () => {
  let storeKey: string

  beforeEach(() => {
    storeKey = `test-callback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    mkdirSync(TMP_DIR, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(TMP_DIR, { recursive: true, force: true }) } catch {}
  })

  // ----------------------------------------------------------
  // 1. fieldChannelEdges
  // ----------------------------------------------------------
  describe('fieldChannelEdges', () => {
    it('should synthesize edges for field-backed observer pattern', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      // Scene class with onUpdate registrar and triggerRender dispatcher
      const file = createTmpFile('scene.ts', [
        'class Scene {',
        '  callbacks: Function[] = [];',
        '  onUpdate(cb: Function) { this.callbacks.add(cb); }',     // line 3
        '  triggerRender() { for (const cb of this.callbacks) cb(); }', // line 4
        '}',
        '',
        'class App {',
        '  triggerUpdate() { }',  // line 8
        '  init() {',
        '    scene.onUpdate(this.triggerUpdate);',  // line 10
        '  }',
        '}',
      ].join('\n'))

      addNode(store, 'scene', 'Scene', 'class', file, 1)
      addNode(store, 'onUpdate', 'onUpdate', 'method', file, 3, { end_line: 3 })
      addNode(store, 'triggerRender', 'triggerRender', 'method', file, 4, { end_line: 4 })
      addNode(store, 'app', 'App', 'class', file, 7)
      addNode(store, 'triggerUpdate', 'triggerUpdate', 'method', file, 8, { end_line: 8 })
      addNode(store, 'init', 'init', 'method', file, 9, { end_line: 11 })

      // init calls onUpdate
      addEdge(store, 'init', 'onUpdate', 'calls', { line: 10 })

      const edges = fieldChannelEdges(adapter, TMP_DIR)

      expect(edges.length).toBeGreaterThanOrEqual(1)
      const edge = edges.find(e => e.source === 'triggerRender' && e.target === 'triggerUpdate')
      expect(edge).toBeDefined()
      expect(edge!.metadata.synthesizedBy).toBe('callback')
      expect(edge!.metadata.via).toBe('onUpdate')
      expect(edge!.metadata.field).toBe('callbacks')
      expect(edge!.provenance).toBe('heuristic')
    })

    it('should return empty when no registrar/dispatcher match', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      const file = createTmpFile('noop.ts', [
        'function doStuff() { return 42; }',
      ].join('\n'))

      addNode(store, 'doStuff', 'doStuff', 'function', file, 1, { end_line: 1 })

      const edges = fieldChannelEdges(adapter, TMP_DIR)
      expect(edges).toEqual([])
    })
  })

  // ----------------------------------------------------------
  // 2. closureCollectionEdges
  // ----------------------------------------------------------
  describe('closureCollectionEdges', () => {
    it('should synthesize edges for closure-collection dispatch', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      // Swift-style closure-collection: dispatch iterates with $0(), registrar appends
      const file = createTmpFile('request.swift', [
        'class Request {',
        '  var validators: [() -> Void] = [];',
        '  func validate(_ fn: @escaping () -> Void) { validators.append(fn); }',  // line 3 — registrar
        '  func didCompleteTask() { validators.forEach { $0() } }', // line 4 — dispatcher (Swift $0 invocation)
        '}',
      ].join('\n'))

      addNode(store, 'request', 'Request', 'class', file, 1)
      addNode(store, 'validate', 'validate', 'method', file, 3, { end_line: 3 })
      addNode(store, 'didCompleteTask', 'didCompleteTask', 'method', file, 4, { end_line: 4 })

      const edges = closureCollectionEdges(adapter, TMP_DIR)

      expect(edges.length).toBeGreaterThanOrEqual(1)
      const edge = edges.find(e => e.source === 'didCompleteTask' && e.target === 'validate')
      expect(edge).toBeDefined()
      expect(edge!.metadata.synthesizedBy).toBe('closure-collection')
      expect(edge!.metadata.field).toBe('validators')
    })

    it('should return empty when forEach does not invoke elements', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      // forEach that logs but doesn't invoke — no $0() or it() pattern
      const file = createTmpFile('logger.ts', [
        'function log(items: any[]) { items.forEach((item) => console.log(item)); }',
      ].join('\n'))

      addNode(store, 'log', 'log', 'function', file, 1, { end_line: 1 })

      const edges = closureCollectionEdges(adapter, TMP_DIR)
      expect(edges).toEqual([])
    })
  })

  // ----------------------------------------------------------
  // 3. eventEmitterEdges
  // ----------------------------------------------------------
  describe('eventEmitterEdges', () => {
    it('should synthesize edges for EventEmitter on/emit pattern', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      const file = createTmpFile('emitter.ts', [
        'class MyEmitter extends EventEmitter {',
        '  setup() {',
        '    this.on("mount", function onMount() { console.log("mounted"); });',  // line 3
        '  }',
        '  trigger() {',
        '    this.emit("mount", this);',  // line 6
        '  }',
        '}',
      ].join('\n'))

      addNode(store, 'myemitter', 'MyEmitter', 'class', file, 1)
      addNode(store, 'onMount', 'onMount', 'function', file, 3, { end_line: 3 })
      addNode(store, 'setup', 'setup', 'method', file, 2, { end_line: 4 })
      addNode(store, 'trigger', 'trigger', 'method', file, 5, { end_line: 7 })

      const edges = eventEmitterEdges(adapter, TMP_DIR)

      expect(edges.length).toBeGreaterThanOrEqual(1)
      const edge = edges.find(e => e.source === 'trigger' && e.target === 'onMount')
      expect(edge).toBeDefined()
      expect(edge!.metadata.synthesizedBy).toBe('event-emitter')
      expect(edge!.metadata.event).toBe('mount')
    })

    it('should skip events with too many handlers (fan-out cap)', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      // Create a file with many .on("error", ...) registrations to exceed EVENT_FANOUT_CAP (6)
      const lines: string[] = ['class M extends EventEmitter {']
      for (let i = 0; i < 8; i++) {
        lines.push(`  handler${i}() {}`)
        addNode(store, `handler${i}`, `handler${i}`, 'method', 'emitter.ts', i + 2, { end_line: i + 2 })
      }
      lines.push('  setup() {')
      for (let i = 0; i < 8; i++) {
        lines.push(`    this.on("error", this.handler${i});`)
      }
      lines.push('  }')
      lines.push('  fire() { this.emit("error"); }')
      lines.push('}')

      const file = createTmpFile('emitter.ts', lines.join('\n'))
      addNode(store, 'm', 'M', 'class', file, 1)
      addNode(store, 'setup', 'setup', 'method', file, 10, { end_line: 19 })
      addNode(store, 'fire', 'fire', 'method', file, 20, { end_line: 20 })

      const edges = eventEmitterEdges(adapter, TMP_DIR)

      // Should be empty because handler count exceeds fan-out cap
      expect(edges).toEqual([])
    })
  })

  // ----------------------------------------------------------
  // 4. reactRenderEdges
  // ----------------------------------------------------------
  describe('reactRenderEdges', () => {
    it('should synthesize setState→render edges for React class components', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      const file = createTmpFile('counter.tsx', [
        'class Counter extends React.Component {',
        '  render() { return <div>{this.state.count}</div>; }',  // line 2
        '  increment() { this.setState({ count: this.state.count + 1 }); }',  // line 3
        '  reset() { this.setState({ count: 0 }); }',  // line 4
        '}',
      ].join('\n'))

      addNode(store, 'counter', 'Counter', 'class', file, 1)
      addNode(store, 'render', 'render', 'method', file, 2, { end_line: 2 })
      addNode(store, 'increment', 'increment', 'method', file, 3, { end_line: 3 })
      addNode(store, 'reset', 'reset', 'method', file, 4, { end_line: 4 })

      // contains edges: class → methods
      addEdge(store, 'counter', 'render', 'contains')
      addEdge(store, 'counter', 'increment', 'contains')
      addEdge(store, 'counter', 'reset', 'contains')

      const edges = reactRenderEdges(adapter, TMP_DIR)

      expect(edges.length).toBe(2)
      expect(edges.every(e => e.target === 'render')).toBe(true)
      expect(edges.every(e => e.metadata.synthesizedBy === 'react-render')).toBe(true)
      expect(edges.every(e => e.provenance === 'heuristic')).toBe(true)

      const sources = edges.map(e => e.source).sort()
      expect(sources).toEqual(['increment', 'reset'])
    })

    it('should not link render to itself', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      const file = createTmpFile('simple.tsx', [
        'class Simple extends React.Component {',
        '  render() { this.setState({}); return <div/>; }',  // render calls setState
        '}',
      ].join('\n'))

      addNode(store, 'simple', 'Simple', 'class', file, 1)
      addNode(store, 'render', 'render', 'method', file, 2, { end_line: 2 })
      addEdge(store, 'simple', 'render', 'contains')

      const edges = reactRenderEdges(adapter, TMP_DIR)

      // render→render should be skipped
      expect(edges).toEqual([])
    })
  })

  // ----------------------------------------------------------
  // 5. flutterBuildEdges
  // ----------------------------------------------------------
  describe('flutterBuildEdges', () => {
    it('should synthesize setState→build edges for Flutter State classes', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      const file = createTmpFile('counter.dart', [
        'class _CounterState extends State<Counter> {',
        '  Widget build(BuildContext context) { return Text("$_count"); }',  // line 2
        '  void _increment() { setState(() { _count++; }); }',  // line 3
        '}',
      ].join('\n'))

      addNode(store, 'counterState', '_CounterState', 'class', file, 1)
      addNode(store, 'build', 'build', 'method', file, 2, { end_line: 2 })
      addNode(store, 'increment', '_increment', 'method', file, 3, { end_line: 3 })

      addEdge(store, 'counterState', 'build', 'contains')
      addEdge(store, 'counterState', 'increment', 'contains')

      const edges = flutterBuildEdges(adapter, TMP_DIR)

      expect(edges.length).toBe(1)
      expect(edges[0].source).toBe('increment')
      expect(edges[0].target).toBe('build')
      expect(edges[0].metadata.synthesizedBy).toBe('flutter-build')
    })

    it('should skip non-dart files', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      const file = createTmpFile('widget.tsx', [
        'class Widget {',
        '  build() { return "<div/>"; }',
        '  update() { this.setState({}); }',
        '}',
      ].join('\n'))

      addNode(store, 'widget', 'Widget', 'class', file, 1)
      addNode(store, 'build', 'build', 'method', file, 2, { end_line: 2 })
      addNode(store, 'update', 'update', 'method', file, 3, { end_line: 3 })
      addEdge(store, 'widget', 'build', 'contains')
      addEdge(store, 'widget', 'update', 'contains')

      const edges = flutterBuildEdges(adapter, TMP_DIR)

      // Not a .dart file, so no edges
      expect(edges).toEqual([])
    })
  })

  // ----------------------------------------------------------
  // 6. cppOverrideEdges
  // ----------------------------------------------------------
  describe('cppOverrideEdges', () => {
    it('should synthesize base→override edges for C++ classes', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      addNode(store, 'base', 'Base', 'class', 'base.cpp', 1, { language: 'cpp' })
      addNode(store, 'baseGet', 'get', 'method', 'base.cpp', 3, { end_line: 5, language: 'cpp' })
      addNode(store, 'derived', 'Derived', 'class', 'derived.cpp', 1, { language: 'cpp' })
      addNode(store, 'derivedGet', 'get', 'method', 'derived.cpp', 3, { end_line: 5, language: 'cpp' })

      // derived extends base
      addEdge(store, 'derived', 'base', 'inherits')
      // contains edges
      addEdge(store, 'base', 'baseGet', 'contains')
      addEdge(store, 'derived', 'derivedGet', 'contains')

      const edges = cppOverrideEdges(adapter)

      expect(edges.length).toBe(1)
      expect(edges[0].source).toBe('baseGet')
      expect(edges[0].target).toBe('derivedGet')
      expect(edges[0].metadata.synthesizedBy).toBe('cpp-override')
      expect(edges[0].metadata.via).toBe('get')
    })

    it('should skip non-C++ classes', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      addNode(store, 'base', 'Base', 'class', 'base.ts', 1, { language: 'typescript' })
      addNode(store, 'baseGet', 'get', 'method', 'base.ts', 3, { end_line: 5, language: 'typescript' })
      addNode(store, 'derived', 'Derived', 'class', 'derived.ts', 1, { language: 'typescript' })
      addNode(store, 'derivedGet', 'get', 'method', 'derived.ts', 3, { end_line: 5, language: 'typescript' })

      addEdge(store, 'derived', 'base', 'inherits')
      addEdge(store, 'base', 'baseGet', 'contains')
      addEdge(store, 'derived', 'derivedGet', 'contains')

      const edges = cppOverrideEdges(adapter)
      expect(edges).toEqual([])
    })
  })

  // ----------------------------------------------------------
  // 7. interfaceOverrideEdges
  // ----------------------------------------------------------
  describe('interfaceOverrideEdges', () => {
    it('should synthesize interface→impl edges for Java classes', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      addNode(store, 'service', 'FooService', 'class', 'IFoo.java', 1, { language: 'java' })
      addNode(store, 'ifaceList', 'list', 'method', 'IFoo.java', 3, { end_line: 3, language: 'java' })
      addNode(store, 'impl', 'FooServiceImpl', 'class', 'FooServiceImpl.java', 1, { language: 'java' })
      addNode(store, 'implList', 'list', 'method', 'FooServiceImpl.java', 5, { end_line: 8, language: 'java' })
      addNode(store, 'implSave', 'save', 'method', 'FooServiceImpl.java', 10, { end_line: 12, language: 'java' })

      addEdge(store, 'impl', 'service', 'implements')
      addEdge(store, 'service', 'ifaceList', 'contains')
      addEdge(store, 'impl', 'implList', 'contains')
      addEdge(store, 'impl', 'implSave', 'contains')

      const edges = interfaceOverrideEdges(adapter)

      expect(edges.length).toBe(1)
      expect(edges[0].source).toBe('ifaceList')
      expect(edges[0].target).toBe('implList')
      expect(edges[0].metadata.synthesizedBy).toBe('interface-impl')
    })

    it('should support extends edge type for abstract base dispatch', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      addNode(store, 'abstractBase', 'AbstractHandler', 'class', 'handler.ts', 1, { language: 'typescript' })
      addNode(store, 'baseHandle', 'handle', 'method', 'handler.ts', 3, { end_line: 3, language: 'typescript' })
      addNode(store, 'concrete', 'ConcreteHandler', 'class', 'concrete.ts', 1, { language: 'typescript' })
      addNode(store, 'concreteHandle', 'handle', 'method', 'concrete.ts', 5, { end_line: 8, language: 'typescript' })

      addEdge(store, 'concrete', 'abstractBase', 'inherits')
      addEdge(store, 'abstractBase', 'baseHandle', 'contains')
      addEdge(store, 'concrete', 'concreteHandle', 'contains')

      const edges = interfaceOverrideEdges(adapter)

      expect(edges.length).toBe(1)
      expect(edges[0].source).toBe('baseHandle')
      expect(edges[0].target).toBe('concreteHandle')
      expect(edges[0].metadata.synthesizedBy).toBe('interface-impl')
    })

    it('should handle overloads (multiple methods with same name)', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      addNode(store, 'repo', 'Repository', 'class', 'repo.java', 1, { language: 'java' })
      addNode(store, 'find1', 'find', 'method', 'repo.java', 3, { end_line: 3, language: 'java' })
      addNode(store, 'find2', 'find', 'method', 'repo.java', 5, { end_line: 5, language: 'java' })
      addNode(store, 'impl', 'RepoImpl', 'class', 'impl.java', 1, { language: 'java' })
      addNode(store, 'implFind1', 'find', 'method', 'impl.java', 10, { end_line: 10, language: 'java' })
      addNode(store, 'implFind2', 'find', 'method', 'impl.java', 12, { end_line: 12, language: 'java' })

      addEdge(store, 'impl', 'repo', 'implements')
      addEdge(store, 'repo', 'find1', 'contains')
      addEdge(store, 'repo', 'find2', 'contains')
      addEdge(store, 'impl', 'implFind1', 'contains')
      addEdge(store, 'impl', 'implFind2', 'contains')

      const edges = interfaceOverrideEdges(adapter)

      // 2 base overloads × 2 impl overloads = 4 edges (all combinations)
      expect(edges.length).toBe(4)
      expect(edges.every(e => e.metadata.synthesizedBy === 'interface-impl')).toBe(true)
    })

    it('should skip unsupported languages', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      addNode(store, 'trait', 'Drawable', 'class', 'drawable.go', 1, { language: 'go' })
      addNode(store, 'traitDraw', 'draw', 'method', 'drawable.go', 3, { end_line: 3, language: 'go' })
      addNode(store, 'impl', 'Circle', 'class', 'circle.go', 1, { language: 'go' })
      addNode(store, 'implDraw', 'draw', 'method', 'circle.go', 5, { end_line: 5, language: 'go' })

      addEdge(store, 'impl', 'trait', 'implements')
      addEdge(store, 'trait', 'traitDraw', 'contains')
      addEdge(store, 'impl', 'implDraw', 'contains')

      const edges = interfaceOverrideEdges(adapter)
      expect(edges).toEqual([])
    })
  })

  // ----------------------------------------------------------
  // synthesizeCallbackEdgesPart1 (aggregate)
  // ----------------------------------------------------------
  describe('synthesizeCallbackEdgesPart1', () => {
    it('should merge and deduplicate edges from all synthesizers', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      // EventEmitter pattern
      const file = createTmpFile('app.ts', [
        'class App extends EventEmitter {',
        '  setup() { this.on("init", function onInit() {}); }',
        '  boot() { this.emit("init"); }',
        '}',
      ].join('\n'))

      addNode(store, 'app', 'App', 'class', file, 1)
      addNode(store, 'onInit', 'onInit', 'function', file, 2, { end_line: 2 })
      addNode(store, 'setup', 'setup', 'method', file, 2, { end_line: 2 })
      addNode(store, 'boot', 'boot', 'method', file, 3, { end_line: 3 })

      const edges = synthesizeCallbackEdgesPart1(adapter, TMP_DIR)

      // Should find at least the event-emitter edge
      const emitterEdges = edges.filter(e => e.metadata.synthesizedBy === 'event-emitter')
      expect(emitterEdges.length).toBeGreaterThanOrEqual(1)

      // All edges should have provenance 'heuristic'
      expect(edges.every(e => e.provenance === 'heuristic')).toBe(true)
    })

    it('should return empty array for a store with no patterns', () => {
      const store = createTestStore(storeKey)
      const adapter = new GraphStoreAdapter(store)

      const file = createTmpFile('plain.ts', 'const x = 1;')
      addNode(store, 'x', 'x', 'variable', file, 1, { end_line: 1 })

      const edges = synthesizeCallbackEdgesPart1(adapter, TMP_DIR)
      expect(edges).toEqual([])
    })
  })
})
