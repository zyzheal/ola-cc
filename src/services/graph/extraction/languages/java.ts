/**
 * Java language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText, getChildByField } from '../helpers.js'

export const javaExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  callTypes: ['method_invocation'],
  variableTypes: ['local_variable_declaration'],
  fieldTypes: ['field_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getSignature: (node: SyntaxNode, source: string) => {
    const params = getChildByField(node, 'parameters')
    const returnType = getChildByField(node, 'type')
    if (!params) return undefined
    const paramsText = getNodeText(params, source)
    return returnType ? getNodeText(returnType, source) + ' ' + paramsText : paramsText
  },
  getVisibility: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'modifiers') {
        const text = child.text
        if (text.includes('public')) return 'public'
        if (text.includes('private')) return 'private'
        if (text.includes('protected')) return 'protected'
      }
    }
    return undefined
  },
  isStatic: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'modifiers' && child.text.includes('static')) {
        return true
      }
    }
    return false
  },
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim()
    const scopedId = node.namedChildren.find((c: SyntaxNode) => c.type === 'scoped_identifier')
    if (scopedId) {
      const moduleName = source.substring(scopedId.startIndex, scopedId.endIndex)
      return { moduleName, signature: importText }
    }
    return null
  },
  packageTypes: ['package_declaration'],
  extractPackage: (node: SyntaxNode, source: string) => {
    const id = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'scoped_identifier' || c.type === 'identifier'
    )
    return id ? source.substring(id.startIndex, id.endIndex).trim() : null
  },
}
