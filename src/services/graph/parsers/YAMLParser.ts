/**
 * YAMLParser — generic YAML parser for docker-compose, k8s manifests, etc.
 *
 * Extracts top-level keys as nodes, nested references as edges.
 * Handles docker-compose services, k8s resources, and generic YAML.
 */

import type { FileParser, ParserResult, ParsedNode, ParsedEdge } from './types.js'

export class YAMLParser implements FileParser {
  readonly name = 'yaml'
  readonly extensions = ['.yml', '.yaml']
  readonly filePatterns = []

  parse(filePath: string, content: string): ParserResult | null {
    const fileName = filePath.split('/').pop() ?? ''

    // Docker-compose detection
    if (fileName.startsWith('docker-compose') || fileName === 'compose.yml' || fileName === 'compose.yaml') {
      return this.parseDockerCompose(filePath, content)
    }

    // K8s manifest detection
    if (content.includes('apiVersion:') && content.includes('kind:')) {
      return this.parseK8sManifest(filePath, content)
    }

    // Generic YAML — extract top-level structure
    return this.parseGenericYaml(filePath, content)
  }

  private parseDockerCompose(filePath: string, content: string): ParserResult {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []
    const lines = content.split('\n')

    let inServices = false
    let currentService: string | null = null
    let currentServiceId: string | null = null
    let currentIndent = 0

    // Also track networks and volumes
    let inNetworks = false
    let inVolumes = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      if (!trimmed || trimmed.startsWith('#')) continue

      const indent = line.search(/\S/)

      // Top-level sections
      if (indent === 0) {
        inServices = trimmed === 'services:' || trimmed === 'version:'
        inNetworks = trimmed === 'networks:'
        inVolumes = trimmed === 'volumes:'
        currentService = null
        continue
      }

      // Service definitions (indent 2)
      if (inServices && indent === 2 && trimmed.endsWith(':') && !trimmed.includes(': ')) {
        currentService = trimmed.slice(0, -1)
        currentServiceId = `compose:${filePath}:service:${currentService}`
        currentIndent = indent

        nodes.push({
          id: currentServiceId,
          name: currentService,
          kind: 'service',
          file: filePath,
          line: i + 1,
        })
        continue
      }

      if (!currentService || !currentServiceId) continue

      // Image
      if (indent > currentIndent) {
        const imageMatch = trimmed.match(/^image:\s*(.+)/)
        if (imageMatch) {
          const image = imageMatch[1].trim().replace(/^['"]|['"]$/g, '')
          const imageId = `compose:${filePath}:image:${image}`
          nodes.push({
            id: imageId,
            name: image,
            kind: 'image',
            file: filePath,
            line: i + 1,
          })
          edges.push({
            from: currentServiceId,
            to: imageId,
            type: 'uses',
          })
        }

        // Ports: '8080:80' or '- 8080:80'
        const portMatch = trimmed.match(/^-?\s*(\d+):\d+/)
        if (portMatch) {
          const portId = `compose:${filePath}:port:${portMatch[1]}`
          nodes.push({
            id: portId,
            name: portMatch[1],
            kind: 'port',
            file: filePath,
            line: i + 1,
          })
          edges.push({
            from: currentServiceId,
            to: portId,
            type: 'exposes',
          })
        }

        // Depends_on
        const dependsMatch = trimmed.match(/depends_on:\s*(.+)/)
        if (dependsMatch) {
          const deps = dependsMatch[1].replace(/[\[\]]/g, '').split(/\s*,\s*/)
          for (const dep of deps) {
            const depName = dep.trim().replace(/^['"]|['"]$/g, '')
            if (depName) {
              edges.push({
                from: currentServiceId,
                to: `compose:${filePath}:service:${depName}`,
                type: 'depends',
              })
            }
          }
        }

        // Inline depends_on list items
        const depItemMatch = trimmed.match(/^-\s+(\S+)/)
        if (depItemMatch && line.includes('depends_on') === false) {
          // Could be a list item under depends_on
        }
      }

      // depends_on as list (indent 6, items at indent 8)
      if (trimmed.startsWith('- ') && indent >= 6) {
        const depName = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, '')
        // Check if we're in a depends_on context (look back)
        for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
          if (lines[j].includes('depends_on')) {
            edges.push({
              from: currentServiceId,
              to: `compose:${filePath}:service:${depName}`,
              type: 'depends',
            })
            break
          }
        }
      }
    }

    if (nodes.length === 0) return null
    return { nodes, edges, file: filePath, parser: this.name }
  }

  private parseK8sManifest(filePath: string, content: string): ParserResult {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []
    const lines = content.split('\n')

    let kind = 'Resource'
    let name = 'unnamed'
    let namespace = 'default'
    let apiVersion = ''

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      const kindMatch = trimmed.match(/^kind:\s*(.+)/)
      const nameMatch = trimmed.match(/^name:\s*(.+)/)
      const nsMatch = trimmed.match(/^namespace:\s*(.+)/)
      const apiMatch = trimmed.match(/^apiVersion:\s*(.+)/)

      if (kindMatch) kind = kindMatch[1].trim().replace(/^['"]|['"]$/g, '')
      if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '')
      if (nsMatch) namespace = nsMatch[1].trim().replace(/^['"]|['"]$/g, '')
      if (apiMatch) apiVersion = apiMatch[1].trim().replace(/^['"]|['"]$/g, '')
    }

    const nodeId = `k8s:${filePath}:${kind}:${name}`
    nodes.push({
      id: nodeId,
      name,
      kind: kind.toLowerCase(),
      file: filePath,
      line: 1,
      metadata: { apiVersion, namespace },
    })

    // Extract container references
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      const imageMatch = trimmed.match(/^image:\s*(.+)/)
      if (imageMatch) {
        const image = imageMatch[1].trim().replace(/^['"]|['"]$/g, '')
        const imageId = `k8s:${filePath}:image:${image}`
        nodes.push({
          id: imageId,
          name: image,
          kind: 'image',
          file: filePath,
          line: i + 1,
        })
        edges.push({
          from: nodeId,
          to: imageId,
          type: 'uses',
        })
      }

      // Service port references
      const portMatch = trimmed.match(/^containerPort:\s*(\d+)/)
      if (portMatch) {
        const portId = `k8s:${filePath}:port:${portMatch[1]}`
        nodes.push({
          id: portId,
          name: portMatch[1],
          kind: 'port',
          file: filePath,
          line: i + 1,
        })
        edges.push({
          from: nodeId,
          to: portId,
          type: 'exposes',
        })
      }
    }

    return { nodes, edges, file: filePath, parser: this.name }
  }

  private parseGenericYaml(filePath: string, content: string): ParserResult {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []
    const lines = content.split('\n')

    // Extract top-level keys as nodes
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      if (!trimmed || trimmed.startsWith('#')) continue

      const indent = line.search(/\S/)
      if (indent === 0 && trimmed.includes(':')) {
        const key = trimmed.split(':')[0].trim()
        if (key && !key.startsWith('-')) {
          const nodeId = `yaml:${filePath}:key:${key}`
          nodes.push({
            id: nodeId,
            name: key,
            kind: 'section',
            file: filePath,
            line: i + 1,
          })
        }
      }
    }

    if (nodes.length === 0) return null
    return { nodes, edges, file: filePath, parser: this.name }
  }
}
