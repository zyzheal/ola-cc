/**
 * Dart language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText } from '../helpers.js'

export const dartExtractor: LanguageExtractor = {
  functionTypes: ['function_signature'],
  classTypes: ['class_definition'],
  methodTypes: ['method_signature'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_or_export'],
  callTypes: [],  // Dart calls use identifier+selector, handled via extractBareCall
  variableTypes: [],
  extraClassNodeTypes: ['mixin_declaration', 'extension_declaration'],
  resolveBody: (node: SyntaxNode, bodyField: string) => {
    if (node.type === 'function_signature' || node.type === 'method_signature') {
      const next = node.nextNamedSibling
      if (next?.type === 'function_body') return next
      return null
    }
    const standard = node.childForFieldName(bodyField)
    if (standard) return standard
    return node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'class_body' || c.type === 'extension_body'
    ) || null
  },
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'formal_parameter_list',
  returnField: 'type',
  getSignature: (node: SyntaxNode, source: string) => {
    let sig = node
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find((c: SyntaxNode) =>
        c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
      )
      if (inner) sig = inner
    }
    const params = sig.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameter_list')
    const retType = sig.namedChildren.find((c: SyntaxNode) =>
      c.type === 'type_identifier' || c.type === 'void_type'
    )
    if (!params && !retType) return undefined
    let result = ''
    if (retType) result += getNodeText(retType, source) + ' '
    if (params) result += getNodeText(params, source)
    return result.trim() || undefined
  },
  getVisibility: (node: SyntaxNode) => {
    let nameNode: SyntaxNode | null = null
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find((c: SyntaxNode) =>
        c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
      )
      if (inner) nameNode = inner.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') || null
    } else {
      nameNode = node.childForFieldName('name')
    }
    if (nameNode && nameNode.text.startsWith('_')) return 'private'
    return 'public'
  },
  isAsync: (node: SyntaxNode) => {
    const nextSibling = node.nextNamedSibling
    if (nextSibling?.type === 'function_body') {
      for (let i = 0; i < nextSibling.childCount; i++) {
        const child = nextSibling.child(i)
        if (child?.type === 'async') return true
      }
    }
    return false
  },
  isStatic: (node: SyntaxNode) => {
    if (node.type === 'method_signature') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child?.type === 'static') return true
      }
    }
    return false
  },
  extractImport: (node: SyntaxNode, source: string) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim()
    let moduleName = ''

    const libraryImport = node.namedChildren.find((c: SyntaxNode) => c.type === 'library_import')
    if (libraryImport) {
      const importSpec = libraryImport.namedChildren.find((c: SyntaxNode) => c.type === 'import_specification')
      if (importSpec) {
        const configurableUri = importSpec.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri')
        if (configurableUri) {
          const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri')
          if (uri) {
            const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal')
            if (stringLiteral) {
              moduleName = getNodeText(stringLiteral, source).replace(/['"]/g, '')
            }
          }
        }
      }
    }

    if (!moduleName) {
      const libraryExport = node.namedChildren.find((c: SyntaxNode) => c.type === 'library_export')
      if (libraryExport) {
        const configurableUri = libraryExport.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri')
        if (configurableUri) {
          const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri')
          if (uri) {
            const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal')
            if (stringLiteral) {
              moduleName = getNodeText(stringLiteral, source).replace(/['"]/g, '')
            }
          }
        }
      }
    }

    if (moduleName) {
      return { moduleName, signature: importText }
    }
    return null
  },
  extractBareCall: (node: SyntaxNode, _source: string) => {
    if (node.type === 'selector') {
      const hasArgPart = node.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part')
      if (!hasArgPart) return undefined

      const prev = node.previousNamedSibling
      if (!prev) return undefined

      if (prev.type === 'identifier') {
        return prev.text
      }

      if (prev.type === 'selector') {
        const accessor = prev.namedChildren.find((c: SyntaxNode) =>
          c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector'
        )
        if (accessor) {
          const methodId = accessor.namedChildren.find((c: SyntaxNode) => c.type === 'identifier')
          if (methodId) {
            const accessorPrev = prev.previousNamedSibling
            if (accessorPrev?.type === 'identifier') {
              return accessorPrev.text + '.' + methodId.text
            }
            return methodId.text
          }
        }
      }

      if (prev.type === 'unconditional_assignable_selector' || prev.type === 'conditional_assignable_selector') {
        const methodId = prev.namedChildren.find((c: SyntaxNode) => c.type === 'identifier')
        if (methodId) return methodId.text
      }

      return undefined
    }

    if (node.type === 'new_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
      if (typeId) return typeId.text
      return undefined
    }

    if (node.type === 'const_object_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
      const nameId = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier')
      if (typeId && nameId) return typeId.text + '.' + nameId.text
      if (typeId) return typeId.text
      return undefined
    }

    return undefined
  },
}
