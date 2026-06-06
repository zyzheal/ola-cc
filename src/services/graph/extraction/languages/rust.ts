/**
 * Rust language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText, getChildByField } from '../helpers.js'

export const rustExtractor: LanguageExtractor = {
  functionTypes: ['function_item'],
  classTypes: [], // Rust has impl blocks
  methodTypes: ['function_item'], // Methods are functions in impl blocks
  interfaceTypes: ['trait_item'],
  structTypes: ['struct_item'],
  enumTypes: ['enum_item'],
  enumMemberTypes: ['enum_variant'],
  typeAliasTypes: ['type_item'],
  importTypes: ['use_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['let_declaration', 'const_item', 'static_item'],
  interfaceKind: 'trait',
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node: SyntaxNode, source: string) => {
    const params = getChildByField(node, 'parameters')
    const returnType = getChildByField(node, 'return_type')
    if (!params) return undefined
    let sig = getNodeText(params, source)
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source)
    }
    return sig
  },
  isAsync: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'async') return true
    }
    return false
  },
  getVisibility: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'visibility_modifier') {
        return child.text.includes('pub') ? 'public' : 'private'
      }
    }
    return 'private' // Rust defaults to private
  },
  getReceiverType: (node: SyntaxNode, source: string) => {
    let parent = node.parent
    while (parent) {
      if (parent.type === 'impl_item') {
        const children = parent.namedChildren
        const typeIdents = children.filter(
          (c: SyntaxNode) => c.type === 'type_identifier'
        )
        if (typeIdents.length > 0) {
          const typeNode = typeIdents[typeIdents.length - 1]!
          return source.substring(typeNode.startIndex, typeNode.endIndex)
        }
        const genericType = children.find(
          (c: SyntaxNode) => c.type === 'generic_type'
        )
        if (genericType) {
          const innerType = genericType.namedChildren.find(
            (c: SyntaxNode) => c.type === 'type_identifier'
          )
          if (innerType) {
            return source.substring(innerType.startIndex, innerType.endIndex)
          }
        }
        return undefined
      }
      parent = parent.parent
    }
    return undefined
  },
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim()
    const getRootModule = (scopedNode: SyntaxNode): string => {
      const firstChild = scopedNode.namedChild(0)
      if (!firstChild) return source.substring(scopedNode.startIndex, scopedNode.endIndex)
      if (firstChild.type === 'identifier' ||
          firstChild.type === 'crate' ||
          firstChild.type === 'super' ||
          firstChild.type === 'self') {
        return source.substring(firstChild.startIndex, firstChild.endIndex)
      } else if (firstChild.type === 'scoped_identifier') {
        return getRootModule(firstChild)
      }
      return source.substring(firstChild.startIndex, firstChild.endIndex)
    }

    const useArg = node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'scoped_use_list' ||
      c.type === 'scoped_identifier' ||
      c.type === 'use_list' ||
      c.type === 'identifier'
    )

    if (useArg) {
      return { moduleName: getRootModule(useArg), signature: importText }
    }
    return null
  },
}
