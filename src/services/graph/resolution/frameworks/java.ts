/**
 * Java Framework Resolver
 *
 * Handles Spring Boot and general Java patterns.
 * Migrated from codegraph/src/resolution/frameworks/java.ts.
 *
 * Source mapping:
 *  codegraph Node      → NodeMetadata (from GraphStore)
 *  n.filePath          → n.file
 *  n.startLine         → n.line
 *  n.endLine           → n.end_line
 *  n.qualifiedName     → n.qualified_name
 *  n.updatedAt         → n.updated_at
 *  n.startColumn       → n.start_column
 *  n.endColumn         → n.end_column
 */

import type { NodeMetadata } from '../../GraphStore.js'
import type {
  FrameworkResolver,
  FrameworkExtractionResult,
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types.js'
import { stripCommentsForRegex } from '../strip-comments.js'

export const javaResolver: FrameworkResolver = {
  name: 'spring',
  languages: ['java', 'kotlin', 'yaml', 'properties'],

  claimsReference(name: string): boolean {
    return name.endsWith(':prefix')
  },

  detect(context: ResolutionContext): boolean {
    const pomXml = context.readFile('pom.xml')
    if (pomXml && (pomXml.includes('spring-boot') || pomXml.includes('springframework'))) {
      return true
    }

    const buildGradle = context.readFile('build.gradle')
    if (buildGradle && (buildGradle.includes('spring-boot') || buildGradle.includes('springframework'))) {
      return true
    }

    const buildGradleKts = context.readFile('build.gradle.kts')
    if (buildGradleKts && (buildGradleKts.includes('spring-boot') || buildGradleKts.includes('springframework'))) {
      return true
    }

    const allFiles = context.getAllFiles()
    for (const file of allFiles) {
      if (file.endsWith('.java')) {
        const content = context.readFile(file)
        if (content && (
          content.includes('@SpringBootApplication') ||
          content.includes('@RestController') ||
          content.includes('@Service') ||
          content.includes('@Repository')
        )) {
          return true
        }
      }
    }

    return false
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Spring config-key references
    if (ref.referenceName.endsWith(':prefix')) {
      const prefix = ref.referenceName.slice(0, -':prefix'.length)
      const canonPrefix = canonicalConfigKey(prefix)
      const candidates = context.getNodesByKind('constant').filter(
        (n) => (n.language === 'yaml' || n.language === 'properties')
          && canonicalConfigKey(n.qualified_name ?? '').startsWith(canonPrefix),
      )
      if (candidates.length === 0) return null
      const best = candidates.reduce((a, b) =>
        canonicalConfigKey(a.qualified_name ?? '').length <= canonicalConfigKey(b.qualified_name ?? '').length ? a : b,
      )
      return { original: ref, targetNodeId: best.id, confidence: 0.85, resolvedBy: 'framework' }
    }
    if (
      (ref.language === 'java' || ref.language === 'kotlin') &&
      ref.referenceName.includes('.') &&
      !ref.referenceName.includes('::') &&
      ref.referenceName.split('.').length >= 2
    ) {
      const canonRef = canonicalConfigKey(ref.referenceName)
      const candidates = context.getNodesByKind('constant').filter(
        (n) => n.kind === 'constant'
          && (n.language === 'yaml' || n.language === 'properties')
          && canonicalConfigKey(n.qualified_name ?? '') === canonRef,
      )
      if (candidates.length === 1) {
        return { original: ref, targetNodeId: candidates[0]!.id, confidence: 0.9, resolvedBy: 'framework' }
      }
      if (candidates.length > 1) {
        const score = (n: NodeMetadata) => {
          const base = n.file.split('/').pop() ?? ''
          const isBase = /^(application|bootstrap)\.(yml|yaml|properties)$/i.test(base)
          return (isBase ? 0 : 1) * 1000 + base.length
        }
        const best = candidates.reduce((a, b) => (score(a) <= score(b) ? a : b))
        return { original: ref, targetNodeId: best.id, confidence: 0.75, resolvedBy: 'framework' }
      }
    }

    // Pattern 1: Service references
    if (ref.referenceName.endsWith('Service')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, SERVICE_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' }
      }
    }

    // Pattern 2: Repository references
    if (ref.referenceName.endsWith('Repository')) {
      const result = resolveByNameAndKind(ref.referenceName, SERVICE_KINDS, REPO_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' }
      }
    }

    // Pattern 3: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, CONTROLLER_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' }
      }
    }

    // Pattern 4: Entity/Model references
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, ENTITY_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.7, resolvedBy: 'framework' }
      }
    }

    // Pattern 5: Component references
    if (ref.referenceName.endsWith('Component') || ref.referenceName.endsWith('Config')) {
      const result = resolveByNameAndKind(ref.referenceName, CLASS_KINDS, COMPONENT_DIRS, context)
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' }
      }
    }

    return null
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    if (isSpringConfigFile(filePath)) {
      return extractSpringConfig(filePath, content)
    }
    if (!filePath.endsWith('.java') && !filePath.endsWith('.kt')) return { nodes: [], references: [] }
    const nodes: NodeMetadata[] = []
    const references: UnresolvedRef[] = []
    const now = Date.now()
    const lang: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java'
    const safe = stripCommentsForRegex(content, 'java')

    let classPrefix = ''
    const cls = /@RequestMapping\s*\(([^)]*)\)\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.exec(safe)
    if (cls) classPrefix = parseMappingPath(cls[1]!)

    const VERB: Record<string, string> = {
      GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', PatchMapping: 'PATCH', DeleteMapping: 'DELETE',
    }
    const mappingRegex = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b\s*(\([^)]*\))?/g
    let match: RegExpExecArray | null
    while ((match = mappingRegex.exec(safe)) !== null) {
      const method = VERB[match[1]!]!
      const sub = parseMappingPath((match[2] || '').replace(/^\(|\)$/g, ''))
      const routePath = joinPath(classPrefix, sub)
      const line = safe.slice(0, match.index).split('\n').length
      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualified_name: `${filePath}::route:${routePath}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: lang,
        updated_at: now,
      }
      nodes.push(routeNode)

      const tail = safe.slice(match.index + match[0].length, match.index + match[0].length + 600)
      const methodMatch = tail.match(/\bfun\s+(\w+)\s*\(|\b(?:public|private|protected)\s+[^;{=]*?\s+(\w+)\s*\(/)
      if (methodMatch) {
        references.push({
          fromNodeId: routeNode.id,
          referenceName: (methodMatch[1] ?? methodMatch[2])!,
          referenceKind: 'references',
          line,
          column: 0,
          filePath,
          language: lang,
        })
      }
    }

    const reqRe = /@RequestMapping\b\s*(\([^)]*\))?/g
    while ((match = reqRe.exec(safe)) !== null) {
      const args = (match[1] || '').replace(/^\(|\)$/g, '')
      const after = safe.slice(match.index + match[0].length, match.index + match[0].length + 600)
      if (/^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:public\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+)*class\b/.test(after)) continue
      const methodMatch = after.match(/\bfun\s+(\w+)\s*\(|\b(?:public|private|protected)\s+[^;{=]*?\s+(\w+)\s*\(/)
      if (!methodMatch) continue
      const verbM = args.match(/method\s*=\s*(?:RequestMethod\.)?(\w+)/)
      const method = verbM ? verbM[1]!.toUpperCase() : 'ANY'
      const routePath = joinPath(classPrefix, parseMappingPath(args))
      const line = safe.slice(0, match.index).split('\n').length
      const routeNode: NodeMetadata = {
        id: `route:${filePath}:${line}:${method}:${routePath}`,
        kind: 'route',
        name: `${method} ${routePath}`,
        qualified_name: `${filePath}::route:${routePath}`,
        file: filePath,
        line,
        end_line: line,
        start_column: 0,
        end_column: match[0].length,
        language: lang,
        updated_at: now,
      }
      nodes.push(routeNode)
      references.push({
        fromNodeId: routeNode.id,
        referenceName: (methodMatch[1] ?? methodMatch[2])!,
        referenceKind: 'references',
        line, column: 0, filePath, language: lang,
      })
    }

    extractSpringValueBindings(filePath, safe, lang, now, nodes, references)

    return { nodes, references }
  },
}

function isSpringConfigFile(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? ''
  return /^(application|bootstrap)(-[\w.-]+)?\.(yml|yaml|properties)$/i.test(base)
}

function extractSpringConfig(
  filePath: string,
  content: string,
): FrameworkExtractionResult {
  const nodes: NodeMetadata[] = []
  const isProperties = /\.properties$/i.test(filePath)
  const lang = isProperties ? 'properties' : 'yaml'
  const now = Date.now()

  const emitLeaf = (dottedKey: string, line: number, valueText: string) => {
    if (!dottedKey) return
    nodes.push({
      id: `spring-config:${filePath}:${line}:${dottedKey}`,
      kind: 'constant',
      name: dottedKey.split('.').pop() ?? dottedKey,
      qualified_name: dottedKey,
      file: filePath,
      line,
      end_line: line,
      start_column: 0,
      end_column: valueText.length,
      language: lang,
      signature: dottedKey,
      docstring: valueText.slice(0, 200),
      updated_at: now,
    })
  }

  if (isProperties) {
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? ''
      const trimmed = raw.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue
      const sep = (() => {
        for (let j = 0; j < raw.length; j++) {
          const ch = raw[j]
          if (ch === '=' || ch === ':') return j
          if (ch === '\\' && raw[j + 1]) { j++; continue }
        }
        return -1
      })()
      if (sep < 0) continue
      const key = raw.slice(0, sep).trim()
      const val = raw.slice(sep + 1).trim()
      emitLeaf(key, i + 1, val)
    }
    return { nodes, references: [] }
  }

  const stack: Array<{ indent: number; key: string }> = []
  const yamlLines = content.split(/\r?\n/)
  for (let i = 0; i < yamlLines.length; i++) {
    const raw = yamlLines[i] ?? ''
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed.startsWith('- ')) continue
    const indent = raw.length - raw.replace(/^[\t ]+/, '').length
    const colonIdx = (() => {
      let inStr: string | null = null
      for (let j = 0; j < raw.length; j++) {
        const ch = raw[j]
        if (inStr) { if (ch === inStr && raw[j - 1] !== '\\') inStr = null; continue }
        if (ch === '"' || ch === "'") { inStr = ch; continue }
        if (ch === ':') return j
      }
      return -1
    })()
    if (colonIdx < 0) continue
    const key = raw.slice(indent, colonIdx).trim()
    if (!key) continue
    const after = raw.slice(colonIdx + 1).trim()
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
    const dotted = [...stack.map((s) => s.key), key].join('.')
    if (after === '' || after.startsWith('#')) {
      stack.push({ indent, key })
    } else {
      const valStripped = after.replace(/^["']|["']$/g, '')
      emitLeaf(dotted, i + 1, valStripped)
    }
  }
  return { nodes, references: [] }
}

function extractSpringValueBindings(
  filePath: string,
  safe: string,
  lang: 'java' | 'kotlin',
  now: number,
  nodes: NodeMetadata[],
  references: UnresolvedRef[],
): void {
  const valueRe = /@Value\s*\(\s*["']\$\{([^}:]+)(?::[^}]*)?\}["']\s*\)/g
  let m: RegExpExecArray | null
  while ((m = valueRe.exec(safe)) !== null) {
    const key = m[1]!.trim()
    if (!key) continue
    const line = safe.slice(0, m.index).split('\n').length
    const bindNode: NodeMetadata = {
      id: `spring-value:${filePath}:${line}:${key}`,
      kind: 'constant',
      name: key,
      qualified_name: `${filePath}::@Value:${key}`,
      file: filePath,
      line,
      end_line: line,
      start_column: 0,
      end_column: m[0].length,
      language: lang,
      signature: `@Value("${key}")`,
      updated_at: now,
    }
    nodes.push(bindNode)
    references.push({
      fromNodeId: bindNode.id,
      referenceName: key,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: lang,
    })
  }

  const cpRe = /@ConfigurationProperties\s*\(\s*(?:prefix\s*=\s*)?["']([^"']+)["']/g
  while ((m = cpRe.exec(safe)) !== null) {
    const prefix = m[1]!.trim()
    if (!prefix) continue
    const line = safe.slice(0, m.index).split('\n').length
    const bindNode: NodeMetadata = {
      id: `spring-cp:${filePath}:${line}:${prefix}`,
      kind: 'constant',
      name: prefix,
      qualified_name: `${filePath}::@ConfigurationProperties:${prefix}`,
      file: filePath,
      line,
      end_line: line,
      start_column: 0,
      end_column: m[0].length,
      language: lang,
      signature: `@ConfigurationProperties("${prefix}")`,
      updated_at: now,
    }
    nodes.push(bindNode)
    references.push({
      fromNodeId: bindNode.id,
      referenceName: `${prefix}:prefix`,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: lang,
    })
  }
}

function canonicalConfigKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '')
}

const SERVICE_DIRS = ['/service/', '/services/']
const REPO_DIRS = ['/repository/', '/repositories/']
const CONTROLLER_DIRS = ['/controller/', '/controllers/']
const ENTITY_DIRS = ['/entity/', '/entities/', '/model/', '/models/', '/domain/']
const COMPONENT_DIRS = ['/component/', '/components/', '/config/']

const CLASS_KINDS = new Set(['class'])
const SERVICE_KINDS = new Set(['class', 'interface'])

function parseMappingPath(args: string): string {
  const m = args.match(/["']([^"']*)["']/)
  return m ? m[1]! : ''
}

function joinPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean)
  return '/' + parts.join('/')
}

function resolveByNameAndKind(
  name: string,
  kinds: Set<string>,
  preferredDirPatterns: string[],
  context: ResolutionContext,
): string | null {
  const candidates = context.getNodesByName(name)
  if (candidates.length === 0) return null

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind))
  if (kindFiltered.length === 0) return null

  const preferred = kindFiltered.filter((n) =>
    preferredDirPatterns.some((d) => n.file.includes(d))
  )

  if (preferred.length > 0) return preferred[0]!.id
  return kindFiltered[0]!.id
}
