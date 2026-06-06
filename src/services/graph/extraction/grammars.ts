/**
 * Grammar Loading and Caching
 *
 * Uses web-tree-sitter (WASM) for universal cross-platform support.
 * Grammars are loaded lazily -- only languages actually present in the project
 * are compiled, keeping V8 WASM memory pressure low on large codebases.
 */

import * as path from 'path'
import { Parser, Language as WasmLanguage } from 'web-tree-sitter'
import type { Language } from './types.js'

export type GrammarLanguage = Exclude<Language, 'svelte' | 'vue' | 'liquid' | 'yaml' | 'twig' | 'xml' | 'properties' | 'unknown'>

/**
 * WASM filename map -- maps each language to its .wasm grammar file
 * in the tree-sitter-wasms package.
 */
const WASM_GRAMMAR_FILES: Record<GrammarLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  php: 'tree-sitter-php.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  dart: 'tree-sitter-dart.wasm',
  pascal: 'tree-sitter-pascal.wasm',
  scala: 'tree-sitter-scala.wasm',
  lua: 'tree-sitter-lua.wasm',
  luau: 'tree-sitter-luau.wasm',
  objc: 'tree-sitter-objc.wasm',
}

/**
 * File extension to Language mapping
 */
export const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.xsjs': 'javascript',
  '.xsjslib': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.module': 'php',
  '.install': 'php',
  '.theme': 'php',
  '.inc': 'php',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.twig': 'twig',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.dart': 'dart',
  '.liquid': 'liquid',
  '.svelte': 'svelte',
  '.vue': 'vue',
  '.pas': 'pascal',
  '.dpr': 'pascal',
  '.dpk': 'pascal',
  '.lpr': 'pascal',
  '.dfm': 'pascal',
  '.fmx': 'pascal',
  '.scala': 'scala',
  '.sc': 'scala',
  '.lua': 'lua',
  '.luau': 'luau',
  '.m': 'objc',
  '.mm': 'objc',
  '.xml': 'xml',
  '.properties': 'properties',
}

/**
 * Whether a file is one we can parse, based purely on its extension.
 */
export function is_source_file(file_path: string): boolean {
  if (is_play_routes_file(file_path)) return true
  const dot = file_path.lastIndexOf('.')
  if (dot < 0) return false
  return file_path.slice(dot).toLowerCase() in EXTENSION_MAP
}

/**
 * Play Framework routes file detection.
 */
export function is_play_routes_file(file_path: string): boolean {
  return (
    file_path === 'conf/routes' ||
    file_path.endsWith('/conf/routes') ||
    file_path.endsWith('.routes')
  )
}

/**
 * Caches for loaded grammars and parsers
 */
const parserCache = new Map<Language, Parser>()
const languageCache = new Map<Language, WasmLanguage>()
const unavailableGrammarErrors = new Map<Language, string>()

let parserInitialized = false

/**
 * Initialize the tree-sitter WASM runtime. Must be called before loading grammars.
 * Idempotent -- safe to call multiple times.
 */
export async function init_grammars(): Promise<void> {
  if (parserInitialized) return
  await Parser.init()
  parserInitialized = true
}

/**
 * Load grammar WASM files for specific languages only.
 * Skips languages that are already loaded or have no WASM grammar.
 * Must be called after init_grammars().
 */
export async function load_grammars_for_languages(languages: Language[]): Promise<void> {
  if (!parserInitialized) {
    await init_grammars()
  }

  const toLoad = [...new Set(languages)].filter(
    (lang): lang is GrammarLanguage =>
      lang in WASM_GRAMMAR_FILES &&
      !languageCache.has(lang) &&
      !unavailableGrammarErrors.has(lang)
  )

  // Load grammars sequentially to avoid web-tree-sitter WASM race condition on Node 20+
  for (const lang of toLoad) {
    const wasmFile = WASM_GRAMMAR_FILES[lang]
    try {
      const wasmPath = (lang === 'pascal' || lang === 'scala' || lang === 'lua' || lang === 'luau')
        ? path.join(__dirname, 'wasm', wasmFile)
        : require.resolve(`tree-sitter-wasms/out/${wasmFile}`)
      const language = await WasmLanguage.load(wasmPath)
      languageCache.set(lang, language)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[GraphExtraction] Failed to load ${lang} grammar: ${message}`)
      unavailableGrammarErrors.set(lang, message)
    }
  }
}

/**
 * Load ALL grammar WASM files. Convenience function for tests.
 */
export async function load_all_grammars(): Promise<void> {
  const allLanguages = Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[]
  await load_grammars_for_languages(allLanguages)
}

/**
 * Check if grammars have been initialized
 */
export function is_grammars_initialized(): boolean {
  return parserInitialized
}

/**
 * Get a parser for the specified language.
 * Returns synchronously from pre-loaded cache.
 */
export function get_parser(language: Language): Parser | null {
  if (parserCache.has(language)) {
    return parserCache.get(language)!
  }

  const lang = languageCache.get(language)
  if (!lang) {
    return null
  }

  const parser = new Parser()
  parser.setLanguage(lang)
  parserCache.set(language, parser)
  return parser
}

/**
 * Detect language from file extension
 */
export function detect_language(file_path: string, source?: string): Language {
  if (is_play_routes_file(file_path)) return 'yaml'
  const ext = file_path.substring(file_path.lastIndexOf('.')).toLowerCase()
  const lang = EXTENSION_MAP[ext] || 'unknown'

  if (lang === 'c' && ext === '.h' && source) {
    if (looks_like_cpp(source)) return 'cpp'
    if (looks_like_objc(source)) return 'objc'
  }

  return lang
}

function looks_like_cpp(source: string): boolean {
  const sample = source.substring(0, 8192)
  return /\bnamespace\b|\bclass\s+\w+\s*[:{]|\btemplate\s*<|\b(?:public|private|protected)\s*:|\bvirtual\b|\busing\s+(?:namespace\b|\w+\s*=)/.test(sample)
}

function looks_like_objc(source: string): boolean {
  const sample = source.substring(0, 8192)
  return /@(?:interface|implementation|protocol|synthesize)\b/.test(sample)
}

/**
 * Check if a language is supported (has a grammar defined).
 */
export function is_language_supported(language: Language): boolean {
  if (language === 'svelte') return true
  if (language === 'vue') return true
  if (language === 'liquid') return true
  if (language === 'yaml') return true
  if (language === 'twig') return true
  if (language === 'xml') return true
  if (language === 'properties') return true
  if (language === 'unknown') return false
  return language in WASM_GRAMMAR_FILES
}

/**
 * Check if a grammar has been loaded and is ready for parsing.
 */
export function is_grammar_loaded(language: Language): boolean {
  if (language === 'svelte' || language === 'vue' || language === 'liquid') return true
  if (language === 'yaml' || language === 'twig') return true
  if (language === 'xml' || language === 'properties') return true
  return languageCache.has(language)
}

/**
 * Check if a language only produces file-level nodes (no symbol extraction).
 */
export function is_file_level_only_language(language: Language): boolean {
  return language === 'yaml' || language === 'twig' || language === 'properties'
}

/**
 * Get all supported languages (those with grammar definitions).
 */
export function get_supported_languages(): Language[] {
  return [...(Object.keys(WASM_GRAMMAR_FILES) as GrammarLanguage[]), 'svelte', 'vue', 'liquid']
}

/**
 * Reset the cached parser for a language to reclaim WASM heap memory.
 */
export function reset_parser(language: Language): void {
  const old = parserCache.get(language)
  if (old) {
    old.delete()
    parserCache.delete(language)
  }
}

/**
 * Clear parser/grammar caches (useful for testing)
 */
export function clear_parser_cache(): void {
  for (const parser of parserCache.values()) {
    parser.delete()
  }
  parserCache.clear()
  unavailableGrammarErrors.clear()
}

/**
 * Report grammars that failed to load.
 */
export function get_unavailable_grammar_errors(): Partial<Record<Language, string>> {
  const out: Partial<Record<Language, string>> = {}
  for (const [language, message] of unavailableGrammarErrors.entries()) {
    out[language] = message
  }
  return out
}

/**
 * Get language display name
 */
export function get_language_display_name(language: Language): string {
  const names: Record<Language, string> = {
    typescript: 'TypeScript',
    javascript: 'JavaScript',
    tsx: 'TypeScript (TSX)',
    jsx: 'JavaScript (JSX)',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    php: 'PHP',
    ruby: 'Ruby',
    swift: 'Swift',
    kotlin: 'Kotlin',
    dart: 'Dart',
    svelte: 'Svelte',
    vue: 'Vue',
    liquid: 'Liquid',
    pascal: 'Pascal / Delphi',
    scala: 'Scala',
    lua: 'Lua',
    luau: 'Luau',
    objc: 'Objective-C',
    yaml: 'YAML',
    twig: 'Twig',
    xml: 'XML',
    properties: 'Java properties',
    unknown: 'Unknown',
  }
  return names[language] || language
}

// ============================================================
// Backward-compatible camelCase aliases
// ============================================================

/** @deprecated Use init_grammars */
export const initGrammars = init_grammars
/** @deprecated Use load_grammars_for_languages */
export const loadGrammarsForLanguages = load_grammars_for_languages
/** @deprecated Use load_all_grammars */
export const loadAllGrammars = load_all_grammars
/** @deprecated Use is_grammars_initialized */
export const isGrammarsInitialized = is_grammars_initialized
/** @deprecated Use get_parser */
export const getParser = get_parser
/** @deprecated Use detect_language */
export const detectLanguage = detect_language
/** @deprecated Use is_source_file */
export const isSourceFile = is_source_file
/** @deprecated Use is_language_supported */
export const isLanguageSupported = is_language_supported
/** @deprecated Use is_grammar_loaded */
export const isGrammarLoaded = is_grammar_loaded
/** @deprecated Use get_supported_languages */
export const getSupportedLanguages = get_supported_languages
/** @deprecated Use reset_parser */
export const resetParser = reset_parser
/** @deprecated Use clear_parser_cache */
export const clearParserCache = clear_parser_cache
/** @deprecated Use get_unavailable_grammar_errors */
export const getUnavailableGrammarErrors = get_unavailable_grammar_errors
/** @deprecated Use get_language_display_name */
export const getLanguageDisplayName = get_language_display_name
