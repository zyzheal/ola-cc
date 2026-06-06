/**
 * Lua language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText, getChildByField } from '../helpers.js'

/** First descendant of a given type (breadth-first), or null. */
function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  const queue: SyntaxNode[] = [...node.namedChildren]
  while (queue.length) {
    const n = queue.shift()!
    if (n.type === type) return n
    queue.push(...n.namedChildren)
  }
  return null
}

/**
 * If `callNode` is a `require(...)` call, return the module name; otherwise null.
 */
function requireModule(callNode: SyntaxNode, source: string): string | null {
  const name = getChildByField(callNode, 'name')
  if (!name || name.type !== 'identifier') return null
  if (getNodeText(name, source) !== 'require') return null

  const args = getChildByField(callNode, 'arguments')
  if (!args) return null

  const content = findDescendant(args, 'string_content')
  if (content) return getNodeText(content, source).trim() || null
  const str = findDescendant(args, 'string')
  if (str) {
    const mod = getNodeText(str, source)
      .trim()
      .replace(/^\[\[/, '')
      .replace(/\]\]$/, '')
      .replace(/^["']/, '')
      .replace(/["']$/, '')
    if (mod) return mod
  }

  const idx = findDescendant(args, 'dot_index_expression') ?? findDescendant(args, 'method_index_expression')
  if (idx) {
    const field = getChildByField(idx, 'field') ?? getChildByField(idx, 'method')
    if (field) return getNodeText(field, source).trim() || null
  }
  return null
}

export const luaExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [], // `require` is a function_call -- handled in visitNode
  callTypes: ['function_call'],
  variableTypes: ['variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node: SyntaxNode, source: string) => {
    const params = getChildByField(node, 'parameters')
    return params ? getNodeText(params, source) : undefined
  },

  getReceiverType: (node: SyntaxNode, source: string) => {
    const name = getChildByField(node, 'name')
    if (name && (name.type === 'dot_index_expression' || name.type === 'method_index_expression')) {
      const table = getChildByField(name, 'table')
      if (table) return getNodeText(table, source)
    }
    return undefined
  },

  visitNode: (node: SyntaxNode, ctx) => {
    const source = ctx.source

    const emit = (callNode: SyntaxNode): void => {
      const mod = requireModule(callNode, source)
      if (!mod) return
      const imp = ctx.createNode('import', mod, callNode, {
        signature: getNodeText(callNode, source).trim().slice(0, 100),
      })
      if (imp && ctx.nodeStack.length > 0) {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1]
        if (parentId) {
          ctx.addUnresolvedReference({
            from_node_id: parentId,
            reference_name: mod,
            reference_kind: 'imports',
            line: callNode.startPosition.row + 1,
            column: callNode.startPosition.column,
          })
        }
      }
    }

    if (node.type === 'function_call') {
      if (requireModule(node, source)) {
        emit(node)
        return true
      }
      return false
    }

    if (node.type === 'variable_declaration') {
      const assign = node.namedChildren.find((c) => c.type === 'assignment_statement')
      const exprList = assign?.namedChildren.find((c) => c.type === 'expression_list')
      if (exprList) {
        for (const val of exprList.namedChildren) {
          if (val.type === 'function_call') emit(val)
        }
      }
      return false
    }

    return false
  },
}
