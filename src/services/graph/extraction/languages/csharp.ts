/**
 * C# language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText } from '../helpers.js'

export const csharpExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_member_declaration'],
  typeAliasTypes: [],
  importTypes: ['using_directive'],
  callTypes: ['invocation_expression'],
  variableTypes: ['local_declaration_statement'],
  fieldTypes: ['field_declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getVisibility: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'modifier') {
        const text = child.text
        if (text === 'public') return 'public'
        if (text === 'private') return 'private'
        if (text === 'protected') return 'protected'
        if (text === 'internal') return 'internal'
      }
    }
    return 'private' // C# defaults to private
  },
  isStatic: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'modifier' && child.text === 'static') {
        return true
      }
    }
    return false
  },
  isAsync: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'modifier' && child.text === 'async') {
        return true
      }
    }
    return false
  },
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim()
    const qualifiedName = node.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name')
    if (qualifiedName) {
      return { moduleName: getNodeText(qualifiedName, source), signature: importText }
    }
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier')
    if (identifier) {
      return { moduleName: getNodeText(identifier, source), signature: importText }
    }
    return null
  },
}
