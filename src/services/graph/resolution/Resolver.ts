/**
 * Resolver.ts — Phase 6c-0: Core resolution orchestrator
 *
 * Migrated from codegraph/src/resolution/index.ts.
 * Coordinates reference resolution using multiple strategies:
 *  1. Built-in filtering (skip known built-ins)
 *  2. Qualified name match (highest confidence)
 *  3. Exact name match
 *  4. Fuzzy match (lowest confidence)
 *
 * Phase 6c-0 scope: core pipeline only.
 * Deferred to Phase 6c-1/2/3: import resolution, framework detection,
 * callback synthesis wiring.
 *
 * Source mapping:
 *  codegraph Node      → NodeMetadata (from GraphStore)
 *  codegraph QueryBuilder → GraphStoreAdapter
 *  n.filePath          → n.file
 *  n.startLine         → n.line
 *  n.endLine           → n.end_line
 *  n.qualifiedName     → n.qualified_name
 *  n.isExported        → n.is_exported
 */

import type { NodeMetadata, EdgeType } from '../GraphStore.js'
import type { GraphStoreAdapter } from '../CallbackSynthesizerTypes.js'
import { LRUCache } from '../LRUCache.js'
import { loadCppIncludeDirs } from './cppIncludeDirs.js'

// ============================================================
// Local types (parallel creation with types.ts agent)
// ============================================================

export type ReferenceKind =
  | 'calls' | 'imports' | 'data' | 'control' | 'inherits'
  | 'implements' | 'extends' | 'instantiates' | 'decorates'
  | 'overrides' | 'exports' | 'reads' | 'writes'

export type ResolutionLanguage =
  | 'typescript' | 'javascript' | 'tsx' | 'jsx'
  | 'python' | 'go' | 'java' | 'kotlin' | 'rust'
  | 'c' | 'cpp' | 'pascal' | 'unknown'

export interface LocalUnresolvedRef {
  fromNodeId: string
  referenceName: string
  referenceKind: ReferenceKind
  line: number
  column: number
  filePath: string
  language: ResolutionLanguage
}

export interface LocalResolvedRef {
  original: LocalUnresolvedRef
  targetNodeId: string
  confidence: number
  resolvedBy: 'exact-match' | 'qualified-name' | 'fuzzy' | 'file-path' | 'instance-method'
}

export interface ResolutionResult {
  resolved: LocalResolvedRef[]
  unresolved: LocalUnresolvedRef[]
  stats: {
    total: number
    resolved: number
    unresolved: number
    byMethod: Record<string, number>
  }
}

export interface LocalResolutionContext {
  getNodesInFile(filePath: string): NodeMetadata[]
  getNodesByName(name: string): NodeMetadata[]
  getNodesByQualifiedName(qualifiedName: string): NodeMetadata[]
  getNodesByKind(kind: string): NodeMetadata[]
  fileExists(filePath: string): boolean
  readFile(filePath: string): string | null
  getProjectRoot(): string
  getAllFiles(): string[]
  getNodesByLowerName(lowerName: string): NodeMetadata[]
  /** C/C++ include search directories */
  getCppIncludeDirs(): string[]
}

// ============================================================
// Built-in symbol sets (allocated once, shared across all instances)
// ============================================================

const JS_BUILT_INS = new Set([
  'console', 'window', 'document', 'global', 'process',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Math', 'JSON', 'RegExp', 'Error', 'Map', 'Set',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'fetch', 'require', 'module', 'exports', '__dirname', '__filename',
])

const REACT_HOOKS = new Set([
  'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
  'useMemo', 'useRef', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
])

const PYTHON_BUILT_INS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'open', 'input', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'super', 'self', 'cls', 'None', 'True', 'False',
])

const PYTHON_BUILT_IN_TYPES = new Set([
  'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'bytes', 'bytearray', 'frozenset', 'object', 'super',
])

const PYTHON_BUILT_IN_METHODS = new Set([
  'append', 'extend', 'insert', 'remove', 'pop', 'clear', 'sort', 'reverse', 'copy',
  'update', 'keys', 'values', 'items', 'get',
  'add', 'discard', 'union', 'intersection', 'difference',
  'split', 'join', 'strip', 'lstrip', 'rstrip', 'replace', 'lower', 'upper',
  'startswith', 'endswith', 'find', 'index', 'count', 'encode', 'decode',
  'format', 'isdigit', 'isalpha', 'isalnum',
  'read', 'write', 'readline', 'readlines', 'close', 'flush', 'seek',
])

const GO_STDLIB_PACKAGES = new Set([
  'fmt', 'os', 'io', 'net', 'http', 'log', 'math', 'sort', 'sync',
  'time', 'path', 'bytes', 'strings', 'strconv', 'errors', 'context',
  'json', 'xml', 'csv', 'html', 'template', 'regexp', 'reflect',
  'runtime', 'testing', 'flag', 'bufio', 'crypto', 'encoding',
  'filepath', 'hash', 'mime', 'rand', 'signal', 'sql', 'syscall',
  'unicode', 'unsafe', 'atomic', 'binary', 'debug', 'exec', 'heap',
  'ring', 'scanner', 'tar', 'zip', 'gzip', 'zlib', 'tls', 'url',
  'user', 'pprof', 'trace', 'ast', 'build', 'parser', 'printer',
  'token', 'types', 'cgo', 'plugin', 'race', 'ioutil',
])

const GO_BUILT_INS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'close',
  'panic', 'recover', 'print', 'println', 'complex', 'real', 'imag',
  'error', 'nil', 'true', 'false', 'iota',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
  'string', 'bool', 'byte', 'rune', 'any',
])

const PASCAL_UNIT_PREFIXES = [
  'System.', 'Winapi.', 'Vcl.', 'Fmx.', 'Data.', 'Datasnap.',
  'Soap.', 'Xml.', 'Web.', 'REST.', 'FireDAC.', 'IBX.',
  'IdHTTP', 'IdTCP', 'IdSSL',
]

const PASCAL_BUILT_INS = new Set([
  'System', 'SysUtils', 'Classes', 'Types', 'Variants', 'StrUtils',
  'Math', 'DateUtils', 'IOUtils', 'Generics.Collections', 'Generics.Defaults',
  'Rtti', 'TypInfo', 'SyncObjs', 'RegularExpressions',
  'SysInit', 'Windows', 'Messages', 'Graphics', 'Controls', 'Forms',
  'Dialogs', 'StdCtrls', 'ExtCtrls', 'ComCtrls', 'Menus', 'ActnList',
  'WriteLn', 'Write', 'ReadLn', 'Read', 'Inc', 'Dec', 'Ord', 'Chr',
  'Length', 'SetLength', 'High', 'Low', 'Assigned', 'FreeAndNil',
  'Format', 'IntToStr', 'StrToInt', 'FloatToStr', 'StrToFloat',
  'Trim', 'UpperCase', 'LowerCase', 'Pos', 'Copy', 'Delete', 'Insert',
  'Now', 'Date', 'Time', 'DateToStr', 'StrToDate',
  'Raise', 'Exit', 'Break', 'Continue', 'Abort',
  'True', 'False', 'nil', 'Self', 'Result',
  'Create', 'Destroy', 'Free',
  'TObject', 'TComponent', 'TPersistent', 'TInterfacedObject',
  'TList', 'TStringList', 'TStrings', 'TStream', 'TMemoryStream', 'TFileStream',
  'Exception', 'EAbort', 'EConvertError', 'EAccessViolation',
  'IInterface', 'IUnknown',
])

const C_BUILT_INS = new Set([
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf',
  'malloc', 'calloc', 'realloc', 'free',
  'memcpy', 'memmove', 'memset', 'memcmp', 'memchr',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp',
  'strstr', 'strchr', 'strrchr', 'strtok', 'strdup',
  'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs', 'fputc', 'fgetc',
  'feof', 'ferror', 'fflush', 'fseek', 'ftell', 'rewind',
  'exit', 'abort', 'atexit', 'atoi', 'atol', 'atof', 'strtol', 'strtoul', 'strtod',
  'qsort', 'bsearch',
  'abs', 'labs', 'rand', 'srand',
  'sin', 'cos', 'tan', 'sqrt', 'pow', 'log', 'log10', 'exp', 'ceil', 'floor', 'fabs',
  'time', 'clock', 'difftime', 'mktime', 'localtime', 'gmtime', 'strftime', 'asctime',
  'assert', 'errno',
  'perror', 'remove', 'rename', 'tmpfile', 'tmpnam',
  'getenv', 'system',
  'signal', 'raise',
  'setjmp', 'longjmp',
  'va_start', 'va_end', 'va_arg', 'va_copy',
  'NULL', 'EOF', 'BUFSIZ', 'FILENAME_MAX', 'RAND_MAX', 'EXIT_SUCCESS', 'EXIT_FAILURE',
  'size_t', 'ptrdiff_t', 'wchar_t', 'intptr_t', 'uintptr_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'FILE',
  'stat', 'lstat', 'fstat', 'open', 'close', 'read', 'write', 'pipe',
  'fork', 'exec', 'waitpid', 'getpid', 'getppid', 'kill', 'sleep', 'usleep',
  'pthread_create', 'pthread_join', 'pthread_mutex_lock', 'pthread_mutex_unlock',
  'dlopen', 'dlsym', 'dlclose',
])

const CPP_BUILT_INS = new Set([
  'cout', 'cin', 'cerr', 'clog', 'endl', 'flush', 'ws',
  'std',
  'nullptr', 'true', 'false', 'this', 'sizeof', 'alignof', 'typeid',
  'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
  'make_unique', 'make_shared', 'make_pair',
  'move', 'forward', 'swap',
])

// ============================================================
// Cache size limits
// ============================================================

const DEFAULT_CACHE_LIMIT = 5_000

function resolveCacheLimit(): number {
  const raw = process.env.CODEGRAPH_RESOLVER_CACHE_SIZE
  if (!raw) return DEFAULT_CACHE_LIMIT
  const parsed = Number.parseInt(raw, 10)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return DEFAULT_CACHE_LIMIT
}

// ============================================================
// Path proximity helper
// ============================================================

function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/').slice(0, -1)
  const dir2 = filePath2.split('/').slice(0, -1)
  let shared = 0
  for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
    if (dir1[i] === dir2[i]) shared++
    else break
  }
  return Math.min(shared * 15, 80)
}

// ============================================================
// ReferenceResolver
// ============================================================

export class ReferenceResolver {
  private adapter: GraphStoreAdapter
  private projectRoot: string
  private context: LocalResolutionContext

  // Per-resolver caches (LRU-bounded)
  private nameCache: LRUCache<string, NodeMetadata[]>
  private lowerNameCache: LRUCache<string, NodeMetadata[]>
  private qualifiedNameCache: LRUCache<string, NodeMetadata[]>
  private nodeCache: LRUCache<string, NodeMetadata[]>
  private knownNames: Set<string> | null = null
  private knownLowerNames: Set<string> | null = null
  private cachesWarmed = false

  constructor(projectRoot: string, adapter: GraphStoreAdapter) {
    this.projectRoot = projectRoot
    this.adapter = adapter

    const limit = resolveCacheLimit()
    this.nameCache = new LRUCache(limit)
    this.lowerNameCache = new LRUCache(limit)
    this.qualifiedNameCache = new LRUCache(limit)
    this.nodeCache = new LRUCache(limit)

    this.context = this.createContext()
  }

  /**
   * Get the resolution context (for testing / external use).
   */
  getContext(): LocalResolutionContext {
    return this.context
  }

  // ----------------------------------------------------------
  // Context creation
  // ----------------------------------------------------------

  private createContext(): LocalResolutionContext {
    return {
      getNodesInFile: (filePath: string): NodeMetadata[] => {
        const cached = this.nodeCache.get(filePath)
        if (cached !== undefined) return cached
        const result = this.adapter.getNodesInFile(filePath)
        this.nodeCache.set(filePath, result)
        return result
      },

      getNodesByName: (name: string): NodeMetadata[] => {
        const cached = this.nameCache.get(name)
        if (cached !== undefined) return cached
        const result = this.adapter.getNodesByName(name)
        this.nameCache.set(name, result)
        return result
      },

      getNodesByQualifiedName: (qualifiedName: string): NodeMetadata[] => {
        const cached = this.qualifiedNameCache.get(qualifiedName)
        if (cached !== undefined) return cached
        // Linear scan for qualified name — adapter doesn't have an index
        const result: NodeMetadata[] = []
        for (const [, meta] of (this.adapter as any).store.nodeMeta) {
          if (meta.qualified_name === qualifiedName) result.push(meta)
        }
        this.qualifiedNameCache.set(qualifiedName, result)
        return result
      },

      getNodesByKind: (kind: string): NodeMetadata[] => {
        return this.adapter.getNodesByKind(kind)
      },

      fileExists: (_filePath: string): boolean => {
        // For Phase 6c-0, we don't have filesystem access through the adapter.
        // Return false — file existence checks will be added when import resolution lands.
        return false
      },

      readFile: (_filePath: string): string | null => {
        // For Phase 6c-0, we don't have file reading through the adapter.
        return null
      },

      getProjectRoot: () => this.projectRoot,

      getAllFiles: (): string[] => {
        return this.adapter.getAllFiles()
      },

      getNodesByLowerName: (lowerName: string): NodeMetadata[] => {
        const cached = this.lowerNameCache.get(lowerName)
        if (cached !== undefined) return cached
        // Linear scan for lower-case name
        const result: NodeMetadata[] = []
        for (const [, meta] of (this.adapter as any).store.nodeMeta) {
          if (meta.name.toLowerCase() === lowerName) result.push(meta)
        }
        this.lowerNameCache.set(lowerName, result)
        return result
      },

      getCppIncludeDirs: (): string[] => {
        return loadCppIncludeDirs(this.projectRoot)
      },
    }
  }

  // ----------------------------------------------------------
  // Cache management
  // ----------------------------------------------------------

  /**
   * Pre-build the set of known symbol names for fast pre-filtering.
   */
  warmCaches(): void {
    if (this.cachesWarmed) return
    const names = new Set<string>()
    const lowerNames = new Set<string>()
    for (const [, meta] of (this.adapter as any).store.nodeMeta) {
      names.add(meta.name)
      lowerNames.add(meta.name.toLowerCase())
    }
    this.knownNames = names
    this.knownLowerNames = lowerNames
    this.cachesWarmed = true
  }

  /**
   * Clear all internal caches.
   */
  clearCaches(): void {
    this.nameCache.clear()
    this.lowerNameCache.clear()
    this.qualifiedNameCache.clear()
    this.nodeCache.clear()
    this.knownNames = null
    this.knownLowerNames = null
    this.cachesWarmed = false
  }

  // ----------------------------------------------------------
  // Built-in detection
  // ----------------------------------------------------------

  private isBuiltInOrExternal(ref: LocalUnresolvedRef): boolean {
    const name = ref.referenceName
    const lang = ref.language
    const isJsTs = lang === 'typescript' || lang === 'javascript'
      || lang === 'tsx' || lang === 'jsx'

    // JavaScript/TypeScript built-ins
    if (isJsTs && JS_BUILT_INS.has(name)) return true
    if (isJsTs && (name.startsWith('console.') || name.startsWith('Math.') || name.startsWith('JSON.'))) return true
    if (isJsTs && REACT_HOOKS.has(name)) return true

    // Python built-ins
    if (lang === 'python' && PYTHON_BUILT_INS.has(name)) return true
    if (lang === 'python') {
      const dotIdx = name.indexOf('.')
      if (dotIdx > 0) {
        const receiver = name.substring(0, dotIdx)
        const method = name.substring(dotIdx + 1)
        if (PYTHON_BUILT_IN_TYPES.has(receiver)) return true
        if (PYTHON_BUILT_IN_METHODS.has(method)) {
          const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1)
          if (!this.knownNames?.has(capitalized)) return true
        }
      }
      if (PYTHON_BUILT_IN_METHODS.has(name) && !this.knownNames?.has(name)) return true
    }

    // Go stdlib
    if (lang === 'go') {
      const dotIdx = name.indexOf('.')
      if (dotIdx > 0) {
        const pkg = name.substring(0, dotIdx)
        if (GO_STDLIB_PACKAGES.has(pkg)) return true
      }
      if (GO_BUILT_INS.has(name)) return true
    }

    // Pascal built-ins
    if (lang === 'pascal') {
      if (PASCAL_UNIT_PREFIXES.some((p) => name.startsWith(p))) return true
      if (PASCAL_BUILT_INS.has(name)) return true
    }

    // C/C++ built-ins
    if (lang === 'c' || lang === 'cpp') {
      if (name.startsWith('std::')) return true
      if (C_BUILT_INS.has(name) || CPP_BUILT_INS.has(name)) {
        return !this.hasAnyPossibleMatch(name)
      }
    }

    return false
  }

  /**
   * Check if a reference name has any possible match in the codebase.
   * Uses the pre-built knownNames set for O(1) lookups.
   */
  private hasAnyPossibleMatch(name: string): boolean {
    if (!this.knownNames) return true

    if (this.knownNames.has(name)) return true

    // Check lowercase for fuzzy matching (e.g., 'processorder' → 'ProcessOrder')
    if (this.knownLowerNames?.has(name.toLowerCase())) return true

    // Check capitalized form (e.g., instance variable 'foo' → class 'Foo')
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1)
    if (this.knownNames.has(capitalized)) return true

    // For qualified names like "obj.method" or "Class::method"
    const dotIdx = name.indexOf('.')
    if (dotIdx > 0) {
      const receiver = name.substring(0, dotIdx)
      const member = name.substring(dotIdx + 1)
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true
      const capitalized = receiver.charAt(0).toUpperCase() + receiver.slice(1)
      if (this.knownNames.has(capitalized)) return true
      // JVM FQN: last segment
      const lastDot = name.lastIndexOf('.')
      if (lastDot > dotIdx) {
        const tail = name.substring(lastDot + 1)
        if (tail && this.knownNames.has(tail)) return true
      }
    }
    const colonIdx = name.indexOf('::')
    if (colonIdx > 0) {
      const receiver = name.substring(0, colonIdx)
      const member = name.substring(colonIdx + 2)
      if (this.knownNames.has(receiver) || this.knownNames.has(member)) return true
    }

    // Path-like references
    const slashIdx = name.lastIndexOf('/')
    if (slashIdx > 0) {
      const fileName = name.substring(slashIdx + 1)
      if (this.knownNames.has(fileName)) return true
    }

    return false
  }

  // ----------------------------------------------------------
  // Name matching strategies
  // ----------------------------------------------------------

  /**
   * Find the best matching node when there are multiple candidates.
   */
  private findBestMatch(
    ref: LocalUnresolvedRef,
    candidates: NodeMetadata[],
  ): NodeMetadata | null {
    let bestScore = -1
    let bestNode: NodeMetadata | null = null

    for (const candidate of candidates) {
      let score = 0

      // Same file bonus
      if (candidate.file === ref.filePath) score += 100

      // Directory proximity
      score += computePathProximity(ref.filePath, candidate.file)

      // Language matching
      if (candidate.language === ref.language) score += 50
      else score -= 80

      // For call references, prefer functions/methods
      if (ref.referenceKind === 'calls') {
        if (candidate.kind === 'function' || candidate.kind === 'method') score += 25
      }

      // For instantiation, prefer classes
      if (ref.referenceKind === 'instantiates') {
        if (candidate.kind === 'class' || candidate.kind === 'struct' || candidate.kind === 'interface') {
          score += 25
        }
      }

      // Exported bonus
      if (candidate.is_exported) score += 10

      // Closer line number (within same file)
      if (candidate.file === ref.filePath && candidate.line) {
        const distance = Math.abs(candidate.line - ref.line)
        score += Math.max(0, 20 - distance / 10)
      }

      if (score > bestScore) {
        bestScore = score
        bestNode = candidate
      }
    }

    return bestNode
  }

  /**
   * Try to resolve by exact name match.
   */
  private matchByExactName(ref: LocalUnresolvedRef): LocalResolvedRef | null {
    const candidates = this.context.getNodesByName(ref.referenceName)

    if (candidates.length === 0) return null

    if (candidates.length === 1) {
      const isCrossLanguage = candidates[0]!.language !== ref.language
      return {
        original: ref,
        targetNodeId: candidates[0]!.id,
        confidence: isCrossLanguage ? 0.5 : 0.9,
        resolvedBy: 'exact-match',
      }
    }

    // Multiple matches — find best
    const bestMatch = this.findBestMatch(ref, candidates)
    if (bestMatch) {
      const proximity = computePathProximity(ref.filePath, bestMatch.file)
      const confidence = proximity >= 30 ? 0.7 : 0.4
      return {
        original: ref,
        targetNodeId: bestMatch.id,
        confidence,
        resolvedBy: 'exact-match',
      }
    }

    return null
  }

  /**
   * Try to resolve by qualified name.
   */
  private matchByQualifiedName(ref: LocalUnresolvedRef): LocalResolvedRef | null {
    if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
      return null
    }

    const candidates = this.context.getNodesByQualifiedName(ref.referenceName)

    if (candidates.length === 1) {
      return {
        original: ref,
        targetNodeId: candidates[0]!.id,
        confidence: 0.95,
        resolvedBy: 'qualified-name',
      }
    }

    // Try partial qualified name match
    const parts = ref.referenceName.split(/[:.]/)
    const lastName = parts[parts.length - 1]
    if (lastName) {
      const partialCandidates = this.context.getNodesByName(lastName)
      for (const candidate of partialCandidates) {
        if (candidate.qualified_name?.endsWith(ref.referenceName)) {
          return {
            original: ref,
            targetNodeId: candidate.id,
            confidence: 0.85,
            resolvedBy: 'qualified-name',
          }
        }
      }
    }

    return null
  }

  /**
   * Try to resolve by method call pattern (obj.method or Class::method).
   */
  private matchMethodCall(ref: LocalUnresolvedRef): LocalResolvedRef | null {
    const dotMatch = ref.referenceName.match(/^(\w+)\.(\w+)$/)
    const colonMatch = ref.referenceName.match(/^(\w+)::(\w+)$/)

    const match = dotMatch || colonMatch
    if (!match) return null

    const [, objectOrClass, methodName] = match
    if (!objectOrClass || !methodName) return null

    // Strategy 1: Direct class name match
    const classCandidates = this.context.getNodesByName(objectOrClass)
    for (const classNode of classCandidates) {
      if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
        if (classNode.language !== ref.language) continue

        const nodesInFile = this.context.getNodesInFile(classNode.file)
        const methodNode = nodesInFile.find(
          (n) => n.kind === 'method' && n.name === methodName
            && n.qualified_name?.includes(classNode.name),
        )

        if (methodNode) {
          return {
            original: ref,
            targetNodeId: methodNode.id,
            confidence: 0.85,
            resolvedBy: 'qualified-name',
          }
        }
      }
    }

    // Strategy 2: Capitalized receiver (instance variable → class)
    const capitalizedReceiver = objectOrClass.charAt(0).toUpperCase() + objectOrClass.slice(1)
    if (capitalizedReceiver !== objectOrClass) {
      const fuzzyClassCandidates = this.context.getNodesByName(capitalizedReceiver)
      for (const classNode of fuzzyClassCandidates) {
        if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
          if (classNode.language !== ref.language) continue

          const nodesInFile = this.context.getNodesInFile(classNode.file)
          const methodNode = nodesInFile.find(
            (n) => n.kind === 'method' && n.name === methodName
              && n.qualified_name?.includes(classNode.name),
          )

          if (methodNode) {
            return {
              original: ref,
              targetNodeId: methodNode.id,
              confidence: 0.8,
              resolvedBy: 'instance-method',
            }
          }
        }
      }
    }

    // Strategy 3: Find methods by name, single match fallback
    const methodCandidates = this.context.getNodesByName(methodName)
    const methods = methodCandidates.filter(
      (n) => n.kind === 'method' && n.name === methodName,
    )
    const sameLanguageMethods = methods.filter(m => m.language === ref.language)
    const targetMethods = sameLanguageMethods.length > 0 ? sameLanguageMethods : methods

    if (targetMethods.length === 1 && targetMethods[0]!.language === ref.language) {
      return {
        original: ref,
        targetNodeId: targetMethods[0]!.id,
        confidence: 0.7,
        resolvedBy: 'instance-method',
      }
    }

    return null
  }

  /**
   * Fuzzy match — case-insensitive, last resort.
   */
  private matchFuzzy(ref: LocalUnresolvedRef): LocalResolvedRef | null {
    const lowerName = ref.referenceName.toLowerCase()
    const candidates = this.context.getNodesByLowerName(lowerName)

    // Filter to callable kinds only
    const callableKinds = new Set(['function', 'method', 'class'])
    const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind))

    // Prefer same-language matches
    const sameLanguageCandidates = callableCandidates.filter(n => n.language === ref.language)
    const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates

    if (finalCandidates.length === 1) {
      const isCrossLanguage = finalCandidates[0]!.language !== ref.language
      return {
        original: ref,
        targetNodeId: finalCandidates[0]!.id,
        confidence: isCrossLanguage ? 0.3 : 0.5,
        resolvedBy: 'fuzzy',
      }
    }

    return null
  }

  /**
   * Match all name-based strategies in order of confidence.
   */
  private matchReference(ref: LocalUnresolvedRef): LocalResolvedRef | null {
    let result: LocalResolvedRef | null

    // 1. Qualified name match (highest confidence)
    result = this.matchByQualifiedName(ref)
    if (result) return result

    // 2. Method call pattern
    result = this.matchMethodCall(ref)
    if (result) return result

    // 3. Exact name match
    result = this.matchByExactName(ref)
    if (result) return result

    // 4. Fuzzy match (lowest confidence)
    result = this.matchFuzzy(ref)
    if (result) return result

    return null
  }

  // ----------------------------------------------------------
  // Resolution pipeline
  // ----------------------------------------------------------

  /**
   * Resolve a single reference.
   */
  resolveOne(ref: LocalUnresolvedRef): LocalResolvedRef | null {
    // Ensure caches are warmed (needed for built-in guard and pre-filter)
    this.warmCaches()

    // Skip built-in/external references
    if (this.isBuiltInOrExternal(ref)) return null

    // Fast pre-filter: skip if no symbol with this name exists anywhere
    if (!this.hasAnyPossibleMatch(ref.referenceName)) return null

    // Try name matching strategies
    return this.matchReference(ref)
  }

  /**
   * Resolve a batch of references.
   */
  resolveBatch(
    refs: LocalUnresolvedRef[],
    onProgress?: (current: number, total: number) => void,
  ): ResolutionResult {
    this.warmCaches()

    const resolved: LocalResolvedRef[] = []
    const unresolved: LocalUnresolvedRef[] = []
    const byMethod: Record<string, number> = {}

    const total = refs.length
    let lastReportedPercent = -1

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!
      const result = this.resolveOne(ref)

      if (result) {
        resolved.push(result)
        byMethod[result.resolvedBy] = (byMethod[result.resolvedBy] || 0) + 1
      } else {
        unresolved.push(ref)
      }

      // Report progress every 1%
      if (onProgress) {
        const currentPercent = Math.floor((i / total) * 100)
        if (currentPercent > lastReportedPercent) {
          lastReportedPercent = currentPercent
          onProgress(i + 1, total)
        }
      }
    }

    // Final progress report
    if (onProgress && total > 0) {
      onProgress(total, total)
    }

    return {
      resolved,
      unresolved,
      stats: {
        total: refs.length,
        resolved: resolved.length,
        unresolved: unresolved.length,
        byMethod,
      },
    }
  }

  /**
   * Create edges from resolved references.
   */
  createEdges(resolved: LocalResolvedRef[]): Array<{
    source: string
    target: string
    kind: EdgeType
    line?: number
    column?: number
    metadata: Record<string, unknown>
  }> {
    return resolved.map((ref) => {
      let kind: EdgeType = ref.original.referenceKind as EdgeType

      // Promote "extends" to "implements" when target is an interface
      if (kind === 'extends') {
        const targetNode = this.adapter.getNodeById(ref.targetNodeId)
        if (targetNode && (targetNode.kind === 'interface' || targetNode.kind === 'protocol')) {
          const sourceNode = this.adapter.getNodeById(ref.original.fromNodeId)
          if (sourceNode && sourceNode.kind !== 'interface' && sourceNode.kind !== 'protocol') {
            kind = 'implements'
          }
        }
      }

      // Promote "calls" to "instantiates" when target is a class/struct
      if (kind === 'calls') {
        const targetNode = this.adapter.getNodeById(ref.targetNodeId)
        if (targetNode && (targetNode.kind === 'class' || targetNode.kind === 'struct')) {
          kind = 'instantiates'
        }
      }

      return {
        source: ref.original.fromNodeId,
        target: ref.targetNodeId,
        kind,
        line: ref.original.line,
        column: ref.original.column,
        metadata: {
          confidence: ref.confidence,
          resolvedBy: ref.resolvedBy,
        },
      }
    })
  }
}

// ============================================================
// Factory function
// ============================================================

/**
 * Create a reference resolver instance.
 */
export function createResolver(projectRoot: string, adapter: GraphStoreAdapter): ReferenceResolver {
  return new ReferenceResolver(projectRoot, adapter)
}
