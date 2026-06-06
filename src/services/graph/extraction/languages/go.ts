/**
 * Go language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText, getChildByField } from '../helpers.js'

export const goExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: [], // Go doesn't have classes
  methodTypes: ['method_declaration'],
  interfaceTypes: [],  // Handled via type_spec -> resolveTypeAliasKind
  structTypes: [],     // Handled via type_spec -> resolveTypeAliasKind
  enumTypes: [],
  typeAliasTypes: ['type_spec'], // Go type declarations
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['var_declaration', 'short_var_declaration', 'const_declaration'],
  methodsAreTopLevel: true,
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'result',
  getSignature: (node: SyntaxNode, source: string) => {
    const params = getChildByField(node, 'parameters')
    const result = getChildByField(node, 'result')
    if (!params) return undefined
    let sig = getNodeText(params, source)
    if (result) {
      sig += ' ' + getNodeText(result, source)
    }
    return sig
  },
  resolveTypeAliasKind: (node: SyntaxNode, _source: string) => {
    const typeChild = getChildByField(node, 'type')
    if (!typeChild) return undefined
    if (typeChild.type === 'struct_type') return 'struct'
    if (typeChild.type === 'interface_type') return 'interface'
    return undefined
  },
  isExported: (node: SyntaxNode, source: string) => {
    const nameNode = getChildByField(node, 'name')
    if (nameNode) {
      const text = getNodeText(nameNode, source)
      const first = text.charCodeAt(0)
      return first >= 65 && first <= 90 // A-Z
    }
    return false
  },
  getReceiverType: (node: SyntaxNode, source: string) => {
    const receiver = getChildByField(node, 'receiver')
    if (!receiver) return undefined
    const text = getNodeText(receiver, source)
    const match = text.match(/\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)/)
    return match?.[1]
  },
}
