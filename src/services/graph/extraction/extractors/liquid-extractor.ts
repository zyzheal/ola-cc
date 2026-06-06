/**
 * Liquid template extractor — parses Liquid template files (Shopify, Jekyll, etc.).
 *
 * Extracts:
 * - Section references ({% section 'name' %})
 * - Snippet references ({% render 'name' %} and {% include 'name' %})
 * - Schema blocks ({% schema %}...{% endschema %})
 * - Assign statements ({% assign var = value %})
 */

import type { ExtractionNode, ExtractionEdge, UnresolvedRef, ExtractionError, ExtractionResult } from '../types.js'
import { generateNodeId } from '../helpers.js'

export class LiquidExtractor {
  private file: string
  private source: string
  private nodes: ExtractionNode[] = []
  private edges: ExtractionEdge[] = []
  private unresolved_refs: UnresolvedRef[] = []
  private errors: ExtractionError[] = []

  constructor(file: string, source: string) {
    this.file = file
    this.source = source
  }

  extract(): ExtractionResult {
    const startTime = Date.now()

    try {
      const fileNode = this.createFileNode()

      this.extractSnippetReferences(fileNode.id)
      this.extractSectionReferences(fileNode.id)
      this.extractSchema(fileNode.id)
      this.extractAssignments(fileNode.id)
    } catch (error) {
      this.errors.push({
        message: `Liquid extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

    const fileNode: ExtractionNode = {
      id,
      kind: 'file',
      name: this.file.split('/').pop() || this.file,
      qualified_name: this.file,
      file: this.file,
      language: 'liquid',
      line: 1,
      end_line: lines.length,
      start_column: 0,
      end_column: lines[lines.length - 1]?.length || 0,
      updated_at: Date.now(),
    }

    this.nodes.push(fileNode)
    return fileNode
  }

  /** Extract {% render 'snippet' %} and {% include 'snippet' %} references */
  private extractSnippetReferences(fileNodeId: string): void {
    const renderRegex = /\{%[-]?\s*(render|include)\s+['"]([^'"]+)['"]/g
    let match: RegExpExecArray | null

    while ((match = renderRegex.exec(this.source)) !== null) {
      const [fullMatch, tagType, snippetName] = match
      const line = this.getLineNumber(match.index)

      const importNodeId = generateNodeId(this.file, 'import', snippetName!, line)
      const importNode: ExtractionNode = {
        id: importNodeId,
        kind: 'import',
        name: snippetName!,
        qualified_name: `${this.file}::import:${snippetName}`,
        file: this.file,
        language: 'liquid',
        signature: fullMatch,
        line,
        end_line: line,
        start_column: match.index - this.getLineStart(line),
        end_column: match.index - this.getLineStart(line) + fullMatch.length,
        updated_at: Date.now(),
      }
      this.nodes.push(importNode)

      this.edges.push({
        source: fileNodeId,
        target: importNodeId,
        kind: 'contains',
      })

      const nodeId = generateNodeId(this.file, 'component', `${tagType}:${snippetName}`, line)

      const node: ExtractionNode = {
        id: nodeId,
        kind: 'component',
        name: snippetName!,
        qualified_name: `${this.file}::${tagType}:${snippetName}`,
        file: this.file,
        language: 'liquid',
        line,
        end_line: line,
        start_column: match.index - this.getLineStart(line),
        end_column: match.index - this.getLineStart(line) + fullMatch.length,
        updated_at: Date.now(),
      }

      this.nodes.push(node)

      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      })

      this.unresolved_refs.push({
        from_node_id: fileNodeId,
        reference_name: `snippets/${snippetName}.liquid`,
        reference_kind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      })
    }
  }

  /** Extract {% section 'name' %} references */
  private extractSectionReferences(fileNodeId: string): void {
    const sectionRegex = /\{%[-]?\s*section\s+['"]([^'"]+)['"]/g
    let match: RegExpExecArray | null

    while ((match = sectionRegex.exec(this.source)) !== null) {
      const [fullMatch, sectionName] = match
      const line = this.getLineNumber(match.index)

      const importNodeId = generateNodeId(this.file, 'import', sectionName!, line)
      const importNode: ExtractionNode = {
        id: importNodeId,
        kind: 'import',
        name: sectionName!,
        qualified_name: `${this.file}::import:${sectionName}`,
        file: this.file,
        language: 'liquid',
        signature: fullMatch,
        line,
        end_line: line,
        start_column: match.index - this.getLineStart(line),
        end_column: match.index - this.getLineStart(line) + fullMatch.length,
        updated_at: Date.now(),
      }
      this.nodes.push(importNode)

      this.edges.push({
        source: fileNodeId,
        target: importNodeId,
        kind: 'contains',
      })

      const nodeId = generateNodeId(this.file, 'component', `section:${sectionName}`, line)

      const node: ExtractionNode = {
        id: nodeId,
        kind: 'component',
        name: sectionName!,
        qualified_name: `${this.file}::section:${sectionName}`,
        file: this.file,
        language: 'liquid',
        line,
        end_line: line,
        start_column: match.index - this.getLineStart(line),
        end_column: match.index - this.getLineStart(line) + fullMatch.length,
        updated_at: Date.now(),
      }

      this.nodes.push(node)

      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      })

      this.unresolved_refs.push({
        from_node_id: fileNodeId,
        reference_name: `sections/${sectionName}.liquid`,
        reference_kind: 'references',
        line,
        column: match.index - this.getLineStart(line),
      })
    }
  }

  /** Extract {% schema %}...{% endschema %} blocks */
  private extractSchema(fileNodeId: string): void {
    const schemaRegex = /\{%[-]?\s*schema\s*[-]?%\}([\s\S]*?)\{%[-]?\s*endschema\s*[-]?%\}/g
    let match: RegExpExecArray | null

    while ((match = schemaRegex.exec(this.source)) !== null) {
      const [fullMatch, schemaContent] = match
      const startLine = this.getLineNumber(match.index)
      const endLine = this.getLineNumber(match.index + fullMatch.length)

      let schemaName = 'schema'
      try {
        const schemaJson = JSON.parse(schemaContent!)
        if (schemaJson.name) {
          schemaName = typeof schemaJson.name === 'string'
            ? schemaJson.name
            : schemaJson.name.en || Object.values(schemaJson.name)[0] as string || 'schema'
        }
      } catch {
        // Schema isn't valid JSON, use default name
      }

      const nodeId = generateNodeId(this.file, 'constant', `schema:${schemaName}`, startLine)

      const node: ExtractionNode = {
        id: nodeId,
        kind: 'constant',
        name: schemaName,
        qualified_name: `${this.file}::schema:${schemaName}`,
        file: this.file,
        language: 'liquid',
        line: startLine,
        end_line: endLine,
        start_column: match.index - this.getLineStart(startLine),
        end_column: 0,
        docstring: schemaContent?.trim().substring(0, 200),
        updated_at: Date.now(),
      }

      this.nodes.push(node)

      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      })
    }
  }

  /** Extract {% assign var = value %} statements */
  private extractAssignments(fileNodeId: string): void {
    const assignRegex = /\{%[-]?\s*assign\s+(\w+)\s*=/g
    let match: RegExpExecArray | null

    while ((match = assignRegex.exec(this.source)) !== null) {
      const [, variableName] = match
      const line = this.getLineNumber(match.index)

      const nodeId = generateNodeId(this.file, 'variable', variableName!, line)

      const node: ExtractionNode = {
        id: nodeId,
        kind: 'variable',
        name: variableName!,
        qualified_name: `${this.file}::${variableName}`,
        file: this.file,
        language: 'liquid',
        line,
        end_line: line,
        start_column: match.index - this.getLineStart(line),
        end_column: match.index - this.getLineStart(line) + match[0].length,
        updated_at: Date.now(),
      }

      this.nodes.push(node)

      this.edges.push({
        source: fileNodeId,
        target: nodeId,
        kind: 'contains',
      })
    }
  }

  private getLineNumber(index: number): number {
    const substring = this.source.substring(0, index)
    return (substring.match(/\n/g) || []).length + 1
  }

  private getLineStart(lineNumber: number): number {
    const lines = this.source.split('\n')
    let index = 0
    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
      index += lines[i]!.length + 1
    }
    return index
  }
}
