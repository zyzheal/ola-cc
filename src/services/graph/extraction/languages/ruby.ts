/**
 * Ruby language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText, getChildByField } from '../helpers.js'

export const rubyExtractor: LanguageExtractor = {
  functionTypes: ['method'],
  classTypes: ['class'],
  methodTypes: ['method', 'singleton_method'],
  interfaceTypes: [], // Ruby uses modules (handled via visitNode hook)
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['call'], // require/require_relative
  callTypes: ['call', 'method_call'],
  variableTypes: ['assignment'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  visitNode: (node: SyntaxNode, ctx) => {
    if (node.type !== 'module') return false

    const nameNode = node.childForFieldName('name')
    if (!nameNode) return false
    const name = nameNode.text

    const moduleNode = ctx.createNode('module', name, node)
    if (!moduleNode) return false

    ctx.pushScope(moduleNode.id)
    const body = node.childForFieldName('body')
    if (body) {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i)
        if (child) ctx.visitNode(child)
      }
    }
    ctx.popScope()
    return true
  },
  extractBareCall: (node: SyntaxNode, _source: string) => {
    if (node.type !== 'identifier') return undefined

    const parent = node.parent
    if (!parent) return undefined

    const BLOCK_PARENTS = new Set([
      'body_statement', 'then', 'else', 'do', 'begin',
      'rescue', 'ensure', 'when',
    ])
    if (!BLOCK_PARENTS.has(parent.type)) return undefined

    const name = node.text

    const SKIP = new Set([
      'true', 'false', 'nil', 'self', 'super',
      '__FILE__', '__LINE__', '__dir__',
    ])
    if (SKIP.has(name)) return undefined

    if (name.length > 0 && name.charCodeAt(0) >= 65 && name.charCodeAt(0) <= 90) return undefined

    return name
  },
  getVisibility: (node: SyntaxNode) => {
    let sibling = node.previousNamedSibling
    while (sibling) {
      if (sibling.type === 'call') {
        const methodName = getChildByField(sibling, 'method')
        if (methodName) {
          const text = methodName.text
          if (text === 'private') return 'private'
          if (text === 'protected') return 'protected'
          if (text === 'public') return 'public'
        }
      }
      sibling = sibling.previousNamedSibling
    }
    return 'public'
  },
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim()

    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier')
    if (!identifier) return null
    const methodName = getNodeText(identifier, source)
    if (methodName !== 'require' && methodName !== 'require_relative') {
      return null
    }

    const argList = node.namedChildren.find((c: SyntaxNode) => c.type === 'argument_list')
    if (argList) {
      const stringNode = argList.namedChildren.find((c: SyntaxNode) => c.type === 'string')
      if (stringNode) {
        const stringContent = stringNode.namedChildren.find((c: SyntaxNode) => c.type === 'string_content')
        if (stringContent) {
          return { moduleName: getNodeText(stringContent, source), signature: importText }
        }
      }
    }
    return null
  },
}
