/**
 * Tests for grammar loading and language detection.
 */

import { describe, expect, test } from 'bun:test'
import {
  EXTENSION_MAP,
  is_source_file,
  detect_language,
  is_language_supported,
  get_supported_languages,
  get_language_display_name,
  is_file_level_only_language,
  init_grammars,
  is_grammars_initialized,
  clear_parser_cache,
} from '../grammars.js'

describe('EXTENSION_MAP', () => {
  test('maps common extensions to correct languages', () => {
    expect(EXTENSION_MAP['.ts']).toBe('typescript')
    expect(EXTENSION_MAP['.tsx']).toBe('tsx')
    expect(EXTENSION_MAP['.js']).toBe('javascript')
    expect(EXTENSION_MAP['.jsx']).toBe('jsx')
    expect(EXTENSION_MAP['.py']).toBe('python')
    expect(EXTENSION_MAP['.go']).toBe('go')
    expect(EXTENSION_MAP['.rs']).toBe('rust')
    expect(EXTENSION_MAP['.java']).toBe('java')
    expect(EXTENSION_MAP['.c']).toBe('c')
    expect(EXTENSION_MAP['.cpp']).toBe('cpp')
    expect(EXTENSION_MAP['.cs']).toBe('csharp')
    expect(EXTENSION_MAP['.php']).toBe('php')
    expect(EXTENSION_MAP['.rb']).toBe('ruby')
    expect(EXTENSION_MAP['.swift']).toBe('swift')
    expect(EXTENSION_MAP['.kt']).toBe('kotlin')
    expect(EXTENSION_MAP['.dart']).toBe('dart')
    expect(EXTENSION_MAP['.pas']).toBe('pascal')
    expect(EXTENSION_MAP['.scala']).toBe('scala')
    expect(EXTENSION_MAP['.lua']).toBe('lua')
    expect(EXTENSION_MAP['.luau']).toBe('luau')
    expect(EXTENSION_MAP['.m']).toBe('objc')
  })

  test('maps TypeScript module extensions', () => {
    expect(EXTENSION_MAP['.mts']).toBe('typescript')
    expect(EXTENSION_MAP['.cts']).toBe('typescript')
  })

  test('maps JavaScript module extensions', () => {
    expect(EXTENSION_MAP['.mjs']).toBe('javascript')
    expect(EXTENSION_MAP['.cjs']).toBe('javascript')
  })

  test('maps C++ variants', () => {
    expect(EXTENSION_MAP['.cc']).toBe('cpp')
    expect(EXTENSION_MAP['.cxx']).toBe('cpp')
    expect(EXTENSION_MAP['.hpp']).toBe('cpp')
    expect(EXTENSION_MAP['.hxx']).toBe('cpp')
  })

  test('maps .h to C (disambiguated at runtime)', () => {
    expect(EXTENSION_MAP['.h']).toBe('c')
  })
})

describe('is_source_file', () => {
  test('returns true for supported extensions', () => {
    expect(is_source_file('src/test.ts')).toBe(true)
    expect(is_source_file('src/test.py')).toBe(true)
    expect(is_source_file('src/test.go')).toBe(true)
    expect(is_source_file('src/test.rs')).toBe(true)
  })

  test('returns false for unsupported extensions', () => {
    expect(is_source_file('README.md')).toBe(false)
    expect(is_source_file('image.png')).toBe(false)
    expect(is_source_file('data.json')).toBe(false)
  })

  test('returns false for files without extension', () => {
    expect(is_source_file('Makefile')).toBe(false)
  })

  test('returns true for Play routes files', () => {
    expect(is_source_file('conf/routes')).toBe(true)
    expect(is_source_file('app/conf/routes')).toBe(true)
    expect(is_source_file('conf/api.routes')).toBe(true)
  })
})

describe('detect_language', () => {
  test('detects language from file extension', () => {
    expect(detect_language('src/test.ts')).toBe('typescript')
    expect(detect_language('src/test.py')).toBe('python')
    expect(detect_language('src/test.go')).toBe('go')
    expect(detect_language('src/test.rs')).toBe('rust')
    expect(detect_language('src/test.java')).toBe('java')
  })

  test('returns unknown for unsupported extensions', () => {
    expect(detect_language('README.md')).toBe('unknown')
    expect(detect_language('data.json')).toBe('unknown')
  })

  test('detects C++ from .h file with C++ content', () => {
    const cppSource = 'namespace std { class vector { }; }'
    expect(detect_language('test.h', cppSource)).toBe('cpp')
  })

  test('detects ObjC from .h file with ObjC content', () => {
    const objcSource = '@interface MyClass : NSObject\n@end'
    expect(detect_language('test.h', objcSource)).toBe('objc')
  })

  test('defaults .h to C when no content hint', () => {
    expect(detect_language('test.h')).toBe('c')
  })

  test('detects Play routes as yaml', () => {
    expect(detect_language('conf/routes')).toBe('yaml')
  })
})

describe('is_language_supported', () => {
  test('returns true for tree-sitter languages', () => {
    expect(is_language_supported('typescript')).toBe(true)
    expect(is_language_supported('python')).toBe(true)
    expect(is_language_supported('go')).toBe(true)
    expect(is_language_supported('rust')).toBe(true)
    expect(is_language_supported('java')).toBe(true)
    expect(is_language_supported('c')).toBe(true)
    expect(is_language_supported('cpp')).toBe(true)
    expect(is_language_supported('csharp')).toBe(true)
    expect(is_language_supported('php')).toBe(true)
    expect(is_language_supported('ruby')).toBe(true)
    expect(is_language_supported('swift')).toBe(true)
    expect(is_language_supported('kotlin')).toBe(true)
    expect(is_language_supported('dart')).toBe(true)
    expect(is_language_supported('pascal')).toBe(true)
    expect(is_language_supported('scala')).toBe(true)
    expect(is_language_supported('lua')).toBe(true)
    expect(is_language_supported('luau')).toBe(true)
    expect(is_language_supported('objc')).toBe(true)
  })

  test('returns true for special languages', () => {
    expect(is_language_supported('svelte')).toBe(true)
    expect(is_language_supported('vue')).toBe(true)
    expect(is_language_supported('liquid')).toBe(true)
    expect(is_language_supported('yaml')).toBe(true)
    expect(is_language_supported('twig')).toBe(true)
    expect(is_language_supported('xml')).toBe(true)
    expect(is_language_supported('properties')).toBe(true)
  })

  test('returns false for unknown', () => {
    expect(is_language_supported('unknown')).toBe(false)
  })
})

describe('is_file_level_only_language', () => {
  test('returns true for yaml, twig, properties', () => {
    expect(is_file_level_only_language('yaml')).toBe(true)
    expect(is_file_level_only_language('twig')).toBe(true)
    expect(is_file_level_only_language('properties')).toBe(true)
  })

  test('returns false for tree-sitter languages', () => {
    expect(is_file_level_only_language('typescript')).toBe(false)
    expect(is_file_level_only_language('python')).toBe(false)
  })
})

describe('get_supported_languages', () => {
  test('returns all supported languages', () => {
    const langs = get_supported_languages()
    expect(langs).toContain('typescript')
    expect(langs).toContain('python')
    expect(langs).toContain('go')
    expect(langs).toContain('rust')
    expect(langs).toContain('svelte')
    expect(langs).toContain('vue')
    expect(langs).toContain('liquid')
    expect(langs.length).toBeGreaterThanOrEqual(21)
  })
})

describe('get_language_display_name', () => {
  test('returns display names for all languages', () => {
    expect(get_language_display_name('typescript')).toBe('TypeScript')
    expect(get_language_display_name('javascript')).toBe('JavaScript')
    expect(get_language_display_name('python')).toBe('Python')
    expect(get_language_display_name('go')).toBe('Go')
    expect(get_language_display_name('rust')).toBe('Rust')
    expect(get_language_display_name('java')).toBe('Java')
    expect(get_language_display_name('c')).toBe('C')
    expect(get_language_display_name('cpp')).toBe('C++')
    expect(get_language_display_name('csharp')).toBe('C#')
    expect(get_language_display_name('php')).toBe('PHP')
    expect(get_language_display_name('ruby')).toBe('Ruby')
    expect(get_language_display_name('swift')).toBe('Swift')
    expect(get_language_display_name('kotlin')).toBe('Kotlin')
    expect(get_language_display_name('dart')).toBe('Dart')
    expect(get_language_display_name('pascal')).toBe('Pascal / Delphi')
    expect(get_language_display_name('scala')).toBe('Scala')
    expect(get_language_display_name('lua')).toBe('Lua')
    expect(get_language_display_name('luau')).toBe('Luau')
    expect(get_language_display_name('objc')).toBe('Objective-C')
    expect(get_language_display_name('unknown')).toBe('Unknown')
  })
})

describe('init_grammars', () => {
  test('initializes the WASM runtime', async () => {
    clear_parser_cache()
    expect(is_grammars_initialized()).toBe(false)
    await init_grammars()
    expect(is_grammars_initialized()).toBe(true)
  })
})
