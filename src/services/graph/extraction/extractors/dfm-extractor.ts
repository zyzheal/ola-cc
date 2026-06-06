/**
 * Delphi DFM/FMX form extractor.
 *
 * DFM/FMX files describe the visual component hierarchy and event handler
 * bindings. They use a simple text format (object/end blocks) that we parse
 * with regex — no tree-sitter grammar exists for this format.
 *
 * Extracted information:
 * - Components as kind 'component'
 * - Nesting as edge kind 'contains'
 * - Event handlers (OnClick = MethodName) as unresolved references
 */

import type { ExtractionNode, ExtractionEdge, UnresolvedRef, ExtractionError, ExtractionResult } from '../types.js'
import { generateNodeId } from '../helpers.js'

export class DfmExtractor {
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
      this.parseComponents(fileNode.id)
    } catch (error) {
      this.errors.push({
        message: `DFM extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
      language: 'pascal',
      line: 1,
      end_line: lines.length,
      start_column: 0,
      end_column: lines[lines.length - 1]?.length || 0,
      updated_at: Date.now(),
    }

    this.nodes.push(fileNode)
    return fileNode
  }

  /** Parse object/end blocks and extract components + event handlers */
  private parseComponents(fileNodeId: string): void {
    const lines = this.source.split('\n')
    const stack: string[] = [fileNodeId]

    const objectPattern = /^\s*(object|inherited|inline)\s+(\w+)\s*:\s*(\w+)/
    const eventPattern = /^\s*(On\w+)\s*=\s*(\w+)\s*$/
    const endPattern = /^\s*end\s*$/
    const multiLineStart = /=\s*\(\s*$/
    const multiLineItemStart = /=\s*<\s*$/
    let inMultiLine = false
    let multiLineEndChar = ')'

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lineNum = i + 1

      // Skip multi-line properties
      if (inMultiLine) {
        if (line.trimEnd().endsWith(multiLineEndChar)) inMultiLine = false
        continue
      }
      if (multiLineStart.test(line)) {
        inMultiLine = true
        multiLineEndChar = ')'
        continue
      }
      if (multiLineItemStart.test(line)) {
        inMultiLine = true
        multiLineEndChar = '>'
        continue
      }

      // Component declaration
      const objMatch = line.match(objectPattern)
      if (objMatch) {
        const [, , name, typeName] = objMatch
        const nodeId = generateNodeId(this.file, 'component', name!, lineNum)
        this.nodes.push({
          id: nodeId,
          kind: 'component',
          name: name!,
          qualified_name: `${this.file}#${name}`,
          file: this.file,
          language: 'pascal',
          line: lineNum,
          end_line: lineNum,
          start_column: 0,
          end_column: line.length,
          signature: typeName,
          updated_at: Date.now(),
        })
        this.edges.push({
          source: stack[stack.length - 1]!,
          target: nodeId,
          kind: 'contains',
        })
        stack.push(nodeId)
        continue
      }

      // Event handler
      const eventMatch = line.match(eventPattern)
      if (eventMatch) {
        const [, , methodName] = eventMatch
        this.unresolved_refs.push({
          from_node_id: stack[stack.length - 1]!,
          reference_name: methodName!,
          reference_kind: 'references',
          line: lineNum,
          column: 0,
        })
        continue
      }

      // Block end
      if (endPattern.test(line)) {
        if (stack.length > 1) stack.pop()
      }
    }
  }
}
