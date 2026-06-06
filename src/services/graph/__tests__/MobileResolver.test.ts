/**
 * MobileResolver.test.ts — Phase 6c-2: React Native + Fabric + Expo framework resolvers
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { reactNativeBridgeResolver } from '../resolution/frameworks/react-native.js'
import { fabricViewResolver } from '../resolution/frameworks/fabric.js'
import { expoModulesResolver } from '../resolution/frameworks/expo-modules.js'
import {
  registerFrameworkResolver,
  resetFrameworkResolvers,
  getAllFrameworkResolvers,
} from '../resolution/frameworks/index.js'
import type { ResolutionContext, UnresolvedRef, FrameworkExtractionResult } from '../resolution/types.js'
import type { NodeMetadata } from '../GraphStore.js'

// ============================================================
// Test helpers
// ============================================================

function makeContext(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    ...overrides,
  }
}

function makeRef(overrides: Partial<UnresolvedRef> = {}): UnresolvedRef {
  return {
    fromNodeId: 'node-1',
    referenceName: 'getPosition',
    referenceKind: 'calls',
    line: 10,
    column: 0,
    filePath: 'src/App.tsx',
    language: 'typescript',
    ...overrides,
  }
}

function makeMethodNode(overrides: Partial<NodeMetadata> = {}): NodeMetadata {
  return {
    id: 'method-1',
    name: 'getPosition',
    kind: 'method',
    file: 'ios/Geolocation.m',
    line: 10,
    language: 'objc',
    ...overrides,
  }
}

// ============================================================
// React Native Bridge Resolver
// ============================================================

describe('React Native Bridge Resolver', () => {
  describe('detect', () => {
    it('detects react-native in package.json dependencies', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ dependencies: { 'react-native': '^0.72.0' } })
          }
          return null
        },
      })
      expect(reactNativeBridgeResolver.detect(ctx)).toBe(true)
    })

    it('detects react-native in devDependencies', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ devDependencies: { 'react-native': '^0.72.0' } })
          }
          return null
        },
      })
      expect(reactNativeBridgeResolver.detect(ctx)).toBe(true)
    })

    it('detects RCT_EXPORT_MODULE in ObjC files', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'ios/Geolocation.m') return '@implementation Geolocation\nRCT_EXPORT_MODULE()\n@end'
          return null
        },
        getAllFiles: () => ['ios/Geolocation.m'],
      })
      expect(reactNativeBridgeResolver.detect(ctx)).toBe(true)
    })

    it('detects TurboModuleRegistry in TS files', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'src/NativeGeolocation.ts') {
            return "import { TurboModuleRegistry } from 'react-native';\nexport default TurboModuleRegistry.getEnforcing<Spec>('Geolocation');"
          }
          return null
        },
        getAllFiles: () => ['src/NativeGeolocation.ts'],
      })
      expect(reactNativeBridgeResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no RN indicators', () => {
      const ctx = makeContext({
        readFile: () => JSON.stringify({ dependencies: { react: '^18.0.0' } }),
        getAllFiles: () => ['src/App.tsx'],
      })
      expect(reactNativeBridgeResolver.detect(ctx)).toBe(false)
    })
  })

  describe('claimsReference', () => {
    it('returns false for all names (relies on normal resolution path)', () => {
      expect(reactNativeBridgeResolver.claimsReference!('getPosition')).toBe(false)
      expect(reactNativeBridgeResolver.claimsReference!('NativeModules')).toBe(false)
    })
  })

  describe('resolve', () => {
    it('resolves JS method call to native ObjC implementation', () => {
      const nativeNode = makeMethodNode({
        id: 'objc-getPosition',
        name: 'getPosition',
        file: 'ios/Geolocation.m',
        language: 'objc',
      })
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'ios/Geolocation.m') {
            return '@implementation Geolocation\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(getPosition:(RCTResponseSenderBlock)callback)\n@end'
          }
          return null
        },
        getAllFiles: () => ['ios/Geolocation.m'],
        getNodesByKind: (kind) => {
          if (kind === 'method') return [nativeNode]
          return []
        },
      })
      const ref = makeRef({ referenceName: 'getPosition', language: 'typescript' })
      const result = reactNativeBridgeResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('objc-getPosition')
      expect(result!.confidence).toBe(0.6)
      expect(result!.resolvedBy).toBe('framework')
    })

    it('strips dot-qualified reference names', () => {
      const nativeNode = makeMethodNode({
        id: 'objc-getPosition',
        name: 'getPosition',
        file: 'ios/Geolocation.m',
        language: 'objc',
      })
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'ios/Geolocation.m') {
            return '@implementation Geolocation\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(getPosition:(RCTResponseSenderBlock)callback)\n@end'
          }
          return null
        },
        getAllFiles: () => ['ios/Geolocation.m'],
        getNodesByKind: (kind) => {
          if (kind === 'method') return [nativeNode]
          return []
        },
      })
      const ref = makeRef({ referenceName: 'Geo.getPosition', language: 'typescript' })
      const result = reactNativeBridgeResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('objc-getPosition')
    })

    it('resolves TurboModule spec methods to native implementations', () => {
      const objcNode = makeMethodNode({
        id: 'objc-getCurrentPosition',
        name: 'getCurrentPosition',
        file: 'ios/RNGeolocation.mm',
        language: 'objc',
      })
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'src/NativeGeolocation.ts') {
            return `import { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  getCurrentPosition(options: Object): Promise<Object>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Geolocation');`
          }
          if (path === 'ios/RNGeolocation.mm') return ''
          return null
        },
        getAllFiles: () => ['src/NativeGeolocation.ts', 'ios/RNGeolocation.mm'],
        getNodesByKind: (kind) => {
          if (kind === 'method') return [objcNode]
          return []
        },
      })
      const ref = makeRef({ referenceName: 'getCurrentPosition', language: 'typescript' })
      const result = reactNativeBridgeResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('objc-getCurrentPosition')
    })

    it('prefers ObjC over JVM targets', () => {
      const objcNode = makeMethodNode({
        id: 'objc-getPosition',
        name: 'getPosition',
        file: 'ios/Geolocation.m',
        language: 'objc',
      })
      const javaNode: NodeMetadata = {
        id: 'java-getPosition',
        name: 'getPosition',
        kind: 'method',
        file: 'android/GeolocationModule.java',
        line: 20,
        language: 'java',
      }
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'ios/Geolocation.m') {
            return '@implementation Geolocation\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(getPosition:(RCTResponseSenderBlock)callback)\n@end'
          }
          if (path === 'android/GeolocationModule.java') {
            return 'class GeolocationModule extends ReactContextBaseJavaModule {\n  @ReactMethod public void getPosition(Callback cb) {}\n}'
          }
          return null
        },
        getAllFiles: () => ['ios/Geolocation.m', 'android/GeolocationModule.java'],
        getNodesByKind: (kind) => {
          if (kind === 'method') return [objcNode, javaNode]
          return []
        },
      })
      const ref = makeRef({ referenceName: 'getPosition', language: 'typescript' })
      const result = reactNativeBridgeResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('objc-getPosition')
    })

    it('filters emitter builtins (addListener, removeListeners)', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'ios/Event.m') {
            return '@implementation Event\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(addListener:(NSString*)name)\nRCT_EXPORT_METHOD(removeListeners:(int)count)\nRCT_EXPORT_METHOD(getData:(RCTResponseSenderBlock)cb)\n@end'
          }
          return null
        },
        getAllFiles: () => ['ios/Event.m'],
        getNodesByKind: (kind) => {
          if (kind === 'method') {
            return [
              makeMethodNode({ id: 'addListener', name: 'addListener', file: 'ios/Event.m' }),
              makeMethodNode({ id: 'removeListeners', name: 'removeListeners', file: 'ios/Event.m' }),
              makeMethodNode({ id: 'getData', name: 'getData', file: 'ios/Event.m' }),
            ]
          }
          return []
        },
      })
      // addListener should not resolve (it's a builtin)
      const refBuiltin = makeRef({ referenceName: 'addListener', language: 'typescript' })
      expect(reactNativeBridgeResolver.resolve(refBuiltin, ctx)).toBeNull()

      // getData should resolve
      const refNormal = makeRef({ referenceName: 'getData', language: 'typescript' })
      const result = reactNativeBridgeResolver.resolve(refNormal, ctx)
      expect(result).not.toBeNull()
    })

    it('returns null for native-language references', () => {
      const ref = makeRef({ referenceName: 'getPosition', language: 'objc' })
      expect(reactNativeBridgeResolver.resolve(ref, makeContext())).toBeNull()
    })

    it('returns null when no matching native method found', () => {
      const ctx = makeContext({
        readFile: () => null,
        getAllFiles: () => [],
        getNodesByKind: () => [],
      })
      const ref = makeRef({ referenceName: 'nonExistentMethod', language: 'typescript' })
      expect(reactNativeBridgeResolver.resolve(ref, ctx)).toBeNull()
    })
  })
})

// ============================================================
// Fabric View Resolver
// ============================================================

describe('Fabric View Resolver', () => {
  describe('detect', () => {
    it('detects react-native in package.json', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ dependencies: { 'react-native': '^0.72.0' } })
          }
          return null
        },
      })
      expect(fabricViewResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no RN indicators', () => {
      const ctx = makeContext({
        readFile: () => JSON.stringify({ dependencies: { react: '^18.0.0' } }),
        getAllFiles: () => ['src/App.tsx'],
      })
      expect(fabricViewResolver.detect(ctx)).toBe(false)
    })
  })

  describe('extract', () => {
    it('extracts Fabric Codegen component from TS spec', () => {
      const source = `import { codegenNativeComponent } from 'react-native';
import type { ViewProps } from 'react-native';

export interface NativeProps extends ViewProps {
  color?: string;
  onTap?: () => void;
}

export default codegenNativeComponent<NativeProps>('MyComponent');`

      const result = fabricViewResolver.extract!('src/fabric/MyComponentNativeComponent.ts', source)
      expect(result.nodes.length).toBeGreaterThan(0)
      const component = result.nodes.find((n) => n.kind === 'component')
      expect(component).toBeDefined()
      expect(component!.name).toBe('MyComponent')
    })

    it('extracts NativeProps interface properties', () => {
      const source = `import { codegenNativeComponent } from 'react-native';
import type { ViewProps } from 'react-native';

export interface NativeProps extends ViewProps {
  color?: string;
  onTap?: () => void;
  size: number;
}

export default codegenNativeComponent<NativeProps>('ColorPicker');`

      const result = fabricViewResolver.extract!('src/fabric/ColorPickerNativeComponent.tsx', source)
      const props = result.nodes.filter((n) => n.kind === 'property')
      const propNames = props.map((p) => p.name)
      expect(propNames).toContain('color')
      expect(propNames).toContain('onTap')
      expect(propNames).toContain('size')
    })

    it('extracts legacy ObjC ViewManager component', () => {
      const source = `@implementation RCTMyViewManager

RCT_EXPORT_MODULE()
RCT_EXPORT_VIEW_PROPERTY(color, UIColor)
RCT_EXPORT_VIEW_PROPERTY(onTap, RCTBubblingEventBlock)

@end`

      const result = fabricViewResolver.extract!('ios/RCTMyViewManager.m', source)
      expect(result.nodes.length).toBeGreaterThan(0)
      const component = result.nodes.find((n) => n.kind === 'component')
      expect(component).toBeDefined()
      // RCTMyViewManager -> strip RCT -> MyViewManager -> strip ViewManager -> My
      expect(component!.name).toBe('My')
    })

    it('extracts legacy ObjC view property nodes', () => {
      const source = `@implementation RCTMyViewManager

RCT_EXPORT_MODULE()
RCT_EXPORT_VIEW_PROPERTY(color, UIColor)
RCT_EXPORT_VIEW_PROPERTY(onTap, RCTBubblingEventBlock)

@end`

      const result = fabricViewResolver.extract!('ios/RCTMyViewManager.m', source)
      const props = result.nodes.filter((n) => n.kind === 'property')
      const propNames = props.map((p) => p.name)
      expect(propNames).toContain('color')
      expect(propNames).toContain('onTap')
    })

    it('extracts Android ViewManager with @ReactProp', () => {
      const source = `class MyViewManager extends SimpleViewManager<MyView> {
  @ReactProp(name = "color")
  fun setColor(view: MyView, color: String) {}

  @ReactProp(name = "size")
  fun setSize(view: MyView, size: Int) {}
}`

      const result = fabricViewResolver.extract!('android/MyViewManager.kt', source)
      const component = result.nodes.find((n) => n.kind === 'component')
      expect(component).toBeDefined()
      // MyViewManager -> strip ViewManager -> My
      expect(component!.name).toBe('My')
      const props = result.nodes.filter((n) => n.kind === 'property')
      const propNames = props.map((p) => p.name)
      expect(propNames).toContain('color')
      expect(propNames).toContain('size')
    })

    it('returns empty for non-Fabric files', () => {
      const result = fabricViewResolver.extract!('src/utils/helper.ts', 'export const x = 1')
      expect(result.nodes.length).toBe(0)
    })

    it('returns empty for ObjC files without ViewManager macros', () => {
      const result = fabricViewResolver.extract!('ios/Helper.m', '@implementation Helper\n@end')
      expect(result.nodes.length).toBe(0)
    })
  })

  describe('resolve', () => {
    it('returns null (companion synthesizer handles cross-language edges)', () => {
      const ref = makeRef({ referenceName: 'MyComponent' })
      expect(fabricViewResolver.resolve(ref, makeContext())).toBeNull()
    })
  })
})

// ============================================================
// Expo Modules Resolver
// ============================================================

describe('Expo Modules Resolver', () => {
  describe('detect', () => {
    it('detects expo-modules-core in package.json', () => {
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'package.json') {
            return JSON.stringify({ dependencies: { 'expo-modules-core': '^1.0.0' } })
          }
          return null
        },
      })
      expect(expoModulesResolver.detect(ctx)).toBe(true)
    })

    it('detects Expo Module DSL in Swift files', () => {
      const source = `class HapticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHaptics")
    AsyncFunction("notificationAsync") { }
  }
}`
      const ctx = makeContext({
        readFile: (path) => {
          if (path === 'ios/HapticsModule.swift') return source
          return null
        },
        getAllFiles: () => ['ios/HapticsModule.swift'],
      })
      expect(expoModulesResolver.detect(ctx)).toBe(true)
    })

    it('returns false when no Expo indicators', () => {
      const ctx = makeContext({
        readFile: () => JSON.stringify({ dependencies: { react: '^18.0.0' } }),
        getAllFiles: () => ['src/App.tsx'],
      })
      expect(expoModulesResolver.detect(ctx)).toBe(false)
    })
  })

  describe('extract', () => {
    it('extracts AsyncFunction declarations from Swift module', () => {
      const source = `class HapticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHaptics")
    AsyncFunction("notificationAsync") { }
    AsyncFunction("impactAsync") { }
    Function("selectionAsync") { }
  }
}`

      const result = expoModulesResolver.extract!('ios/HapticsModule.swift', source)
      const methodNames = result.nodes.map((n) => n.name)
      expect(methodNames).toContain('notificationAsync')
      expect(methodNames).toContain('impactAsync')
      expect(methodNames).toContain('selectionAsync')
    })

    it('extracts Property declarations', () => {
      const source = `class CameraModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoCamera")
    Property("isAvailable") { true }
    AsyncFunction("takePictureAsync") { }
  }
}`

      const result = expoModulesResolver.extract!('ios/CameraModule.swift', source)
      const methodNames = result.nodes.map((n) => n.name)
      expect(methodNames).toContain('isAvailable')
      expect(methodNames).toContain('takePictureAsync')
    })

    it('extracts Kotlin module declarations', () => {
      const source = `class HapticsModule : Module {
  override fun definition() = module {
    Name("ExpoHaptics")
    AsyncFunction("notificationAsync") { }
    AsyncFunction("impactAsync") { }
  }
}`

      const result = expoModulesResolver.extract!('android/HapticsModule.kt', source)
      const methodNames = result.nodes.map((n) => n.name)
      expect(methodNames).toContain('notificationAsync')
      expect(methodNames).toContain('impactAsync')
      // Verify language is kotlin
      expect(result.nodes[0]!.language).toBe('kotlin')
    })

    it('uses Name() literal as module name in qualifiedName', () => {
      const source = `class HapticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHaptics")
    AsyncFunction("notificationAsync") { }
  }
}`

      const result = expoModulesResolver.extract!('ios/HapticsModule.swift', source)
      expect(result.nodes.length).toBeGreaterThan(0)
      expect(result.nodes[0]!.qualified_name).toContain('ExpoHaptics')
      expect(result.nodes[0]!.qualified_name).toContain('notificationAsync')
    })

    it('returns empty for non-Expo Swift files', () => {
      const source = `class MyViewModel {
  func loadData() { }
}`
      const result = expoModulesResolver.extract!('ios/MyViewModel.swift', source)
      expect(result.nodes.length).toBe(0)
    })

    it('returns empty for Module class without DSL calls', () => {
      const source = `class FakeModule: Module {
  // No Function/AsyncFunction/Property calls
}`
      const result = expoModulesResolver.extract!('ios/FakeModule.swift', source)
      expect(result.nodes.length).toBe(0)
    })
  })

  describe('resolve', () => {
    it('returns null (standard name-matcher handles resolution)', () => {
      const ref = makeRef({ referenceName: 'takePictureAsync' })
      expect(expoModulesResolver.resolve(ref, makeContext())).toBeNull()
    })
  })
})

// ============================================================
// Registration
// ============================================================

describe('Mobile Framework Registration', () => {
  beforeEach(() => {
    resetFrameworkResolvers()
  })

  it('registers all three mobile resolvers', () => {
    registerFrameworkResolver(reactNativeBridgeResolver)
    registerFrameworkResolver(fabricViewResolver)
    registerFrameworkResolver(expoModulesResolver)
    const all = getAllFrameworkResolvers()
    expect(all.length).toBe(3)
    expect(all.find((r) => r.name === 'react-native-bridge')).toBeDefined()
    expect(all.find((r) => r.name === 'fabric-view')).toBeDefined()
    expect(all.find((r) => r.name === 'expo-modules')).toBeDefined()
  })

  it('replaces existing resolver with same name', () => {
    registerFrameworkResolver(reactNativeBridgeResolver)
    const updated = { ...reactNativeBridgeResolver, name: 'react-native-bridge' }
    registerFrameworkResolver(updated)
    expect(getAllFrameworkResolvers().length).toBe(1)
  })
})
