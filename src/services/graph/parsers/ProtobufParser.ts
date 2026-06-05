/**
 * ProtobufParser — extracts messages, services, enums from .proto files.
 *
 * Nodes: messages, services, enums, RPCs, fields
 * Edges: service has RPC, RPC returns message, message has field
 */

import type { FileParser, ParserResult, ParsedNode, ParsedEdge } from './types.js'

export class ProtobufParser implements FileParser {
  readonly name = 'protobuf'
  readonly extensions = ['.proto']
  readonly filePatterns = []

  parse(filePath: string, content: string): ParserResult | null {
    const nodes: ParsedNode[] = []
    const edges: ParsedEdge[] = []
    const lines = content.split('\n')

    // Extract package name
    let packageName = ''
    const pkgMatch = content.match(/^package\s+(\S+);/m)
    if (pkgMatch) packageName = pkgMatch[1]

    // Match message, service, enum declarations
    const declRegex = /^(message|service|enum)\s+(\w+)\s*\{/gm
    let match: RegExpExecArray | null

    while ((match = declRegex.exec(content)) !== null) {
      const [, kind, name] = match
      const beforeMatch = content.slice(0, match.index)
      const lineNum = beforeMatch.split('\n').length

      const nodeId = `proto:${filePath}:${kind}:${name}`
      nodes.push({
        id: nodeId,
        name: packageName ? `${packageName}.${name}` : name,
        kind,
        file: filePath,
        line: lineNum,
        metadata: { package: packageName },
      })

      // Extract block content
      const blockStart = content.indexOf('{', match.index)
      if (blockStart === -1) continue
      const blockEnd = this.findBlockEnd(content, blockStart + 1)
      const blockContent = content.slice(blockStart, blockEnd)

      if (kind === 'message') {
        // Fields: type name = number;
        const fieldRegex = /^\s+(repeated\s+)?(\w+)\s+(\w+)\s*=\s*(\d+)/gm
        let fieldMatch: RegExpExecArray | null

        while ((fieldMatch = fieldRegex.exec(blockContent)) !== null) {
          const [, repeated, fieldType, fieldName, fieldNum] = fieldMatch
          const fieldId = `proto:${filePath}:field:${name}.${fieldName}`
          nodes.push({
            id: fieldId,
            name: `${name}.${fieldName}`,
            kind: 'field',
            file: filePath,
            line: lineNum + blockContent.slice(0, fieldMatch.index).split('\n').length - 1,
            metadata: { type: fieldType, number: parseInt(fieldNum), repeated: !!repeated },
          })
          edges.push({
            from: nodeId,
            to: fieldId,
            type: 'has_field',
          })

          // Reference to message type (skip built-in types)
          const builtins = ['string', 'int32', 'int64', 'uint32', 'uint64', 'bool',
            'float', 'double', 'bytes', 'sint32', 'sint64', 'fixed32', 'fixed64']
          if (!builtins.includes(fieldType)) {
            edges.push({
              from: fieldId,
              to: `proto:${filePath}:message:${fieldType}`,
              type: 'references',
            })
          }
        }
      }

      if (kind === 'service') {
        // RPCs: rpc MethodName (Request) returns (Response);
        const rpcRegex = /^\s+rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(\w+)\s*\)/gm
        let rpcMatch: RegExpExecArray | null

        while ((rpcMatch = rpcRegex.exec(blockContent)) !== null) {
          const [, rpcName, requestType, responseType] = rpcMatch
          const rpcId = `proto:${filePath}:rpc:${rpcName}`
          nodes.push({
            id: rpcId,
            name: rpcName,
            kind: 'rpc',
            file: filePath,
            line: lineNum + blockContent.slice(0, rpcMatch.index).split('\n').length - 1,
          })
          edges.push({
            from: nodeId,
            to: rpcId,
            type: 'has_rpc',
          })
          edges.push({
            from: rpcId,
            to: `proto:${filePath}:message:${requestType}`,
            type: 'accepts',
          })
          edges.push({
            from: rpcId,
            to: `proto:${filePath}:message:${responseType}`,
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
