/**
 * ReactResolver.test.ts — Phase 6c-1: React framework resolver tests
 *
 * Tests for:
 * - Detection: project with/without react dependency
 * - JSX component resolution
 * - Hook claims
 * - HOC / Context resolution
 * - Extraction: component, hook, route, and Next.js page nodes
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import type { NodeMetadata } from '../GraphStore.js'
import type { ResolutionContext, UnresolvedRef, FrameworkResolver } from '../resolution/types.js'
import {
  registerFrameworkResolver,
  resetFrameworkResolvers,
  getFrameworkResolver,
  detectFrameworks,
} from '../resolution/frameworks/index.js'
import { reactResolver } from '../resolution/frameworks/react.js'

// ============================================================
// Helpers
// ============================================================

function makeNode(overrides: Partial<NodeMetadata> = {}): NodeMetadata {
  return {
    id: 'n1',
    name: 'testFunc',
    kind: 'function',
    file: 'src/test.ts',
    line: 10,
    language: 'typescript',
    ...overrides,
  }
}

function makeRef(overrides: Partial<UnresolvedRef> = {}): UnresolvedRef {
  return {
    fromNodeId: 'caller1',
    referenceName: 'Foo',
    referenceKind: 'calls',
    line: 10,
    column: 0,
    filePath: 'src/App.tsx',
    language: 'tsx',
    ...overrides,
  }
}

function createMockContext(opts: {
  nodes?: NodeMetadata[]
  files?: string[]
  fileContents?: Record<string, string>
  projectRoot?: string
} = {}): ResolutionContext {
  const nodes = opts.nodes ?? []
  const files = opts.files ?? []
  const fileContents = opts.fileContents ?? {}

  return {
    getNodesInFile(filePath: string): NodeMetadata[] {
      return nodes.filter((n) => n.file === filePath)
    },
    getNodesByName(name: string): NodeMetadata[] {
      return nodes.filter((n) => n.name === name)
    },
    getNodesByQualifiedName(qualifiedName: string): NodeMetadata[] {
      return nodes.filter((n) => n.qualified_name === qualifiedName)
    },
    getNodesByKind(kind: string): NodeMetadata[] {
      return nodes.filter((n) => n.kind === kind)
    },
    fileExists(filePath: string): boolean {
      return files.includes(filePath) || filePath in fileContents
    },
    readFile(filePath: string): string | null {
      return fileContents[filePath] ?? null
    },
    getProjectRoot(): string {
      return opts.projectRoot ?? '/tmp/test-project'
    },
    getAllFiles(): string[] {
      return files
    },
    getNodesByLowerName(_lowerName: string): NodeMetadata[] {
      return []
    },
    getImportMappings(_filePath: string, _language: string) {
      return []
    },
  }
}

// ============================================================
// Tests
// ============================================================

describe('ReactResolver', () => {
  beforeEach(() => {
    resetFrameworkResolvers()
    registerFrameworkResolver(reactResolver)
  })

  afterEach(() => {
    resetFrameworkResolvers()
  })

  // ----------------------------------------------------------
  // Registration
  // ----------------------------------------------------------

  describe('registration', () => {
    it('should be registered and retrievable by name', () => {
      const resolver = getFrameworkResolver('react')
      expect(resolver).toBeDefined()
      expect(resolver!.name).toBe('react')
    })

    it('should declare javascript and typescript languages', () => {
      const resolver = getFrameworkResolver('react')!
      expect(resolver.languages).toContain('javascript')
      expect(resolver.languages).toContain('typescript')
    })
  })

  // ----------------------------------------------------------
  // Detection
  // ----------------------------------------------------------

  describe('detect', () => {
    it('should detect React from package.json dependencies', () => {
      const ctx = createMockContext({
        fileContents: {
          'package.json': JSON.stringify({
            dependencies: { react: '^18.0.0' },
          }),
        },
      })
      expect(reactResolver.detect(ctx)).toBe(true)
    })

    it('should detect React from devDependencies', () => {
      const ctx = createMockContext({
        fileContents: {
          'package.json': JSON.stringify({
            devDependencies: { react: '^18.0.0' },
          }),
        },
      })
      expect(reactResolver.detect(ctx)).toBe(true)
    })

    it('should detect Next.js projects', () => {
      const ctx = createMockContext({
        fileContents: {
          'package.json': JSON.stringify({
            dependencies: { next: '14.0.0' },
          }),
        },
      })
      expect(reactResolver.detect(ctx)).toBe(true)
    })

    it('should detect React Native projects', () => {
      const ctx = createMockContext({
        fileContents: {
          'package.json': JSON.stringify({
            dependencies: { 'react-native': '0.72.0' },
          }),
        },
      })
      expect(reactResolver.detect(ctx)).toBe(true)
    })

    it('should detect React from .tsx files when no package.json', () => {
      const ctx = createMockContext({
        files: ['src/App.tsx', 'src/index.ts'],
      })
      expect(reactResolver.detect(ctx)).toBe(true)
    })

    it('should detect React from .jsx files', () => {
      const ctx = createMockContext({
        files: ['src/App.jsx'],
      })
      expect(reactResolver.detect(ctx)).toBe(true)
    })

    it('should not detect non-React projects', () => {
      const ctx = createMockContext({
        fileContents: {
          'package.json': JSON.stringify({
            dependencies: { express: '^4.0.0' },
          }),
        },
        files: ['src/index.ts'],
      })
      expect(reactResolver.detect(ctx)).toBe(false)
    })

    it('should handle invalid package.json gracefully', () => {
      const ctx = createMockContext({
        fileContents: {
          'package.json': 'not valid json {{{',
        },
        files: ['src/index.ts'],
      })
      expect(reactResolver.detect(ctx)).toBe(false)
    })
  })

  // ----------------------------------------------------------
  // Resolve: Component references (PascalCase)
  // ----------------------------------------------------------

  describe('resolve: component references', () => {
    it('should resolve a PascalCase component reference', () => {
      const nodes = [
        makeNode({ id: 'comp1', name: 'MyComponent', kind: 'component', file: 'src/components/MyComponent.tsx' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'MyComponent', filePath: 'src/App.tsx' })

      const result = reactResolver.resolve(ref, ctx)

      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('comp1')
      expect(result!.confidence).toBe(0.8)
      expect(result!.resolvedBy).toBe('framework')
    })

    it('should resolve PascalCase function kind as component', () => {
      const nodes = [
        makeNode({ id: 'fn1', name: 'Header', kind: 'function', file: 'src/Header.tsx' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'Header' })

      const result = reactResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('fn1')
    })

    it('should resolve PascalCase class kind as component', () => {
      const nodes = [
        makeNode({ id: 'cls1', name: 'LegacyView', kind: 'class', file: 'src/LegacyView.tsx' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'LegacyView' })

      const result = reactResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
    })

    it('should prefer same-directory components', () => {
      const nodes = [
        makeNode({ id: 'same-dir', name: 'Sidebar', kind: 'component', file: 'src/components/Sidebar.tsx' }),
        makeNode({ id: 'other-dir', name: 'Sidebar', kind: 'component', file: 'src/other/Sidebar.tsx' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'Sidebar', filePath: 'src/components/App.tsx' })

      const result = reactResolver.resolve(ref, ctx)
      expect(result!.targetNodeId).toBe('same-dir')
    })

    it('should not resolve built-in type names', () => {
      const ctx = createMockContext({ nodes: [] })
      const builtins = ['Array', 'Object', 'Promise', 'React', 'Component', 'Fragment']
      for (const name of builtins) {
        const ref = makeRef({ referenceName: name })
        const result = reactResolver.resolve(ref, ctx)
        expect(result).toBeNull()
      }
    })

    it('should not resolve non-PascalCase names via component path', () => {
      const ctx = createMockContext({ nodes: [] })
      const ref = makeRef({ referenceName: 'myHelper' })
      const result = reactResolver.resolve(ref, ctx)
      expect(result).toBeNull()
    })
  })

  // ----------------------------------------------------------
  // Resolve: Hook references
  // ----------------------------------------------------------

  describe('resolve: hook references', () => {
    it('should resolve a custom hook reference', () => {
      const nodes = [
        makeNode({ id: 'hook1', name: 'useAuth', kind: 'function', file: 'src/hooks/useAuth.ts' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'useAuth', filePath: 'src/App.tsx' })

      const result = reactResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('hook1')
      expect(result!.confidence).toBe(0.85)
      expect(result!.resolvedBy).toBe('framework')
    })

    it('should prefer hooks from hooks directories', () => {
      const nodes = [
        makeNode({ id: 'in-hooks-dir', name: 'useData', kind: 'function', file: 'src/hooks/useData.ts' }),
        makeNode({ id: 'in-utils', name: 'useData', kind: 'function', file: 'src/utils/useData.ts' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'useData' })

      const result = reactResolver.resolve(ref, ctx)
      expect(result!.targetNodeId).toBe('in-hooks-dir')
    })

    it('should not resolve short use* names (<=3 chars after "use")', () => {
      const ctx = createMockContext({ nodes: [] })
      // "useX" is only 1 char after "use", length check: "useX".length = 4 > 3, so it WILL pass.
      // "use" itself has length 3, which fails length > 3 check.
      const ref = makeRef({ referenceName: 'use' })
      const result = reactResolver.resolve(ref, ctx)
      expect(result).toBeNull()
    })
  })

  // ----------------------------------------------------------
  // Resolve: Context references
  // ----------------------------------------------------------

  describe('resolve: context references', () => {
    it('should resolve a *Context reference', () => {
      const nodes = [
        makeNode({ id: 'ctx1', name: 'AuthContext', kind: 'variable', file: 'src/context/AuthContext.ts' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'AuthContext' })

      const result = reactResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('ctx1')
      expect(result!.confidence).toBe(0.8)
    })

    it('should resolve a *Provider reference', () => {
      const nodes = [
        makeNode({ id: 'prov1', name: 'ThemeProvider', kind: 'function', file: 'src/providers/ThemeProvider.tsx' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'ThemeProvider' })

      const result = reactResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('prov1')
    })

    it('should prefer context from context directories', () => {
      const nodes = [
        makeNode({ id: 'in-ctx-dir', name: 'ThemeContext', kind: 'variable', file: 'src/context/ThemeContext.ts' }),
        makeNode({ id: 'random', name: 'ThemeContext', kind: 'variable', file: 'src/misc/ThemeContext.ts' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'ThemeContext' })

      const result = reactResolver.resolve(ref, ctx)
      expect(result!.targetNodeId).toBe('in-ctx-dir')
    })

    it('should fall back to base name when Context/Provider suffix has no match', () => {
      const nodes = [
        makeNode({ id: 'base', name: 'Auth', kind: 'variable', file: 'src/context/Auth.ts' }),
      ]
      const ctx = createMockContext({ nodes })
      const ref = makeRef({ referenceName: 'AuthContext' })

      const result = reactResolver.resolve(ref, ctx)
      expect(result).not.toBeNull()
      expect(result!.targetNodeId).toBe('base')
    })
  })

  // ----------------------------------------------------------
  // Extract: Components
  // ----------------------------------------------------------

  describe('extract: components', () => {
    it('should extract function component definitions', () => {
      const content = `
export function MyComponent() {
  return <div>Hello</div>
}
`
      const result = reactResolver.extract!('src/MyComponent.tsx', content)

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]!.name).toBe('MyComponent')
      expect(result.nodes[0]!.kind).toBe('component')
      expect(result.nodes[0]!.file).toBe('src/MyComponent.tsx')
      expect(result.nodes[0]!.is_exported).toBe(true)
    })

    it('should extract arrow function components', () => {
      const content = `
const Header = ({ title }) => <h1>{title}</h1>
`
      const result = reactResolver.extract!('src/Header.tsx', content)

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]!.name).toBe('Header')
      expect(result.nodes[0]!.kind).toBe('component')
    })

    it('should extract forwardRef components', () => {
      const content = `
const FancyInput = React.forwardRef((props, ref) => <input ref={ref} />)
`
      const result = reactResolver.extract!('src/FancyInput.tsx', content)

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]!.name).toBe('FancyInput')
    })

    it('should extract memo components', () => {
      const content = `
const MemoComp = memo(({ data }) => <span>{data}</span>)
`
      const result = reactResolver.extract!('src/MemoComp.tsx', content)

      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0]!.name).toBe('MemoComp')
    })

    it('should not extract non-JSX function definitions', () => {
      const content = `
function HelperUtil(x: number) {
  return x * 2
}
`
      const result = reactResolver.extract!('src/util.ts', content)

      // HelperUtil is PascalCase but has no JSX following it
      expect(result.nodes).toHaveLength(0)
    })
  })

  // ----------------------------------------------------------
  // Extract: Hooks
  // ----------------------------------------------------------

  describe('extract: hooks', () => {
    it('should extract custom hook definitions', () => {
      const content = `
export function useAuth() {
  return { user: null, login: () => {} }
}
`
      const result = reactResolver.extract!('src/hooks/useAuth.ts', content)

      const hooks = result.nodes.filter((n) => n.name.startsWith('use'))
      expect(hooks).toHaveLength(1)
      expect(hooks[0]!.name).toBe('useAuth')
      expect(hooks[0]!.kind).toBe('function')
      expect(hooks[0]!.is_exported).toBe(true)
    })

    it('should extract arrow function hooks', () => {
      const content = `
const useData = () => {
  return useState(null)
}
`
      const result = reactResolver.extract!('src/hooks/useData.ts', content)

      const hooks = result.nodes.filter((n) => n.name.startsWith('use'))
      expect(hooks).toHaveLength(1)
      expect(hooks[0]!.name).toBe('useData')
    })
  })

  // ----------------------------------------------------------
  // Extract: React Router routes (v5 component prop)
  // ----------------------------------------------------------

  describe('extract: React Router', () => {
    it('should extract routes with component prop (v5)', () => {
      const content = `
<Switch>
  <Route path="/home" component={HomePage} />
  <Route path="/about" component={AboutPage} />
</Switch>
`
      const result = reactResolver.extract!('src/App.tsx', content)

      const routes = result.nodes.filter((n) => n.kind === 'route')
      expect(routes).toHaveLength(2)
      expect(routes[0]!.name).toBe('/home')
      expect(routes[1]!.name).toBe('/about')
    })

    it('should extract routes with element prop (v6)', () => {
      const content = `
<Routes>
  <Route path="/dashboard" element={<Dashboard />} />
</Routes>
`
      const result = reactResolver.extract!('src/App.tsx', content)

      const routes = result.nodes.filter((n) => n.kind === 'route')
      expect(routes).toHaveLength(1)
      expect(routes[0]!.name).toBe('/dashboard')

      // Should also generate a reference to Dashboard
      expect(result.references).toHaveLength(1)
      expect(result.references[0]!.referenceName).toBe('Dashboard')
    })

    it('should extract data-router routes (v6.4+)', () => {
      const content = `
const router = createBrowserRouter([
  { path: "/", element: <Root /> },
  { path: "/users", element: <UserList /> },
])
`
      const result = reactResolver.extract!('src/router.tsx', content)

      const routes = result.nodes.filter((n) => n.kind === 'route')
      expect(routes).toHaveLength(2)
      expect(routes[0]!.name).toBe('/')
      expect(routes[1]!.name).toBe('/users')

      expect(result.references).toHaveLength(2)
      expect(result.references[0]!.referenceName).toBe('Root')
      expect(result.references[1]!.referenceName).toBe('UserList')
    })
  })

  // ----------------------------------------------------------
  // Extract: Next.js pages
  // ----------------------------------------------------------

  describe('extract: Next.js pages', () => {
    it('should extract Next.js pages directory routes', () => {
      const content = `export default function AboutPage() { return <h1>About</h1> }`
      const result = reactResolver.extract!('pages/about.tsx', content)

      const routes = result.nodes.filter((n) => n.kind === 'route')
      expect(routes).toHaveLength(1)
      expect(routes[0]!.name).toBe('/about')
    })

    it('should extract Next.js index page as /', () => {
      const content = `export default function Home() { return <h1>Home</h1> }`
      const result = reactResolver.extract!('pages/index.tsx', content)

      const routes = result.nodes.filter((n) => n.kind === 'route')
      expect(routes).toHaveLength(1)
      expect(routes[0]!.name).toBe('/')
    })

    it('should extract dynamic Next.js routes', () => {
      const content = `export default function BlogPost() { return <article /> }`
      const result = reactResolver.extract!('pages/blog/[slug].tsx', content)

      const routes = result.nodes.filter((n) => n.kind === 'route')
      expect(routes).toHaveLength(1)
      expect(routes[0]!.name).toBe('/blog/:slug')
    })

    it('should extract app directory page routes', () => {
      const content = `export default function DashboardPage() { return <div /> }`
      const result = reactResolver.extract!('app/dashboard/page.tsx', content)

      const routes = result.nodes.filter((n) => n.kind === 'route')
      expect(routes).toHaveLength(1)
      expect(routes[0]!.name).toBe('/dashboard')
    })

    it('should not extract non-page files in pages directory', () => {
      const content = `export default {}`
      const result = reactResolver.extract!('pages/utils.mjs', content)

      const routes = result.nodes.filter((n) => n.kind === 'route')
      expect(routes).toHaveLength(0)
    })

    it('should not extract _app or _document as routes', () => {
      const content = `export default function App({ Component }) { return <Component /> }`
      const result1 = reactResolver.extract!('pages/_app.tsx', content)
      const result2 = reactResolver.extract!('pages/_document.tsx', content)

      expect(result1.nodes.filter((n) => n.kind === 'route')).toHaveLength(0)
      expect(result2.nodes.filter((n) => n.kind === 'route')).toHaveLength(0)
    })
  })
})
