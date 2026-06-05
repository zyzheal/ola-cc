/**
 * JSONParser — extracts structure from JSON files (package.json, tsconfig, etc.)
 *
 * Nodes: top-level keys, dependencies, scripts
 * Edges: references between keys, dependency relationships
 */

import type { FileParser, ParserResult, ParsedNode, ParsedEdge } from './types.js'

export class JSONParser implements FileParser {
  readonly name = 'json'
  readonly extensions = ['.json']
  readonly filePatterns = []

  parse(filePath: string, content: string): ParserResult | null {
    const fileName = filePath.split('/').pop() ?? ''

    // package.json — rich parsing
    if (fileName === 'package.json') {
      return this.parsePackageJson(filePath, content)
    }

    // tsconfig.json — reference extraction
    if (fileName.startsWith('tsconfig')) {
      return this.parseTsConfig(filePath, content)
    }

    // Generic JSON — top-level keys
    return this.parseGenericJson(filePath, content)
  }

  private parsePackageJson(filePath: string, content: string): ParserResult {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []

    let pkg: Record<string, unknown>
    try {
      pkg = JSON.parse(content)
    } catch {
      return null
    }

    const pkgName = (pkg.name as string) ?? 'unknown'
    const pkgId = `json:${filePath}:package:${pkgName}`

    nodes.push({
      id: pkgId,
      name: pkgName,
      kind: 'package',
      file: filePath,
      line: 1,
      metadata: { version: pkg.version },
    })

    // Scripts
    const scripts = pkg.scripts as Record<string, string> | undefined
    if (scripts) {
      for (const [name, command] of Object.entries(scripts)) {
        const scriptId = `json:${filePath}:script:${name}`
        nodes.push({
          id: scriptId,
          name,
          kind: 'script',
          file: filePath,
          line: 1,
          metadata: { command },
        })
        edges.push({
          from: pkgId,
          to: scriptId,
          type: 'defines',
        })
      }
    }

    // Dependencies
    const depTypes = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    for (const depType of depTypes) {
      const deps = pkg[depType] as Record<string, string> | undefined
      if (!deps) continue

      for (const [name, version] of Object.entries(deps)) {
        const depId = `json:dep:${name}`
        nodes.push({
          id: depId,
          name,
          kind: 'dependency',
          file: filePath,
          line: 1,
          metadata: { version, type: depType },
        })
        edges.push({
          from: pkgId,
          to: depId,
          type: 'depends',
          metadata: { type: depType },
        })
      }
    }

    // Main/exports
    if (pkg.main) {
      const mainId = `json:${filePath}:entry:${pkg.main}`
      nodes.push({
        id: mainId,
        name: pkg.main as string,
        kind: 'entry',
        file: filePath,
        line: 1,
      })
      edges.push({
        from: pkgId,
        to: mainId,
        type: 'exports',
      })
    }

    // Workspaces
    const workspaces = pkg.workspaces as string[] | undefined
    if (workspaces) {
      for (const ws of workspaces) {
        const wsId = `json:${filePath}:workspace:${ws}`
        nodes.push({
          id: wsId,
          name: ws,
          kind: 'workspace',
          file: filePath,
          line: 1,
        })
        edges.push({
          from: pkgId,
          to: wsId,
          type: 'contains',
        })
      }
    }

    return { nodes, edges, file: filePath, parser: this.name }
  }

  private parseTsConfig(filePath: string, content: string): ParserResult {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []

    let config: Record<string, unknown>
    try {
      config = JSON.parse(content)
    } catch {
      return null
    }

    const configId = `json:${filePath}:tsconfig`
    nodes.push({
      id: configId,
      name: filePath.split('/').pop() ?? 'tsconfig.json',
      kind: 'tsconfig',
      file: filePath,
      line: 1,
    })

    // Extends
    const extendsPath = config.extends as string | undefined
    if (extendsPath) {
      const extendsId = `json:tsconfig:extends:${extendsPath}`
      nodes.push({
        id: extendsId,
        name: extendsPath,
        kind: 'tsconfig',
        file: filePath,
        line: 1,
      })
      edges.push({
        from: configId,
        to: extendsId,
        type: 'extends',
      })
    }

    // References
    const references = config.references as Array<{ path: string }> | undefined
    if (references) {
      for (const ref of references) {
        const refId = `json:tsconfig:ref:${ref.path}`
        nodes.push({
          id: refId,
          name: ref.path,
          kind: 'tsconfig',
          file: filePath,
          line: 1,
        })
        edges.push({
          from: configId,
          to: refId,
          type: 'references',
        })
      }
    }

    return { nodes, edges, file: filePath, parser: this.name }
  }

  private parseGenericJson(filePath: string, content: string): ParserResult {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []

    let data: Record<string, unknown>
    try {
      data = JSON.parse(content)
    } catch {
      return null
    }

    // Extract top-level keys as nodes
    for (const key of Object.keys(data)) {
      const nodeId = `json:${filePath}:key:${key}`
      nodes.push({
        id: nodeId,
        name: key,
        kind: 'section',
        file: filePath,
        line: 1,
        metadata: { type: typeof data[key] },
      })
    }

    // Extract $ref references
    const findRefs = (obj: unknown, path: string) => {
      if (typeof obj !== 'object' || obj === null) return
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (key === '$ref' && typeof value === 'string') {
          const fromId = `json:${filePath}:key:${path}`
          const toId = `json:${filePath}:ref:${value}`
          edges.push({ from: fromId, to: toId, type: 'references' })
        } else if (typeof value === 'object') {
          findRefs(value, `${path}.${key}`)
        }
      }
    }
    findRefs(data, '')

    if (nodes.length === 0) return null
    return { nodes, edges, file: filePath, parser: this.name }
  }
}
