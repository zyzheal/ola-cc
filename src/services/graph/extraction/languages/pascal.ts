/**
 * Pascal/Delphi language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText, getChildByField } from '../helpers.js'

export const pascalExtractor: LanguageExtractor = {
  functionTypes: ['declProc'],
  classTypes: ['declClass'],
  methodTypes: ['declProc'],
  interfaceTypes: ['declIntf'],
  structTypes: [],
  enumTypes: ['declEnum'],
  typeAliasTypes: ['declType'],
  importTypes: ['declUses'],
  callTypes: ['exprCall'],
  variableTypes: ['declField', 'declConst'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'args',
  returnField: 'type',
  getSignature: (node: SyntaxNode, source: string) => {
    const args = getChildByField(node, 'args')
    const returnType = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'typeref'
    )
    if (!args && !returnType) return undefined
    let sig = ''
    if (args) sig = getNodeText(args, source)
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source)
    }
    return sig || undefined
  },
  getVisibility: (node: SyntaxNode) => {
    let current = node.parent
    while (current) {
      if (current.type === 'declSection') {
        for (let i = 0; i < current.childCount; i++) {
          const child = current.child(i)
          if (child?.type === 'kPublic' || child?.type === 'kPublished')
            return 'public'
          if (child?.type === 'kPrivate') return 'private'
          if (child?.type === 'kProtected') return 'protected'
        }
      }
      current = current.parent
    }
    return undefined
  },
  isExported: (_node: SyntaxNode, _source: string) => {
    return false
  },
  isStatic: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)?.type === 'kClass') return true
    }
    return false
  },
  isConst: (node: SyntaxNode) => {
    return node.type === 'declConst'
  },
}
