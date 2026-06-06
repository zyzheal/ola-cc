/**
 * PHP language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText } from '../helpers.js'

export const phpExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_declaration', 'trait_declaration'],
  methodTypes: ['method_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_case'],
  typeAliasTypes: [],
  importTypes: ['namespace_use_declaration'],
  callTypes: ['function_call_expression', 'member_call_expression', 'scoped_call_expression'],
  variableTypes: ['const_declaration'],
  fieldTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  classifyClassNode: (node: SyntaxNode) => {
    return node.type === 'trait_declaration' ? 'trait' : 'class'
  },
  getVisibility: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'visibility_modifier') {
        const text = child.text
        if (text === 'public') return 'public'
        if (text === 'private') return 'private'
        if (text === 'protected') return 'protected'
      }
    }
    return 'public' // PHP defaults to public
  },
  isStatic: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'static_modifier') return true
    }
    return false
  },
  visitNode: (node: SyntaxNode, ctx) => {
    if (node.type === 'const_declaration') {
      const constElements = node.namedChildren.filter((c: SyntaxNode) => c.type === 'const_element')
      for (const elem of constElements) {
        const nameNode = elem.namedChildren.find((c: SyntaxNode) => c.type === 'name')
        if (!nameNode) continue
        const name = getNodeText(nameNode, ctx.source)
        ctx.createNode('constant', name, elem, {})
      }
      return true
    }

    if (node.type === 'use_declaration') {
      const names = node.namedChildren.filter((c: SyntaxNode) => c.type === 'name' || c.type === 'qualified_name')
      const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] : undefined
      if (parentId) {
        for (const nameNode of names) {
          const traitName = getNodeText(nameNode, ctx.source)
          ctx.addUnresolvedReference({
            from_node_id: parentId,
            reference_name: traitName,
            reference_kind: 'implements',
            file: ctx.file,
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          })
        }
      }
      return true
    }

    return false
  },
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim()

    const namespacePrefix = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name')
    const useGroup = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_group')
    if (namespacePrefix && useGroup) {
      return null
    }

    const useClause = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_clause')
    if (useClause) {
      const qualifiedName = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name')
      if (qualifiedName) {
        return { moduleName: getNodeText(qualifiedName, source), signature: importText }
      }
      const name = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'name')
      if (name) {
        return { moduleName: getNodeText(name, source), signature: importText }
      }
    }
    return null
  },
}
