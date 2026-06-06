/**
 * MyBatis XML mapper extractor — parses MyBatis mapper XML files.
 *
 * MyBatis splits a DAO interface across two files: a Java interface (parsed by
 * tree-sitter) declares the method, and an XML mapper file holds the SQL keyed
 * by `<namespace>` (the fully-qualified Java type name) and `id` (the method name).
 *
 * Extracted information:
 * - One method-shaped node per `<select|insert|update|delete>` and per `<sql>` fragment
 * - Qualified as `<namespace>::<id>` for framework synthesizer matching
 * - `<include refid="...">` yields unresolved references to SQL fragments
 *
 * Non-mapper XML (pom.xml, Spring beans, etc.) returns just a file node.
 */

import type { ExtractionNode, ExtractionEdge, UnresolvedRef, ExtractionError, ExtractionResult } from '../types.js'
import { generateNodeId } from '../helpers.js'

export class MyBatisExtractor {
  private file: string
  private source: string
  private nodes: ExtractionNode[] = []
  private edges: ExtractionEdge[] = []
  private unresolved_refs: UnresolvedRef[] = []
  private errors: ExtractionError[] = []
  private lineStarts: number[] = []

  constructor(file: string, source: string) {
    this.file = file
    this.source = source
    this.computeLineStarts()
  }

  extract(): ExtractionResult {
    const startTime = Date.now()

    const fileNode = this.createFileNode()

    try {
      const mapperMatch = this.findMapperRoot()
      if (mapperMatch) {
        this.extractMapper(fileNode.id, mapperMatch.namespace, mapperMatch.bodyStart, mapperMatch.bodyEnd)
      }
    } catch (error) {
      this.errors.push({
        message: `MyBatis extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      })
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolved_references: this.unresolved_refs,
      errors: this.errors,
      duration_ms: Date.now() - startTime,
    }
  }

  private createFileNode(): ExtractionNode {
    const lines = this.source.split('\n')
    const id = generateNodeId(this.file, 'file', this.file, 1)
    const node: ExtractionNode = {
      id,
      kind: 'file',
      name: this.file.split('/').pop() || this.file,
      qualified_name: this.file,
      file: this.file,
      language: 'xml',
      line: 1,
      end_line: lines.length || 1,
      start_column: 0,
      end_column: lines[lines.length - 1]?.length ?? 0,
      updated_at: Date.now(),
    }
    this.nodes.push(node)
    return node
  }

  /**
   * Find the `<mapper namespace="X">` opening tag.
   */
  private findMapperRoot(): { namespace: string; bodyStart: number; bodyEnd: number } | null {
    const open = /<mapper\b([^>]*)>/.exec(this.source)
    if (!open) return null
    const attrs = open[1] ?? ''
    const nsMatch = /\bnamespace\s*=\s*"([^"]+)"/.exec(attrs)
    if (!nsMatch) return null
    const bodyStart = open.index + open[0].length
    const closeIdx = this.source.indexOf('</mapper>', bodyStart)
    const bodyEnd = closeIdx >= 0 ? closeIdx : this.source.length
    return { namespace: nsMatch[1]!, bodyStart, bodyEnd }
  }

  private extractMapper(fileNodeId: string, namespace: string, bodyStart: number, bodyEnd: number): void {
    const body = this.source.slice(bodyStart, bodyEnd)
    const stmtRegex = /<(select|insert|update|delete|sql)\b([^>]*)>([\s\S]*?)<\/\1>/g
    let m: RegExpExecArray | null
    while ((m = stmtRegex.exec(body)) !== null) {
      const elemType = m[1]!
      const attrs = m[2] ?? ''
      const elemBody = m[3] ?? ''
      const idMatch = /\bid\s*=\s*"([^"]+)"/.exec(attrs)
      if (!idMatch) continue
      const id = idMatch[1]!
      const absoluteIndex = bodyStart + m.index
      const startLine = this.getLineNumber(absoluteIndex)
      const endLine = this.getLineNumber(absoluteIndex + m[0].length)
      const qualified = `${namespace}::${id}`
      const isSqlFragment = elemType === 'sql'
      const nodeId = generateNodeId(this.file, 'method', qualified, startLine)
      const node: ExtractionNode = {
        id: nodeId,
        kind: 'method',
        name: id,
        qualified_name: qualified,
        file: this.file,
        language: 'xml',
        signature: this.buildSignature(elemType, attrs, isSqlFragment),
        line: startLine,
        end_line: endLine,
        start_column: 0,
        end_column: 0,
        docstring: this.previewSql(elemBody),
        updated_at: Date.now(),
      }
      this.nodes.push(node)
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' })

      // <include refid="X"/> → reference to the SQL fragment
      const includeRegex = /<include\b[^>]*\brefid\s*=\s*"([^"]+)"/g
      let inc: RegExpExecArray | null
      while ((inc = includeRegex.exec(elemBody)) !== null) {
        const refid = inc[1]!
        const refQualified = refid.includes('.') ? refid.replace(/\./g, '::') : `${namespace}::${refid}`
        const includeOffset = absoluteIndex + (m[0].length - m[3]!.length - `</${elemType}>`.length) + inc.index
        const line = this.getLineNumber(includeOffset)
        this.unresolved_refs.push({
          from_node_id: nodeId,
          reference_name: refQualified,
          reference_kind: 'references',
          line,
          column: 0,
        })
      }
    }
  }

  private buildSignature(elemType: string, attrs: string, isSqlFragment: boolean): string {
    if (isSqlFragment) return '<sql>'
    const verb = elemType.toUpperCase()
    const result = /\bresultType\s*=\s*"([^"]+)"/.exec(attrs)?.[1]
    const param = /\bparameterType\s*=\s*"([^"]+)"/.exec(attrs)?.[1]
    const parts = [verb]
    if (param) parts.push(`param=${param}`)
    if (result) parts.push(`result=${result}`)
    return parts.join(' ')
  }

  private previewSql(body: string): string {
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  }

  private computeLineStarts(): void {
    this.lineStarts = [0]
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === 10) this.lineStarts.push(i + 1)
    }
  }

  private getLineNumber(offset: number): number {
    let lo = 0
    let hi = this.lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (this.lineStarts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}
