/**
 * Kotlin language extractor configuration.
 * Ported from codegraph with full feature parity.
 */

import type { LanguageExtractor, SyntaxNode } from '../types.js'
import { getNodeText, getChildByField } from '../helpers.js'

/** Check if a node matches the `fun interface` misparse pattern */
function isFunInterfaceNode(node: SyntaxNode): boolean {
  let hasFun = false
  let hasInterfaceType = false
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === 'fun' && !child.isNamed) hasFun = true
    if (child.type === 'user_type') {
      const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
      if (typeId && typeId.text === 'interface') hasInterfaceType = true
    }
    if (child.type === 'ERROR') {
      for (let j = 0; j < child.childCount; j++) {
        const gc = child.child(j)
        if (gc && gc.type === 'user_type') {
          const typeId = gc.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
          if (typeId && typeId.text === 'interface') hasInterfaceType = true
        }
      }
    }
  }
  return hasFun && hasInterfaceType
}

export const kotlinExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'],
  interfaceTypes: [], // Handled via classifyClassNode
  structTypes: [],
  enumTypes: [], // Handled via classifyClassNode
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_header'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration'],
  fieldTypes: ['property_declaration'],
  extraClassNodeTypes: ['object_declaration'],
  nameField: 'simple_identifier',
  bodyField: 'function_body',
  visitNode: (node: SyntaxNode, ctx) => {
    if (node.type === 'lambda_literal') {
      const prev = node.previousSibling
      if (prev && prev.type === 'ERROR' && isFunInterfaceNode(prev)) return true
      return false
    }

    if (node.type !== 'ERROR' && node.type !== 'function_declaration') return false

    if (node.type === 'ERROR') {
      const firstChild = node.child(0)
      if (firstChild && firstChild.type === '{') return false
    }

    if (!isFunInterfaceNode(node)) return false

    let nameText: string | null = null
    if (node.type === 'function_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child && child.type === 'ERROR') {
          for (let j = 0; j < child.childCount; j++) {
            const gc = child.child(j)
            if (gc && gc.type === 'simple_identifier') {
              nameText = gc.text
              break
            }
          }
          if (nameText) break
        }
      }
    }
    if (!nameText) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (child && child.type === 'simple_identifier') {
          nameText = child.text
          break
        }
      }
    }
    if (!nameText) return false

    const ifaceNode = ctx.createNode('interface', nameText, node)
    if (!ifaceNode) return false

    ctx.pushScope(ifaceNode.id)

    if (node.type === 'ERROR') {
      const nextSibling = node.nextSibling
      if (nextSibling && nextSibling.type === 'lambda_literal') {
        for (let i = 0; i < nextSibling.namedChildCount; i++) {
          const child = nextSibling.namedChild(i)
          if (child && child.type === 'statements') {
            for (let j = 0; j < child.namedChildCount; j++) {
              const stmt = child.namedChild(j)
              if (stmt) ctx.visitNode(stmt)
            }
          }
        }
      }
    }

    ctx.popScope()
    return true
  },
  paramsField: 'function_value_parameters',
  returnField: 'type',
  resolveBody: (node: SyntaxNode, _bodyField: string) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i)
      if (child && child.type === 'ERROR') {
        const firstChild = child.child(0)
        if (firstChild && firstChild.type === '{') {
          return child
        }
      }
      if (child && (child.type === 'function_body' || child.type === 'class_body' || child.type === 'enum_class_body')) {
        return child
      }
    }
    return null
  },
  classifyClassNode: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child) continue
      if (child.type === 'interface') return 'interface'
      if (child.type === 'enum') return 'enum'
    }
    return 'class'
  },
  getReceiverType: (node: SyntaxNode, source: string) => {
    let foundUserType: SyntaxNode | null = null
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (!child) continue
      if (child.type === 'user_type') {
        foundUserType = child
      } else if (child.type === '.' && foundUserType) {
        const typeId = foundUserType.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
        return typeId ? getNodeText(typeId, source) : getNodeText(foundUserType, source)
      } else if (child.type === 'simple_identifier' || child.type === 'function_value_parameters') {
        break
      }
    }
    return undefined
  },
  getSignature: (node: SyntaxNode, source: string) => {
    const params = getChildByField(node, 'function_value_parameters')
    const returnType = getChildByField(node, 'type')
    if (!params) return undefined
    let sig = getNodeText(params, source)
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source)
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
        if (text.includes('protected')) return 'protected'
        if (text.includes('internal')) return 'internal'
      }
    }
    return 'public' // Kotlin defaults to public
  },
  isStatic: (_node: SyntaxNode) => {
    return false // Kotlin doesn't have static, uses companion objects
  },
  isAsync: (node: SyntaxNode) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)
      if (child?.type === 'modifiers' && child.text.includes('suspend')) {
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
  packageTypes: ['package_header'],
  extractPackage: (node: SyntaxNode, source: string) => {
    const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier')
    return id ? source.substring(id.startIndex, id.endIndex).trim() : null
  },
}
