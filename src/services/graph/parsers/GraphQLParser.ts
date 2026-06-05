/**
 * GraphQLParser — extracts types, queries, mutations from .graphql/.gql files.
 *
 * Nodes: types, queries, mutations, subscriptions, enums, interfaces, inputs
 * Edges: query returns type, type has field, field references type
 */

import type { FileParser, ParserResult, ParsedNode, ParsedEdge } from './types.js'

export class GraphQLParser implements FileParser {
  readonly name = 'graphql'
  readonly extensions = ['.graphql', '.gql']
  readonly filePatterns = []

  parse(filePath: string, content: string): ParserResult | null {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []
    const lines = content.split('\n')

    // Match type definitions
    const typeRegex = /^(type|interface|input|enum|union|scalar)\s+(\w+)/gm
    let match: RegExpExecArray | null

    while ((match = typeRegex.exec(content)) !== null) {
      const [, kind, name] = match
      const beforeMatch = content.slice(0, match.index)
      const lineNum = beforeMatch.split('\n').length

      const nodeId = `gql:${filePath}:${kind}:${name}`
      nodes.push({
        id: nodeId,
        name,
        kind: kind === 'type' ? 'type'
          : kind === 'interface' ? 'interface'
          : kind === 'input' ? 'input'
          : kind === 'enum' ? 'enum'
          : kind === 'union' ? 'union'
          : 'scalar',
        file: filePath,
        line: lineNum,
      })

      // Extract fields within the type
      const blockStart = content.indexOf('{', match.index)
      if (blockStart !== -1) {
        const blockEnd = this.findBlockEnd(content, blockStart + 1)
        const blockContent = content.slice(blockStart, blockEnd)

        // Field pattern: fieldName(args): Type
        const fieldRegex = /^\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*(\[?\w+[!\]]*!?)/gm
        let fieldMatch: RegExpExecArray | null

        while ((fieldMatch = fieldRegex.exec(blockContent)) !== null) {
          const [, fieldName, fieldType] = fieldMatch
          const fieldTypeName = fieldType.replace(/[\[\]!]/g, '')

          const fieldId = `gql:${filePath}:field:${name}.${fieldName}`
          nodes.push({
            id: fieldId,
            name: `${name}.${fieldName}`,
            kind: 'field',
            file: filePath,
            line: lineNum + blockContent.slice(0, fieldMatch.index).split('\n').length - 1,
            metadata: { type: fieldType, parent: name },
          })
          edges.push({
            from: nodeId,
            to: fieldId,
            type: 'has_field',
          })

          // Reference to field type (skip built-in scalars)
          if (!['String', 'Int', 'Float', 'Boolean', 'ID'].includes(fieldTypeName)) {
            edges.push({
              from: fieldId,
              to: `gql:${filePath}:type:${fieldTypeName}`,
              type: 'references',
            })
          }
        }
      }
    }

    // Match Query/Mutation type definitions and extract operations
    const queryTypeRegex = /^type\s+(Query|Mutation|Subscription)\s*\{/gm
    while ((match = queryTypeRegex.exec(content)) !== null) {
      const [, operationType] = match
      const blockStart = content.indexOf('{', match.index)
      if (blockStart === -1) continue

      const blockEnd = this.findBlockEnd(content, blockStart + 1)
      const blockContent = content.slice(blockStart, blockEnd)

      const opRegex = /^\s+(\w+)\s*(?:\([^)]*\))?\s*:\s*(\[?\w+[!\]]*!?)/gm
      let opMatch: RegExpExecArray | null

      while ((opMatch = opRegex.exec(blockContent)) !== null) {
        const [, opName, returnType] = opMatch
        const returnTypeName = returnType.replace(/[\[\]!]/g, '')
        const beforeOp = content.slice(0, match.index + (blockStart - match.index) + opMatch.index)
        const lineNum = beforeOp.split('\n').length

        const opId = `gql:${filePath}:${operationType.toLowerCase()}:${opName}`
        nodes.push({
          id: opId,
          name: opName,
          kind: operationType.toLowerCase() as 'query' | 'mutation' | 'subscription',
          file: filePath,
          line: lineNum,
        })

        // Return type reference
        if (!['String', 'Int', 'Float', 'Boolean', 'ID'].includes(returnTypeName)) {
          edges.push({
            from: opId,
            to: `gql:${filePath}:type:${returnTypeName}`,
            type: 'returns',
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
