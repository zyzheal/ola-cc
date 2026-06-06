/**
 * Swift language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText, getChildByField } from '../helpers.js'

export const swiftExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // Methods are functions inside classes
  interfaceTypes: ['protocol_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['typealias_declaration'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration', 'constant_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter',
  returnField: 'return_type',
  getSignature: (node: SyntaxNode, source: string) => {
    const params = getChildByField(node, 'parameter')
    const returnType = getChildByField(node, 'return_type')
    if (!params) return undefined
    let sig = getNodeText(params, source)
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source)
    }
    return sig
  },
  getVisibility: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'modifiers') {
        const text = child.text
        if (text.includes('public')) return 'public'
        if (text.includes('private')) return 'private'
        if (text.includes('internal')) return 'internal'
        if (text.includes('fileprivate')) return 'private'
      }
    }
    return 'internal' // Swift defaults to internal
  },
  isStatic: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'modifiers') {
        if (child.text.includes('static') || child.text.includes('class')) {
          return true
        }
      }
    }
    return false
  },
  classifyClassNode: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'struct') return 'struct'
      if (child?.type === 'enum') return 'enum'
    }
    return 'class'
  },
  isAsync: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'modifiers' && child.text.includes('async')) {
        return true
      }
    }
    return false
  },
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim()
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier')
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText }
    }
    return null
  },
}
