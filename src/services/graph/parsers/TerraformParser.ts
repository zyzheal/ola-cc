/**
 * TerraformParser — extracts resources, variables, outputs, and modules.
 *
 * Nodes: resources, variables, outputs, modules, data sources
 * Edges: resource references variable, module contains resources
 */

import type { FileParser, ParserResult, ParsedNode, ParsedEdge } from './types.js'

export class TerraformParser implements FileParser {
  readonly name = 'terraform'
  readonly extensions = ['.tf']
  readonly filePatterns = []

  parse(filePath: string, content: string): ParserResult | null {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []
    const lines = content.split('\n')

    // Match block declarations: resource, variable, output, module, data, provider
    const blockRegex = /^(resource|variable|output|module|data|provider)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm
    let match: RegExpExecArray | null

    while ((match = blockRegex.exec(content)) !== null) {
      const [, blockType, typeOrName, nameOrNull] = match
      const name = nameOrNull ?? typeOrName
      const type = nameOrNull ? typeOrName : blockType

      // Calculate line number
      const beforeMatch = content.slice(0, match.index)
      const lineNum = beforeMatch.split('\n').length

      const nodeId = `tf:${filePath}:${blockType}:${type}:${name}`
      const kind = blockType === 'resource' ? 'resource'
        : blockType === 'variable' ? 'variable'
        : blockType === 'output' ? 'output'
        : blockType === 'module' ? 'module'
        : blockType === 'data' ? 'data_source'
        : 'provider'

      nodes.push({
        id: nodeId,
        name: nameOrNull ? `${type}.${name}` : typeOrName,
        kind,
        file: filePath,
        line: lineNum,
        metadata: { blockType, type, name },
      })

      // For resources, look for references to variables in the same block
      if (blockType === 'resource' || blockType === 'data') {
        const blockEnd = this.findBlockEnd(content, match.index + match[0].length)
        const blockContent = content.slice(match.index, blockEnd)

        // Find var.xxx references
        const varRefs = blockContent.matchAll(/var\.(\w+)/g)
        for (const varRef of varRefs) {
          edges.push({
            from: nodeId,
            to: `tf:${filePath}:variable:${varRef[1]}:${varRef[1]}`,
            type: 'references',
          })
        }

        // Find module.xxx references
        const modRefs = blockContent.matchAll(/module\.(\w+)/g)
        for (const modRef of modRefs) {
          edges.push({
            from: nodeId,
            to: `tf:${filePath}:module:${modRef[1]}:${modRef[1]}`,
            type: 'references',
          })
        }
      }

      // Module source reference
      if (blockType === 'module') {
        const blockEnd = this.findBlockEnd(content, match.index + match[0].length)
        const blockContent = content.slice(match.index, blockEnd)
        const sourceMatch = blockContent.match(/source\s*=\s*"([^"]+)"/)
        if (sourceMatch) {
          const sourceId = `tf:${filePath}:module_source:${sourceMatch[1]}`
          nodes.push({
            id: sourceId,
            name: sourceMatch[1],
            kind: 'module_source',
            file: filePath,
            line: lineNum,
          })
          edges.push({
            from: nodeId,
            to: sourceId,
            type: 'uses',
          })
        }
      }
    }

    if (nodes.length === 0) return null
    return { nodes, edges, file: filePath, parser: this.name }
  }

  private findBlockEnd(content: string, startIndex: number): number {
    let depth = 1
    let i = startIndex
    while (i < content.length && depth > 0) {
      if (content[i] === '{') depth++
      else if (content[i] === '}') depth--
      i++
    }
    return i
  }
}
