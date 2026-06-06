/**
 * CallbackSynthesizer Part 2 — 7 framework synthesizers + main entry
 *
 * TDD tests for:
 * - goGrpcStubImplEdges
 * - reactJsxChildEdges
 * - vueTemplateEdges
 * - rnEventEdges
 * - fabricNativeImplEdges
 * - mybatisJavaXmlEdges
 * - ginMiddlewareChainEdges
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { resolve, join } from 'path'
import { tmpdir } from 'os'
import { GraphStore } from '../GraphStore.js'
import type { NodeMetadata } from '../GraphStore.js'
import { GraphStoreAdapter } from '../CallbackSynthesizerTypes.js'
import {
  goGrpcStubImplEdges,
  reactJsxChildEdges,
  vueTemplateEdges,
  rnEventEdges,
  fabricNativeImplEdges,
  mybatisJavaXmlEdges,
  ginMiddlewareChainEdges,
} from '../CallbackSynthesizerPart2.js'

// ============================================================
// Helpers — each test gets a unique store and temp dir
// ============================================================

let storeCounter = 0

function makeTestDir(): string {
  const dir = join(tmpdir(), `cb-synth-p2-${Date.now()}-${++storeCounter}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Create a fresh GraphStore with a unique key (no singleton pollution) */
function freshStore(): { store: GraphStore; key: string } {
  const key = `test-cb-p2-${Date.now()}-${++storeCounter}-${Math.random().toString(36).slice(2, 8)}`
  const store = GraphStore.getInstance(key)
  return { store, key }
}

function addNode(store: GraphStore, meta: Partial<NodeMetadata> & { id: string }): void {
  store.nodeMeta.set(meta.id, {
    id: meta.id,
    name: meta.name ?? meta.id,
    kind: meta.kind ?? 'function',
    file: meta.file ?? '/test/unknown.ts',
    line: meta.line ?? 1,
    end_line: meta.end_line,
    qualified_name: meta.qualified_name,
    language: meta.language,
  })
}

function makeAdapter(store: GraphStore): GraphStoreAdapter {
  return new GraphStoreAdapter(store)
}

// ============================================================
// 1. goGrpcStubImplEdges
// ============================================================

describe('goGrpcStubImplEdges', () => {
  test('links stub methods to impl methods when names match', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const projectRoot = makeTestDir()

    // Stub struct in generated file
    addNode(store, {
      id: 'struct:UnimplementedMsgServer',
      name: 'UnimplementedMsgServer',
      kind: 'struct',
      language: 'go',
      file: 'pb/msg.pb.go',
    })
    addNode(store, {
      id: 'method:UnimplementedMsgServer:Send',
      name: 'Send',
      kind: 'method',
      language: 'go',
      file: 'pb/msg.pb.go',
      line: 10,
    })
    addNode(store, {
      id: 'method:UnimplementedMsgServer:MultiSend',
      name: 'MultiSend',
      kind: 'method',
      language: 'go',
      file: 'pb/msg.pb.go',
      line: 20,
    })
    // Impl struct in non-generated file
    addNode(store, {
      id: 'struct:MsgServerImpl',
      name: 'MsgServerImpl',
      kind: 'struct',
      language: 'go',
      file: 'keeper/msg_server.go',
    })
    addNode(store, {
      id: 'method:MsgServerImpl:Send',
      name: 'Send',
      kind: 'method',
      language: 'go',
      file: 'keeper/msg_server.go',
      line: 30,
    })
    addNode(store, {
      id: 'method:MsgServerImpl:MultiSend',
      name: 'MultiSend',
      kind: 'method',
      language: 'go',
      file: 'keeper/msg_server.go',
      line: 50,
    })

    store.addEdge('struct:UnimplementedMsgServer', 'method:UnimplementedMsgServer:Send', 'contains', 1)
    store.addEdge('struct:UnimplementedMsgServer', 'method:UnimplementedMsgServer:MultiSend', 'contains', 1)
    store.addEdge('struct:MsgServerImpl', 'method:MsgServerImpl:Send', 'contains', 1)
    store.addEdge('struct:MsgServerImpl', 'method:MsgServerImpl:MultiSend', 'contains', 1)

    const edges = goGrpcStubImplEdges(adapter, projectRoot)
    expect(edges.length).toBe(2)

    const sendEdge = edges.find(e => e.source === 'method:UnimplementedMsgServer:Send')
    expect(sendEdge).toBeDefined()
    expect(sendEdge!.target).toBe('method:MsgServerImpl:Send')
    expect(sendEdge!.kind).toBe('calls')
    expect(sendEdge!.metadata.synthesizedBy).toBe('go-grpc-stub-impl')
  })

  test('skips non-Go structs', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const projectRoot = makeTestDir()

    addNode(store, {
      id: 'struct:UnimplementedService',
      name: 'UnimplementedService',
      kind: 'struct',
      language: 'typescript',
      file: 'service.ts',
    })

    const edges = goGrpcStubImplEdges(adapter, projectRoot)
    expect(edges).toEqual([])
  })

  test('skips stubs not in generated files', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const projectRoot = makeTestDir()

    addNode(store, {
      id: 'struct:UnimplementedMsgServer',
      name: 'UnimplementedMsgServer',
      kind: 'struct',
      language: 'go',
      file: 'keeper/hand_written.go',
    })
    addNode(store, {
      id: 'method:UnimplementedMsgServer:Send',
      name: 'Send',
      kind: 'method',
      language: 'go',
      file: 'keeper/hand_written.go',
      line: 10,
    })
    store.addEdge('struct:UnimplementedMsgServer', 'method:UnimplementedMsgServer:Send', 'contains', 1)

    const edges = goGrpcStubImplEdges(adapter, projectRoot)
    expect(edges).toEqual([])
  })

  test('skips impls in generated files', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const projectRoot = makeTestDir()

    addNode(store, {
      id: 'struct:UnimplementedMsgServer',
      name: 'UnimplementedMsgServer',
      kind: 'struct',
      language: 'go',
      file: 'pb/msg_grpc.pb.go',
    })
    addNode(store, {
      id: 'method:UnimplementedMsgServer:Send',
      name: 'Send',
      kind: 'method',
      language: 'go',
      file: 'pb/msg_grpc.pb.go',
      line: 10,
    })
    addNode(store, {
      id: 'struct:UnsafeMsgServer',
      name: 'UnsafeMsgServer',
      kind: 'struct',
      language: 'go',
      file: 'pb/msg_grpc.pb.go',
    })
    addNode(store, {
      id: 'method:UnsafeMsgServer:Send',
      name: 'Send',
      kind: 'method',
      language: 'go',
      file: 'pb/msg_grpc.pb.go',
      line: 30,
    })
    store.addEdge('struct:UnimplementedMsgServer', 'method:UnimplementedMsgServer:Send', 'contains', 1)
    store.addEdge('struct:UnsafeMsgServer', 'method:UnsafeMsgServer:Send', 'contains', 1)

    const edges = goGrpcStubImplEdges(adapter, projectRoot)
    expect(edges).toEqual([])
  })

  test('skips mustEmbed internal methods', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const projectRoot = makeTestDir()

    addNode(store, {
      id: 'struct:UnimplementedMsgServer',
      name: 'UnimplementedMsgServer',
      kind: 'struct',
      language: 'go',
      file: 'pb/msg.pb.go',
    })
    addNode(store, {
      id: 'method:UnimplementedMsgServer:mustEmbedUnimplementedMsgServer',
      name: 'mustEmbedUnimplementedMsgServer',
      kind: 'method',
      language: 'go',
      file: 'pb/msg.pb.go',
      line: 10,
    })
    addNode(store, {
      id: 'struct:MsgServerImpl',
      name: 'MsgServerImpl',
      kind: 'struct',
      language: 'go',
      file: 'keeper/msg_server.go',
    })
    addNode(store, {
      id: 'method:MsgServerImpl:mustEmbedUnimplementedMsgServer',
      name: 'mustEmbedUnimplementedMsgServer',
      kind: 'method',
      language: 'go',
      file: 'keeper/msg_server.go',
      line: 30,
    })
    store.addEdge('struct:UnimplementedMsgServer', 'method:UnimplementedMsgServer:mustEmbedUnimplementedMsgServer', 'contains', 1)
    store.addEdge('struct:MsgServerImpl', 'method:MsgServerImpl:mustEmbedUnimplementedMsgServer', 'contains', 1)

    const edges = goGrpcStubImplEdges(adapter, projectRoot)
    expect(edges).toEqual([])
  })
})

// ============================================================
// 2. reactJsxChildEdges
// ============================================================

describe('reactJsxChildEdges', () => {
  test('links parent component to JSX child component', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const appFile = 'App.tsx'
    const content = `
function App() {
  return <div><Child prop="a" /></div>
}
`
    writeFileSync(resolve(testDir, appFile), content)

    addNode(store, {
      id: 'fn:App',
      name: 'App',
      kind: 'function',
      file: appFile,
      line: 2,
      end_line: 4,
      language: 'typescript',
    })
    addNode(store, {
      id: 'comp:Child',
      name: 'Child',
      kind: 'component',
      file: 'Child.tsx',
      line: 1,
      language: 'typescript',
    })

    const edges = reactJsxChildEdges(adapter, testDir)
    expect(edges.length).toBe(1)
    expect(edges[0].source).toBe('fn:App')
    expect(edges[0].target).toBe('comp:Child')
    expect(edges[0].metadata.synthesizedBy).toBe('jsx-render')

    rmSync(testDir, { recursive: true, force: true })
  })

  test('ignores self-references', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const file = 'Recursive.tsx'
    const content = `function Recursive() { return <Recursive /> }`
    writeFileSync(resolve(testDir, file), content)

    addNode(store, {
      id: 'fn:Recursive',
      name: 'Recursive',
      kind: 'function',
      file,
      line: 1,
      end_line: 1,
    })

    const edges = reactJsxChildEdges(adapter, testDir)
    expect(edges).toEqual([])

    rmSync(testDir, { recursive: true, force: true })
  })

  test('caps at MAX_JSX_CHILDREN', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const file = 'Big.tsx'
    const tags = Array.from({ length: 40 }, (_, i) => `<Comp${i} />`).join('\n')
    const content = `function Big() { return <div>${tags}</div> }`
    writeFileSync(resolve(testDir, file), content)

    addNode(store, {
      id: 'fn:Big',
      name: 'Big',
      kind: 'function',
      file,
      line: 1,
      end_line: 1,
    })

    for (let i = 0; i < 40; i++) {
      addNode(store, {
        id: `comp:Comp${i}`,
        name: `Comp${i}`,
        kind: 'component',
        file: `Comp${i}.tsx`,
        line: 1,
      })
    }

    const edges = reactJsxChildEdges(adapter, testDir)
    expect(edges.length).toBeLessThanOrEqual(30)

    rmSync(testDir, { recursive: true, force: true })
  })

  test('returns empty for non-JSX files', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const file = 'plain.ts'
    const content = `const x = 1`
    writeFileSync(resolve(testDir, file), content)

    addNode(store, { id: 'fn:X', name: 'X', kind: 'function', file, line: 1 })

    const edges = reactJsxChildEdges(adapter, testDir)
    expect(edges).toEqual([])

    rmSync(testDir, { recursive: true, force: true })
  })
})

// ============================================================
// 3. vueTemplateEdges
// ============================================================

describe('vueTemplateEdges', () => {
  test('links kebab-case child to PascalCase component', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const file = 'Page.vue'
    const content = `<template><el-button @click="save" /></template>
<script>
function save() {}
</script>`
    writeFileSync(resolve(testDir, file), content)

    addNode(store, { id: 'comp:Page', name: 'Page', kind: 'component', file, line: 1 })
    addNode(store, { id: 'comp:ElButton', name: 'ElButton', kind: 'component', file: 'ElButton.vue', line: 1 })
    addNode(store, { id: 'fn:save', name: 'save', kind: 'function', file, line: 3 })

    const edges = vueTemplateEdges(adapter, testDir)
    const childEdge = edges.find(e => e.metadata.synthesizedBy === 'jsx-render')
    expect(childEdge).toBeDefined()
    expect(childEdge!.target).toBe('comp:ElButton')

    const handlerEdge = edges.find(e => e.metadata.synthesizedBy === 'vue-handler')
    expect(handlerEdge).toBeDefined()
    expect(handlerEdge!.target).toBe('fn:save')
    expect(handlerEdge!.metadata.event).toBe('click')

    rmSync(testDir, { recursive: true, force: true })
  })

  test('skips inline arrow handlers', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const file = 'Page.vue'
    const content = `<template><div @click="() => doStuff()" /></template>
<script></script>`
    writeFileSync(resolve(testDir, file), content)

    addNode(store, { id: 'comp:Page', name: 'Page', kind: 'component', file, line: 1 })

    const edges = vueTemplateEdges(adapter, testDir)
    expect(edges).toEqual([])

    rmSync(testDir, { recursive: true, force: true })
  })

  test('skips $emit references', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const file = 'Page.vue'
    const content = `<template><div @click="$emit('close')" /></template>
<script></script>`
    writeFileSync(resolve(testDir, file), content)

    addNode(store, { id: 'comp:Page', name: 'Page', kind: 'component', file, line: 1 })

    const edges = vueTemplateEdges(adapter, testDir)
    expect(edges).toEqual([])

    rmSync(testDir, { recursive: true, force: true })
  })
})

// ============================================================
// 4. rnEventEdges
// ============================================================

describe('rnEventEdges', () => {
  test('links ObjC sendEventWithName to JS addListener handler', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const objcFile = 'RNFusedLocation.m'
    const objcContent = `@implementation RNFusedLocation
- (void)updateLocation {
  [self sendEventWithName:@"locationUpdate" body:@{@"lat": @0}];
}
@end`
    writeFileSync(resolve(testDir, objcFile), objcContent)

    const jsFile = 'bridge.ts'
    const jsContent = `NativeEventEmitter.addListener("locationUpdate", function onLocation(data) {})`
    writeFileSync(resolve(testDir, jsFile), jsContent)

    addNode(store, {
      id: 'method:RNFusedLocation:updateLocation',
      name: 'updateLocation',
      kind: 'method',
      file: objcFile,
      line: 2,
      end_line: 4,
      language: 'objc',
    })
    addNode(store, {
      id: 'fn:onLocation',
      name: 'onLocation',
      kind: 'function',
      file: jsFile,
      line: 1,
      language: 'typescript',
    })

    const edges = rnEventEdges(adapter, testDir)
    expect(edges.length).toBe(1)
    expect(edges[0].source).toBe('method:RNFusedLocation:updateLocation')
    expect(edges[0].target).toBe('fn:onLocation')
    expect(edges[0].metadata.synthesizedBy).toBe('rn-event-channel')
    expect(edges[0].metadata.event).toBe('locationUpdate')

    rmSync(testDir, { recursive: true, force: true })
  })

  test('links Swift sendEvent to JS addListener handler', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const swiftFile = 'RNFusedLocation.swift'
    const swiftContent = `class RNFusedLocation {
  func updateLocation() {
    sendEvent(withName: "geolocationDidChange", body: locationData)
  }
}`
    writeFileSync(resolve(testDir, swiftFile), swiftContent)

    const jsFile = 'bridge.ts'
    const jsContent = `emitter.addListener("geolocationDidChange", function onGeo(data) {})`
    writeFileSync(resolve(testDir, jsFile), jsContent)

    addNode(store, {
      id: 'method:RNFusedLocation:updateLocation',
      name: 'updateLocation',
      kind: 'method',
      file: swiftFile,
      line: 2,
      end_line: 4,
      language: 'swift',
    })
    addNode(store, {
      id: 'fn:onGeo',
      name: 'onGeo',
      kind: 'function',
      file: jsFile,
      line: 1,
    })

    const edges = rnEventEdges(adapter, testDir)
    expect(edges.length).toBe(1)
    expect(edges[0].metadata.event).toBe('geolocationDidChange')

    rmSync(testDir, { recursive: true, force: true })
  })

  test('links JVM emit to JS addListener handler', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const javaFile = 'LocationModule.java'
    const javaContent = `public class LocationModule {
  void update() {
    emitter.emit("locationUpdate", body);
  }
}`
    writeFileSync(resolve(testDir, javaFile), javaContent)

    const jsFile = 'bridge.ts'
    const jsContent = `DeviceEventEmitter.addListener("locationUpdate", function onLoc(d) {})`
    writeFileSync(resolve(testDir, jsFile), jsContent)

    addNode(store, {
      id: 'method:LocationModule:update',
      name: 'update',
      kind: 'method',
      file: javaFile,
      line: 2,
      end_line: 4,
      language: 'java',
    })
    addNode(store, {
      id: 'fn:onLoc',
      name: 'onLoc',
      kind: 'function',
      file: jsFile,
      line: 1,
    })

    const edges = rnEventEdges(adapter, testDir)
    expect(edges.length).toBe(1)
    expect(edges[0].metadata.event).toBe('locationUpdate')

    rmSync(testDir, { recursive: true, force: true })
  })

  test('respects EVENT_FANOUT_CAP', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const objcFile = 'Senders.m'
    const lines = Array.from({ length: 10 }, () =>
      `  [self sendEventWithName:@"change" body:@{}];`
    ).join('\n')
    writeFileSync(resolve(testDir, objcFile), `@implementation X\n- (void)doIt {\n${lines}\n}\n@end`)

    const jsFile = 'handler.ts'
    writeFileSync(resolve(testDir, jsFile), `emitter.addListener("change", function onChange(d) {})`)

    // 10 separate method nodes each containing one emit
    for (let i = 0; i < 10; i++) {
      addNode(store, {
        id: `method:X:update${i}`,
        name: `update${i}`,
        kind: 'method',
        file: objcFile,
        line: 3 + i,
        end_line: 3 + i,
        language: 'objc',
      })
    }
    addNode(store, { id: 'fn:onChange', name: 'onChange', kind: 'function', file: jsFile, line: 1 })

    const edges = rnEventEdges(adapter, testDir)
    // 10 dispatchers > EVENT_FANOUT_CAP (6) → skipped
    expect(edges).toEqual([])

    rmSync(testDir, { recursive: true, force: true })
  })
})

// ============================================================
// 5. fabricNativeImplEdges
// ============================================================

describe('fabricNativeImplEdges', () => {
  test('links fabric component to native class with exact name', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)

    addNode(store, {
      id: 'fabric-component:RNSScreenStack',
      name: 'RNSScreenStack',
      kind: 'component',
      file: 'specs/ScreenStack.ts',
      line: 1,
    })
    addNode(store, {
      id: 'class:RNSScreenStack',
      name: 'RNSScreenStack',
      kind: 'class',
      file: 'ios/RNSScreenStack.mm',
      line: 1,
      language: 'objc',
    })

    const edges = fabricNativeImplEdges(adapter, '/tmp')
    expect(edges.length).toBe(1)
    expect(edges[0].source).toBe('fabric-component:RNSScreenStack')
    expect(edges[0].target).toBe('class:RNSScreenStack')
    expect(edges[0].metadata.synthesizedBy).toBe('fabric-native-impl')
  })

  test('links to native class with View suffix', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)

    addNode(store, {
      id: 'fabric-component:RNSMap',
      name: 'RNSMap',
      kind: 'component',
      file: 'specs/Map.ts',
      line: 1,
    })
    addNode(store, {
      id: 'class:RNSMapView',
      name: 'RNSMapView',
      kind: 'class',
      file: 'android/RNSMapView.kt',
      line: 1,
      language: 'kotlin',
    })

    const edges = fabricNativeImplEdges(adapter, '/tmp')
    expect(edges.length).toBe(1)
    expect(edges[0].metadata.viaSuffix).toBe('View')
  })

  test('returns empty when no fabric components', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)

    addNode(store, {
      id: 'comp:RegularComponent',
      name: 'RegularComponent',
      kind: 'component',
      file: 'Regular.tsx',
      line: 1,
    })

    const edges = fabricNativeImplEdges(adapter, '/tmp')
    expect(edges).toEqual([])
  })

  test('returns empty when no matching native classes', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)

    addNode(store, {
      id: 'fabric-component:RNSNewFeature',
      name: 'RNSNewFeature',
      kind: 'component',
      file: 'specs/NewFeature.ts',
      line: 1,
    })

    const edges = fabricNativeImplEdges(adapter, '/tmp')
    expect(edges).toEqual([])
  })
})

// ============================================================
// 6. mybatisJavaXmlEdges
// ============================================================

describe('mybatisJavaXmlEdges', () => {
  test('links Java method to XML statement by qualified name', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)

    // Java qualified_name uses ClassName::methodName format
    addNode(store, {
      id: 'method:UserMapper:findById',
      name: 'findById',
      kind: 'method',
      language: 'java',
      file: 'src/UserMapper.java',
      line: 10,
      qualified_name: 'UserMapper::findById',
    })
    // XML qualified_name uses full.namespace.ClassName::id format
    addNode(store, {
      id: 'xml:com.example.UserMapper::findById',
      name: 'findById',
      kind: 'method',
      language: 'xml',
      file: 'resources/UserMapper.xml',
      line: 5,
      qualified_name: 'com.example.UserMapper::findById',
    })

    const edges = mybatisJavaXmlEdges(adapter)
    expect(edges.length).toBe(1)
    expect(edges[0].source).toBe('method:UserMapper:findById')
    expect(edges[0].target).toBe('xml:com.example.UserMapper::findById')
    expect(edges[0].kind).toBe('calls')
    expect(edges[0].metadata.synthesizedBy).toBe('mybatis-java-xml')
  })

  test('drops ambiguous matches (multiple Java classes with same name)', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)

    // Two Java methods with same ClassName::methodName → ambiguous
    addNode(store, {
      id: 'method:UserMapper:findById:a',
      name: 'findById',
      kind: 'method',
      language: 'java',
      qualified_name: 'UserMapper::findById',
      file: 'a/UserMapper.java',
      line: 10,
    })
    addNode(store, {
      id: 'method:UserMapper:findById:b',
      name: 'findById',
      kind: 'method',
      language: 'java',
      qualified_name: 'UserMapper::findById',
      file: 'b/UserMapper.java',
      line: 10,
    })
    addNode(store, {
      id: 'xml:com.a.UserMapper::findById',
      name: 'findById',
      kind: 'method',
      language: 'xml',
      qualified_name: 'com.a.UserMapper::findById',
      file: 'a/UserMapper.xml',
      line: 5,
    })

    const edges = mybatisJavaXmlEdges(adapter)
    expect(edges).toEqual([])
  })

  test('ignores non-Java methods', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)

    addNode(store, {
      id: 'method:ts.Mapper:find',
      name: 'find',
      kind: 'method',
      language: 'typescript',
      qualified_name: 'Mapper::find',
      file: 'mapper.ts',
      line: 1,
    })
    addNode(store, {
      id: 'xml:Mapper::find',
      name: 'find',
      kind: 'method',
      language: 'xml',
      qualified_name: 'Mapper::find',
      file: 'mapper.xml',
      line: 1,
    })

    const edges = mybatisJavaXmlEdges(adapter)
    expect(edges).toEqual([])
  })
})

// ============================================================
// 7. ginMiddlewareChainEdges
// ============================================================

describe('ginMiddlewareChainEdges', () => {
  test('links dispatcher to registered handler', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const engineFile = 'engine.go'
    const engineContent = `package gin

func (engine *Engine) handleHTTPRequest(c *Context) {
  for c.index < len(c.handlers) {
    c.handlers[c.index](c)
    c.index++
  }
}`
    writeFileSync(resolve(testDir, engineFile), engineContent)

    const mainFile = 'main.go'
    const mainContent = `package main

func setupRouter() *gin.Engine {
  r := gin.New()
  r.Use(authMiddleware)
  r.GET("/api", handleAPI)
  return r
}`
    writeFileSync(resolve(testDir, mainFile), mainContent)

    addNode(store, {
      id: 'method:Engine:handleHTTPRequest',
      name: 'handleHTTPRequest',
      kind: 'method',
      language: 'go',
      file: engineFile,
      line: 3,
      end_line: 8,
    })
    addNode(store, {
      id: 'fn:authMiddleware',
      name: 'authMiddleware',
      kind: 'function',
      language: 'go',
      file: mainFile,
      line: 5,
    })
    addNode(store, {
      id: 'fn:handleAPI',
      name: 'handleAPI',
      kind: 'function',
      language: 'go',
      file: mainFile,
      line: 6,
    })

    const edges = ginMiddlewareChainEdges(adapter, testDir)
    expect(edges.length).toBe(2)

    const authEdge = edges.find(e => e.target === 'fn:authMiddleware')
    expect(authEdge).toBeDefined()
    expect(authEdge!.source).toBe('method:Engine:handleHTTPRequest')
    expect(authEdge!.metadata.synthesizedBy).toBe('gin-middleware-chain')
    expect(authEdge!.metadata.via).toBe('authMiddleware')

    const apiEdge = edges.find(e => e.target === 'fn:handleAPI')
    expect(apiEdge).toBeDefined()

    rmSync(testDir, { recursive: true, force: true })
  })

  test('returns empty when no dispatcher found', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const file = 'main.go'
    writeFileSync(resolve(testDir, file), `package main
func main() { r := gin.New(); r.Use(mw) }`)

    addNode(store, {
      id: 'fn:main',
      name: 'main',
      kind: 'function',
      language: 'go',
      file,
      line: 2,
      end_line: 2,
    })

    const edges = ginMiddlewareChainEdges(adapter, testDir)
    expect(edges).toEqual([])

    rmSync(testDir, { recursive: true, force: true })
  })

  test('skips string path arguments but keeps named handlers', () => {
    const { store } = freshStore()
    const adapter = makeAdapter(store)
    const testDir = makeTestDir()

    const engineFile = 'engine.go'
    writeFileSync(resolve(testDir, engineFile), `func (c *Context) Next() {
  c.handlers[c.index](c)
}`)

    const mainFile = 'main.go'
    writeFileSync(resolve(testDir, mainFile), `func setup() {
  r.GET("/path", handler)
}`)

    addNode(store, {
      id: 'method:Context:Next',
      name: 'Next',
      kind: 'method',
      language: 'go',
      file: engineFile,
      line: 1,
      end_line: 3,
    })
    addNode(store, {
      id: 'fn:handler',
      name: 'handler',
      kind: 'function',
      language: 'go',
      file: mainFile,
      line: 2,
    })

    const edges = ginMiddlewareChainEdges(adapter, testDir)
    // "/path" is a string arg (dropped), handler is an ident → 1 edge
    expect(edges.length).toBe(1)
    expect(edges[0].target).toBe('fn:handler')

    rmSync(testDir, { recursive: true, force: true })
  })
})
