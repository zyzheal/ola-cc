/**
 * Tests for language extractor registration and configuration.
 */

import { describe, expect, test } from 'bun:test'
import { EXTRACTORS } from '../languages/index.js'
import type { LanguageExtractor } from '../types.js'

describe('EXTRACTORS registry', () => {
  test('registers 21 language variants', () => {
    expect(Object.keys(EXTRACTORS)).toHaveLength(21)
  })

  test('registers all expected languages', () => {
    const expected = [
      'typescript', 'tsx', 'javascript', 'jsx',
      'python', 'go', 'rust', 'java',
      'c', 'cpp', 'csharp', 'php',
      'ruby', 'swift', 'kotlin', 'dart',
      'pascal', 'scala', 'lua', 'luau', 'objc',
    ]
    for (const lang of expected) {
      expect(EXTRACTORS).toHaveProperty(lang)
    }
  })

  test('tsx shares extractor with typescript', () => {
    expect(EXTRACTORS['tsx']).toBe(EXTRACTORS['typescript'])
  })

  test('jsx shares extractor with javascript', () => {
    expect(EXTRACTORS['jsx']).toBe(EXTRACTORS['javascript'])
  })
})

describe('Extractor configurations', () => {
  function validateExtractor(name: string, extractor: LanguageExtractor) {
    test(`${name} has valid configuration`, () => {
      // Required fields
      expect(Array.isArray(extractor.functionTypes)).toBe(true)
      expect(Array.isArray(extractor.classTypes)).toBe(true)
      expect(Array.isArray(extractor.methodTypes)).toBe(true)
      expect(Array.isArray(extractor.interfaceTypes)).toBe(true)
      expect(Array.isArray(extractor.structTypes)).toBe(true)
      expect(Array.isArray(extractor.enumTypes)).toBe(true)
      expect(Array.isArray(extractor.typeAliasTypes)).toBe(true)
      expect(Array.isArray(extractor.importTypes)).toBe(true)
      expect(Array.isArray(extractor.callTypes)).toBe(true)
      expect(Array.isArray(extractor.variableTypes)).toBe(true)

      // Field names
      expect(typeof extractor.nameField).toBe('string')
      expect(typeof extractor.bodyField).toBe('string')

      // Optional arrays
      if (extractor.enumMemberTypes) {
        expect(Array.isArray(extractor.enumMemberTypes)).toBe(true)
      }
      if (extractor.fieldTypes) {
        expect(Array.isArray(extractor.fieldTypes)).toBe(true)
      }
      if (extractor.propertyTypes) {
        expect(Array.isArray(extractor.propertyTypes)).toBe(true)
      }
      if (extractor.extraClassNodeTypes) {
        expect(Array.isArray(extractor.extraClassNodeTypes)).toBe(true)
      }

      // Optional hooks
      if (extractor.getSignature) expect(typeof extractor.getSignature).toBe('function')
      if (extractor.getVisibility) expect(typeof extractor.getVisibility).toBe('function')
      if (extractor.isExported) expect(typeof extractor.isExported).toBe('function')
      if (extractor.isAsync) expect(typeof extractor.isAsync).toBe('function')
      if (extractor.isStatic) expect(typeof extractor.isStatic).toBe('function')
      if (extractor.isConst) expect(typeof extractor.isConst).toBe('function')
      if (extractor.visitNode) expect(typeof extractor.visitNode).toBe('function')
      if (extractor.classifyClassNode) expect(typeof extractor.classifyClassNode).toBe('function')
      if (extractor.resolveBody) expect(typeof extractor.resolveBody).toBe('function')
      if (extractor.extractImport) expect(typeof extractor.extractImport).toBe('function')
      if (extractor.getReceiverType) expect(typeof extractor.getReceiverType).toBe('function')
      if (extractor.resolveTypeAliasKind) expect(typeof extractor.resolveTypeAliasKind).toBe('function')
      if (extractor.isMisparsedFunction) expect(typeof extractor.isMisparsedFunction).toBe('function')
      if (extractor.extractBareCall) expect(typeof extractor.extractBareCall).toBe('function')
      if (extractor.extractPackage) expect(typeof extractor.extractPackage).toBe('function')
    })
  }

  // Validate each extractor
  for (const [name, extractor] of Object.entries(EXTRACTORS)) {
    if (extractor) {
      validateExtractor(name, extractor)
    }
  }
})

describe('TypeScript extractor specifics', () => {
  test('has correct node types', () => {
    const ext = EXTRACTORS['typescript']!
    expect(ext.functionTypes).toContain('function_declaration')
    expect(ext.functionTypes).toContain('arrow_function')
    expect(ext.functionTypes).toContain('function_expression')
    expect(ext.classTypes).toContain('class_declaration')
    expect(ext.classTypes).toContain('abstract_class_declaration')
    expect(ext.interfaceTypes).toContain('interface_declaration')
    expect(ext.enumTypes).toContain('enum_declaration')
    expect(ext.typeAliasTypes).toContain('type_alias_declaration')
  })

  test('has hooks defined', () => {
    const ext = EXTRACTORS['typescript']!
    expect(ext.getSignature).toBeDefined()
    expect(ext.getVisibility).toBeDefined()
    expect(ext.isExported).toBeDefined()
    expect(ext.isAsync).toBeDefined()
    expect(ext.isStatic).toBeDefined()
    expect(ext.isConst).toBeDefined()
    expect(ext.extractImport).toBeDefined()
    expect(ext.resolveBody).toBeDefined()
  })
})

describe('Go extractor specifics', () => {
  test('has methodsAreTopLevel enabled', () => {
    const ext = EXTRACTORS['go']!
    expect(ext.methodsAreTopLevel).toBe(true)
  })

  test('has resolveTypeAliasKind for struct/interface', () => {
    const ext = EXTRACTORS['go']!
    expect(ext.resolveTypeAliasKind).toBeDefined()
  })

  test('has getReceiverType for method receivers', () => {
    const ext = EXTRACTORS['go']!
    expect(ext.getReceiverType).toBeDefined()
  })
})

describe('Rust extractor specifics', () => {
  test('has interfaceKind set to trait', () => {
    const ext = EXTRACTORS['rust']!
    expect(ext.interfaceKind).toBe('trait')
  })

  test('has getReceiverType for impl blocks', () => {
    const ext = EXTRACTORS['rust']!
    expect(ext.getReceiverType).toBeDefined()
  })
})

describe('C++ extractor specifics', () => {
  test('has isMisparsedFunction for macro detection', () => {
    const ext = EXTRACTORS['cpp']!
    expect(ext.isMisparsedFunction).toBeDefined()
  })

  test('has resolveName for qualified methods', () => {
    const ext = EXTRACTORS['cpp']!
    expect(ext.resolveName).toBeDefined()
  })
})

describe('Kotlin extractor specifics', () => {
  test('has classifyClassNode for interface/enum detection', () => {
    const ext = EXTRACTORS['kotlin']!
    expect(ext.classifyClassNode).toBeDefined()
  })

  test('has visitNode for fun interface handling', () => {
    const ext = EXTRACTORS['kotlin']!
    expect(ext.visitNode).toBeDefined()
  })

  test('has packageTypes for package declarations', () => {
    const ext = EXTRACTORS['kotlin']!
    expect(ext.packageTypes).toContain('package_header')
  })
})

describe('Ruby extractor specifics', () => {
  test('has visitNode for module handling', () => {
    const ext = EXTRACTORS['ruby']!
    expect(ext.visitNode).toBeDefined()
  })

  test('has extractBareCall for bare method calls', () => {
    const ext = EXTRACTORS['ruby']!
    expect(ext.extractBareCall).toBeDefined()
  })
})

describe('Lua extractor specifics', () => {
  test('has visitNode for require handling', () => {
    const ext = EXTRACTORS['lua']!
    expect(ext.visitNode).toBeDefined()
  })

  test('has getReceiverType for table methods', () => {
    const ext = EXTRACTORS['lua']!
    expect(ext.getReceiverType).toBeDefined()
  })
})

describe('Luau extractor', () => {
  test('extends Lua extractor', () => {
    const lua = EXTRACTORS['lua']!
    const luau = EXTRACTORS['luau']!
    // Luau should have typeAliasTypes (Lua doesn't)
    expect(luau.typeAliasTypes).toContain('type_definition')
    // Luau should have isExported hook
    expect(luau.isExported).toBeDefined()
  })
})

describe('Dart extractor specifics', () => {
  test('has extractBareCall for selector-based calls', () => {
    const ext = EXTRACTORS['dart']!
    expect(ext.extractBareCall).toBeDefined()
  })

  test('has extraClassNodeTypes for mixins', () => {
    const ext = EXTRACTORS['dart']!
    expect(ext.extraClassNodeTypes).toContain('mixin_declaration')
    expect(ext.extraClassNodeTypes).toContain('extension_declaration')
  })
})

describe('ObjC extractor specifics', () => {
  test('has interfaceKind set to protocol', () => {
    const ext = EXTRACTORS['objc']!
    expect(ext.interfaceKind).toBe('protocol')
  })

  test('has visitNode for @implementation handling', () => {
    const ext = EXTRACTORS['objc']!
    expect(ext.visitNode).toBeDefined()
  })

  test('has resolveName for multi-part selectors', () => {
    const ext = EXTRACTORS['objc']!
    expect(ext.resolveName).toBeDefined()
  })

  test('has extractPropertyName for @property', () => {
    const ext = EXTRACTORS['objc']!
    expect(ext.extractPropertyName).toBeDefined()
  })
})
