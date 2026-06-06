/**
 * Svelte component extractor — parses Svelte component files.
 *
 * Extracts:
 * - Component node for the .svelte file itself
 * - Script block delegation to TreeSitterExtractor (when available)
 * - Template function calls ({fn(...)} expressions)
 * - Template component usages (PascalCase tags)
 * - Filters out Svelte rune calls ($state, $props, etc.)
 *
 * Every .svelte file produces a component node (Svelte components are always importable).
 */

import type { ExtractionNode, ExtractionEdge, UnresolvedRef, ExtractionError, ExtractionResult } from '../types.js'
import { generateNodeId } from '../helpers.js'

/** Svelte 5 rune names — compiler builtins, not real functions */
const SVELTE_RUNES = new Set([
  '$props', '$state', '$derived', '$effect', '$bindable',
  '$inspect', '$host', '$snippet',
])

export class SvelteExtractor {
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
      const componentNode = this.createComponentNode()

      const scriptBlocks = this.extractScriptBlocks()

      for (const block of scriptBlocks) {
        this.processScriptBlock(block, componentNode.id)
      }

      this.extractTemplateCalls(componentNode.id)
      this.extractTemplateComponents(componentNode.id)

      // Filter out Svelte rune calls
      this.unresolved_refs = this.unresolved_refs.filter(
        ref => !SVELTE_RUNES.has(ref.reference_name),
      )
    } catch (error) {
      this.errors.push({
        message: `Svelte extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  private createComponentNode(): ExtractionNode {
    const lines = this.source.split('\n')
    const fileName = this.file.split(/[/\\]/).pop() || this.file
    const componentName = fileName.replace(/\.svelte$/, '')
    const id = generateNodeId(this.file, 'component', componentName, 1)

    const node: ExtractionNode = {
      id,
      kind: 'component',
      name: componentName,
      qualified_name: `${this.file}::${componentName}`,
      file: this.file,
      language: 'svelte',
      line: 1,
      end_line: lines.length,
      start_column: 0,
      end_column: lines[lines.length - 1]?.length || 0,
      is_exported: true,
      updated_at: Date.now(),
    }

    this.nodes.push(node)
    return node
  }

  private extractScriptBlocks(): Array<{
    content: string
    startLine: number
    isModule: boolean
    isTypeScript: boolean
  }> {
    const blocks: Array<{
      content: string
      startLine: number
      isModule: boolean
      isTypeScript: boolean
    }> = []

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g
    let match: RegExpExecArray | null

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || ''
      const content = match.groups?.content || match[2] || ''

      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs)
      const isModule = /context\s*=\s*["']module["']/.test(attrs)

      const beforeScript = this.source.substring(0, match.index)
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1)
      const openingTagLines = (openingTag.match(/\n/g) || []).length
      const contentStartLine = scriptTagLine + openingTagLines + 1

      blocks.push({
        content,
        startLine: contentStartLine,
        isModule,
        isTypeScript,
      })
    }

    return blocks
  }

  /**
   * Process a script block by delegating to TreeSitterExtractor.
   *
   * TODO: Integrate with TreeSitterExtractor when the tree-sitter subsystem
   * is ported. Currently emits a warning and skips script parsing.
   */
  private processScriptBlock(
    block: { content: string; startLine: number; isModule: boolean; isTypeScript: boolean },
    _componentNodeId: string,
  ): void {
    this.errors.push({
      message: `Svelte script block parsing requires TreeSitterExtractor (not yet ported)`,
      severity: 'warning',
      code: 'tree_sitter_unavailable',
    })
  }

  /**
   * Extract function calls from Svelte template expressions.
   *
   * Scans the template portion for `{expression}` blocks and extracts
   * call patterns from them (e.g., `class={cn(...)}`).
   */
  private extractTemplateCalls(componentNodeId: string): void {
    const coveredRanges: Array<[number, number]> = []

    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g
    let tagMatch: RegExpExecArray | null
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length
      coveredRanges.push([startLine, endLine])
    }

    const lines = this.source.split('\n')
    const exprRegex = /\{([^}#/:@][^}]*)\}/g

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue

      const line = lines[lineIdx]!
      let exprMatch: RegExpExecArray | null
      while ((exprMatch = exprRegex.exec(line)) !== null) {
        const expr = exprMatch[1]!
        const callRegex = /\b([a-zA-Z_$][\w$.]*)\s*\(/g
        let callMatch: RegExpExecArray | null
        while ((callMatch = callRegex.exec(expr)) !== null) {
          const calleeName = callMatch[1]!
          if (SVELTE_RUNES.has(calleeName)) continue
          if (calleeName === 'if' || calleeName === 'else' || calleeName === 'each' || calleeName === 'await') continue

          this.unresolved_refs.push({
            from_node_id: componentNodeId,
            reference_name: calleeName,
            reference_kind: 'calls',
            line: lineIdx + 1,
            column: exprMatch.index + callMatch.index,
            file: this.file,
            language: 'svelte',
          })
        }
      }
    }
  }

  /**
   * Extract component usages from the Svelte template.
   *
   * PascalCase tags like `<Modal>`, `<Button />` represent component instantiations.
   */
  private extractTemplateComponents(componentNodeId: string): void {
    const coveredRanges: Array<[number, number]> = []
    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g
    let tagMatch: RegExpExecArray | null
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length
      coveredRanges.push([startLine, endLine])
    }

    const lines = this.source.split('\n')
    const componentTagRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue

      const line = lines[lineIdx]!
      let match: RegExpExecArray | null
      while ((match = componentTagRegex.exec(line)) !== null) {
        const componentName = match[1]!

        this.unresolved_refs.push({
          from_node_id: componentNodeId,
          reference_name: componentName,
          reference_kind: 'references',
          line: lineIdx + 1,
          column: match.index + 1,
          file: this.file,
          language: 'svelte',
        })
      }
    }
  }
}
