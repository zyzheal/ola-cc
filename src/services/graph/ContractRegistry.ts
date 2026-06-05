/**
 * ContractRegistry — Module contract extraction and lookup (F-103)
 *
 * Extracts module contracts from graph data (nodeMeta + adjacency):
 * - Exports: function, class, type, const declarations
 * - APIs: HTTP handler patterns (GET/POST/PUT/DELETE)
 * - Events: emit/subscribe patterns
 * - Dependencies: module-level imports
 *
 * Design doc: F-103 Module Contract Registry
 */

import type { GraphStore, NodeMetadata, EdgeMeta } from './GraphStore.js'

// ============================================================
// Types
// ============================================================

export interface ContractExport {
  name: string
  kind: string             // function, class, type, const, interface, enum
  signature?: string
  isDefault: boolean
}

export interface ContractApi {
  method: string           // GET, POST, PUT, DELETE, PATCH, ALL
  path: string
  handler: string
  middleware?: string[]
}

export interface ContractEvent {
  name: string
  type: 'emit' | 'subscribe'
  payload?: string
}

export interface ModuleContract {
  module: string           // file path
  exports: ContractExport[]
  apis: ContractApi[]
  events: ContractEvent[]
  dependencies: string[]   // modules this depends on
}

// ============================================================
// ContractRegistry
// ============================================================

export class ContractRegistry {
  private contracts = new Map<string, ModuleContract>()

  constructor(private store: GraphStore) {}

  /**
   * Extract contracts from all loaded graph data
   */
  extractAll(): void {
    this.contracts.clear()

    // Group nodes by file
    const fileNodes = new Map<string, NodeMetadata[]>()
    for (const node of this.store.nodeMeta.values()) {
      if (!node.file) continue
      const list = fileNodes.get(node.file)
      if (list) {
        list.push(node)
      } else {
        fileNodes.set(node.file, [node])
      }
    }

    // Build contract for each file
    for (const [file, nodes] of fileNodes) {
      const contract = this.extractModuleContract(file, nodes)
      this.contracts.set(file, contract)
    }
  }

  /**
   * Get contract for a specific module
   */
  getContract(filePath: string): ModuleContract | undefined {
    return this.contracts.get(filePath)
  }

  /**
   * Find modules matching a contract pattern
   */
  findModules(pattern: Partial<ModuleContract>): string[] {
    const results: string[] = []

    for (const [file, contract] of this.contracts) {
      if (pattern.module && !file.includes(pattern.module)) continue

      if (pattern.exports && pattern.exports.length > 0) {
        const hasExport = pattern.exports.some(pe =>
          contract.exports.some(ce =>
            (!pe.name || ce.name.includes(pe.name)) &&
            (!pe.kind || ce.kind === pe.kind),
          ),
        )
        if (!hasExport) continue
      }

      if (pattern.apis && pattern.apis.length > 0) {
        const hasApi = pattern.apis.some(pa =>
          contract.apis.some(ca =>
            (!pa.method || ca.method === pa.method) &&
            (!pa.path || ca.path.includes(pa.path)),
          ),
        )
        if (!hasApi) continue
      }

      if (pattern.events && pattern.events.length > 0) {
        const hasEvent = pattern.events.some(pe =>
          contract.events.some(ce =>
            (!pe.name || ce.name.includes(pe.name)) &&
            (!pe.type || ce.type === pe.type),
          ),
        )
        if (!hasEvent) continue
      }

      if (pattern.dependencies && pattern.dependencies.length > 0) {
        const hasDep = pattern.dependencies.some(pd =>
          contract.dependencies.some(cd => cd.includes(pd)),
        )
        if (!hasDep) continue
      }

      results.push(file)
    }

    return results
  }

  /**
   * Export all contracts as JSON string
   */
  exportToJson(): string {
    const obj: Record<string, ModuleContract> = {}
    for (const [file, contract] of this.contracts) {
      obj[file] = contract
    }
    return JSON.stringify(obj, null, 2)
  }

  /**
   * Get number of registered contracts
   */
  get size(): number {
    return this.contracts.size
  }

  // ============================================================
  // Internal extraction
  // ============================================================

  private extractModuleContract(file: string, nodes: NodeMetadata[]): ModuleContract {
    const exports: ContractExport[] = []
    const apis: ContractApi[] = []
    const events: ContractEvent[] = []
    const dependencySet = new Set<string>()

    for (const node of nodes) {
      // Extract exports
      if (this.isExported(node)) {
        exports.push({
          name: node.name,
          kind: node.kind,
          signature: node.signature,
          isDefault: node.name === 'default' || node.name === 'DefaultExport',
        })
      }

      // Extract API handlers
      const api = this.detectApiHandler(node)
      if (api) apis.push(api)

      // Extract events
      const nodeEvents = this.detectEvents(node)
      events.push(...nodeEvents)
    }

    // Extract dependencies from imports edges
    for (const node of nodes) {
      const outEdges = this.store.getOutEdges(node.id)
      for (const [target, edges] of outEdges) {
        const hasImport = edges.some(e => e.type === 'imports')
        if (hasImport) {
          const targetNode = this.store.getNode(target)
          if (targetNode?.file && targetNode.file !== file) {
            dependencySet.add(targetNode.file)
          }
        }
      }
    }

    return {
      module: file,
      exports,
      apis,
      events,
      dependencies: [...dependencySet],
    }
  }

  private isExported(node: NodeMetadata): boolean {
    // Explicit is_exported flag
    if (node.is_exported === true) return true

    // Kind contains 'export'
    if (node.kind.includes('export')) return true

    // Visibility is 'public' or 'export'
    if (node.visibility === 'public' || node.visibility === 'export') return true

    // Has export edges pointing to it
    const inEdges = this.store.getInEdges(node.id)
    for (const [, edges] of inEdges) {
      if (edges.some(e => e.type === 'exports')) return true
    }

    return false
  }

  private detectApiHandler(node: NodeMetadata): ContractApi | null {
    const name = node.name.toLowerCase()
    const sig = (node.signature ?? '').toLowerCase()

    // Pattern: function/method names containing HTTP verbs + path hints
    const httpMethods = ['get', 'post', 'put', 'delete', 'patch'] as const

    for (const method of httpMethods) {
      // Express-style: app.get('/path', handler)
      // NestJS-style: @Get('/path')
      // Next.js-style: GET(req)
      if (name === method || name.startsWith(method) || sig.includes(`@${method}`) || sig.includes(`${method}(`)) {
        // Try to extract path from signature or decorators
        const pathMatch = (node.signature ?? '').match(/['"`](\/[^\s'"`]+)['"`]/)
        const path = pathMatch ? pathMatch[1]! : `/${name.replace(method, '').replace(/_/g, '/')}`

        // Extract middleware from decorators
        const middleware = (node.decorators ?? [])
          .filter(d => d.toLowerCase().includes('middleware') || d.toLowerCase().includes('guard'))
          .map(d => d)

        return {
          method: method.toUpperCase(),
          path: path || '/',
          handler: node.name,
          middleware: middleware.length > 0 ? middleware : undefined,
        }
      }
    }

    return null
  }

  private detectEvents(node: NodeMetadata): ContractEvent[] {
    const events: ContractEvent[] = []
    const name = node.name.toLowerCase()
    const sig = (node.signature ?? '').toLowerCase()

    // Emit patterns: emit, emitEvent, dispatch, publish, send, trigger
    if (name.includes('emit') || name.includes('dispatch') || name.includes('publish') || sig.includes('.emit(')) {
      events.push({
        name: node.name,
        type: 'emit',
        payload: node.signature,
      })
    }

    // Subscribe patterns: on, subscribe, listen, handle, observe
    if (name.startsWith('on') || name.includes('subscribe') || name.includes('listen') || sig.includes('.on(') || sig.includes('.subscribe(')) {
      events.push({
        name: node.name,
        type: 'subscribe',
        payload: node.signature,
      })
    }

    // Check graph edges for publish/subscribe types
    const outEdges = this.store.getOutEdges(node.id)
    for (const [, edges] of outEdges) {
      for (const edge of edges) {
        if (edge.type === 'publishes') {
          events.push({ name: node.name, type: 'emit' })
        }
        if (edge.type === 'subscribes') {
          events.push({ name: node.name, type: 'subscribe' })
        }
      }
    }

    // Deduplicate
    const seen = new Set<string>()
    return events.filter(e => {
      const key = `${e.name}:${e.type}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
}
