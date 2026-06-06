/**
 * C and C++ language extractor configurations.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getChildByField, getNodeText } from '../helpers.js'

function extractCppQualifiedMethodName(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator')
  if (!declarator) return undefined

  const queue: SyntaxNode[] = [declarator]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.type === 'qualified_identifier') {
      const text = getNodeText(current, source).trim()
      const parts = text.split('::').filter(Boolean)
      return parts[parts.length - 1]
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i)
      if (child) queue.push(child)
    }
  }

  return undefined
}

function extractCppReceiverType(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator')
  if (!declarator) return undefined

  const queue: SyntaxNode[] = [declarator]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.type === 'qualified_identifier') {
      const text = getNodeText(current, source).trim()
      const parts = text.split('::').filter(Boolean)
      if (parts.length > 1) {
        return parts.slice(0, -1).join('::')
      }
      return undefined
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i)
      if (child) queue.push(child)
    }
  }

  return undefined
}

export const cExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'], // typedef
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveTypeAliasKind: (node: SyntaxNode, _source: string) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (!child) continue
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum'
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct'
    }
    return undefined
  },
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim()
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string')
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText }
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal')
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content')
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText }
      }
    }
    return null
  },
}

export const cppExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition', 'alias_declaration'], // typedef and using
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveName: extractCppQualifiedMethodName,
  getReceiverType: extractCppReceiverType,
  getVisibility: (node: SyntaxNode) => {
    const parent = node.parent
    if (parent) {
      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i)
        if (child?.type === 'access_specifier') {
          const text = child.text
          if (text.includes('public')) return 'public'
          if (text.includes('private')) return 'private'
          if (text.includes('protected')) return 'protected'
        }
      }
    }
    return undefined
  },
  resolveTypeAliasKind: (node: SyntaxNode, _source: string) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (!child) continue
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum'
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct'
    }
    return undefined
  },
  isMisparsedFunction: (name: string) => {
    if (name.startsWith('namespace')) return true
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return']
    return cppKeywords.includes(name)
  },
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim()
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string')
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText }
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal')
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content')
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText }
      }
    }
    return null
  },
}
