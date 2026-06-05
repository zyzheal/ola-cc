/**
 * OpenAPIParser — extracts paths, schemas, and operations from OpenAPI/Swagger specs.
 *
 * Nodes: paths, operations (GET/POST/etc), schemas/models
 * Edges: path contains operation, operation references schema, operation returns schema
 */

import type { FileParser, ParserResult, ParsedNode, ParsedEdge } from './types.js'

export class OpenAPIParser implements FileParser {
  readonly name = 'openapi'
  readonly extensions = ['.json', '.yaml', '.yml']
  readonly filePatterns = []

  parse(filePath: string, content: string): ParserResult | null {
    // Detect OpenAPI spec
    if (!content.includes('"openapi"') && !content.includes('"swagger"') &&
        !content.includes('openapi:') && !content.includes('swagger:')) {
      return null
    }

    // Only parse files that look like API specs
    const fileName = filePath.split('/').pop()?.toLowerCase() ?? ''
    if (!fileName.includes('openapi') && !fileName.includes('swagger') &&
        !fileName.includes('api-spec') && !fileName.includes('api_spec')) {
      // Check content structure
      if (!content.includes('"paths"') && !content.includes('paths:')) return null
    }

    // Parse as JSON (simpler than YAML)
    let spec: Record<string, unknown>
    try {
      spec = JSON.parse(content)
    } catch {
      // Try minimal YAML extraction for paths
      return this.parseYamlLike(filePath, content)
    }

    return this.parseSpec(filePath, spec)
  }

  private parseSpec(filePath: string, spec: Record<string, unknown>): ParserResult {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []

    const info = spec.info as Record<string, unknown> | undefined
    const apiTitle = (info?.title as string) ?? 'API'
    const apiId = `openapi:${filePath}:api:${apiTitle}`

    nodes.push({
      id: apiId,
      name: apiTitle,
      kind: 'api',
      file: filePath,
      line: 1,
      metadata: { version: info?.version },
    })

    // Paths
    const paths = spec.paths as Record<string, Record<string, unknown>> | undefined
    if (paths) {
      for (const [path, methods] of Object.entries(paths)) {
        const pathId = `openapi:${filePath}:path:${path}`
        nodes.push({
          id: pathId,
          name: path,
          kind: 'path',
          file: filePath,
          line: 1,
        })
        edges.push({
          from: apiId,
          to: pathId,
          type: 'contains',
        })

        // Operations (GET, POST, PUT, DELETE, etc.)
        const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']
        for (const method of httpMethods) {
          const operation = methods[method] as Record<string, unknown> | undefined
          if (!operation) continue

          const opId = `openapi:${filePath}:op:${method}:${path}`
          const opName = (operation.operationId as string) ?? `${method.toUpperCase()} ${path}`
          nodes.push({
            id: opId,
            name: opName,
            kind: 'operation',
            file: filePath,
            line: 1,
            metadata: { method, path, tags: operation.tags },
          })
          edges.push({
            from: pathId,
            to: opId,
            type: 'contains',
          })

          // Request body schema references
          const requestBody = operation.requestBody as Record<string, unknown> | undefined
          const content = requestBody?.content as Record<string, Record<string, unknown>> | undefined
          if (content) {
            for (const mediaType of Object.values(content)) {
              const schema = mediaType?.schema as Record<string, unknown> | undefined
              const ref = schema?.$ref as string | undefined
              if (ref) {
                const schemaName = ref.split('/').pop() ?? ref
                edges.push({
                  from: opId,
                  to: `openapi:${filePath}:schema:${schemaName}`,
                  type: 'references',
                })
              }
            }
          }

          // Response schema references
          const responses = operation.responses as Record<string, Record<string, unknown>> | undefined
          if (responses) {
            for (const [status, resp] of Object.entries(responses)) {
              const respContent = resp.content as Record<string, Record<string, unknown>> | undefined
              if (respContent) {
                for (const mediaType of Object.values(respContent)) {
                  const schema = mediaType?.schema as Record<string, unknown> | undefined
                  const ref = schema?.$ref as string | undefined
                  if (ref) {
                    const schemaName = ref.split('/').pop() ?? ref
                    edges.push({
                      from: opId,
                      to: `openapi:${filePath}:schema:${schemaName}`,
                      type: 'returns',
                      metadata: { status },
                    })
                  }
                }
              }
            }
          }
        }
      }
    }

    // Schemas
    const components = spec.components as Record<string, unknown> | undefined
    const schemas = (components?.schemas as Record<string, unknown>) ?? (spec.definitions as Record<string, unknown>)
    if (schemas) {
      for (const [name, schema] of Object.entries(schemas)) {
        const schemaId = `openapi:${filePath}:schema:${name}`
        nodes.push({
          id: schemaId,
          name,
          kind: 'schema',
          file: filePath,
          line: 1,
        })

        // Schema property references
        const schemaObj = schema as Record<string, unknown>
        const properties = schemaObj.properties as Record<string, Record<string, unknown>> | undefined
        if (properties) {
          for (const [, prop] of Object.entries(properties)) {
            const ref = prop.$ref as string | undefined
            if (ref) {
              const refName = ref.split('/').pop() ?? ref
              edges.push({
                from: schemaId,
                to: `openapi:${filePath}:schema:${refName}`,
                type: 'references',
              })
            }
          }
        }
      }
    }

    return { nodes, edges, file: filePath, parser: this.name }
  }

  private parseYamlLike(filePath: string, content: string): ParserResult {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []

    // Extract paths from YAML-like content
    const pathMatches = content.matchAll(/^\s{2}(\/\S+):/gm)
    for (const match of pathMatches) {
      const pathId = `openapi:${filePath}:path:${match[1]}`
      nodes.push({
        id: pathId,
        name: match[1],
        kind: 'path',
        file: filePath,
        line: 1,
      })
    }

    if (nodes.length === 0) return null
    return { nodes, edges, file: filePath, parser: this.name }
  }
}
