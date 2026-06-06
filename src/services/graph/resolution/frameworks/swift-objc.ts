/**
 * Swift <-> Objective-C bridge resolver.
 *
 * Closes the cross-language flow gap in mixed iOS codebases.
 * Migrated from codegraph/src/resolution/frameworks/swift-objc.ts.
 *
 * Two directions to close:
 * 1. Swift call -> ObjC method
 * 2. ObjC call -> Swift method
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
  UnresolvedRef,
  ResolvedRef,
  ResolutionContext,
} from '../types.js'
import {
  swiftBaseNamesForObjcSelector,
  isObjcExposed,
} from '../swift-objc-bridge.js'

/**
 * Memoized "Swift base name -> ObjC method nodes" map.
 * Built lazily on first resolve() per resolver instance.
 */
const objcByCandidateSwiftBase: WeakMap<
  ResolutionContext,
  Map<string, NodeMetadata[]>
> = new WeakMap()

/**
 * Names that are too generic to bridge with any precision.
 */
const GENERIC_NAMES = new Set([
  'init', 'description', 'debugDescription', 'hash', 'isEqual', 'isEqualTo',
  'copy', 'mutableCopy', 'class', 'self', 'count', 'length', 'value',
  'name', 'data', 'string', 'object', 'add', 'remove', 'update',
  'load', 'save', 'reload', 'cancel', 'start', 'stop', 'pause',
  'resume', 'close', 'open', 'show', 'hide', 'toString',
  'dealloc', 'release', 'retain', 'autorelease',
])

function buildObjcMap(context: ResolutionContext): Map<string, NodeMetadata[]> {
  const cached = objcByCandidateSwiftBase.get(context)
  if (cached) return cached

  const map = new Map<string, NodeMetadata[]>()
  const objcMethods = context
    .getNodesByKind('method')
    .filter((n) => n.language === 'objc')
  for (const node of objcMethods) {
    const candidates = swiftBaseNamesForObjcSelector(node.name)
    for (const c of candidates) {
      if (c === node.name && !node.name.includes(':')) continue
      if (GENERIC_NAMES.has(c)) continue
      const arr = map.get(c)
      if (arr) arr.push(node)
      else map.set(c, [node])
    }
  }
  objcByCandidateSwiftBase.set(context, map)
  return map
}

const SOURCE_PROBE_LINES = 3

function declarationSourceWindow(node: NodeMetadata, context: ResolutionContext): string {
  const content = context.readFile(node.file)
  if (!content) return ''
  const lines = content.split(/\r?\n/)
  const startIdx = Math.max(0, node.line - 1 - SOURCE_PROBE_LINES)
  const endIdx = Math.min(lines.length, node.line)
  return lines.slice(startIdx, endIdx).join('\n')
}

function resolveSwiftCallToObjc(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const rawName = ref.referenceName.includes('.')
    ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
    : ref.referenceName

  const map = buildObjcMap(context)
  const candidates = map.get(rawName)
  if (!candidates || candidates.length === 0) return null

  const target = candidates[0]
  if (!target) return null
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.6,
    resolvedBy: 'framework',
  }
}

function resolveObjcCallToSwift(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const rawSelector = ref.referenceName.includes('.')
    ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
    : ref.referenceName

  if (!rawSelector.includes(':')) return null

  const candidates = swiftBaseNamesForObjcSelector(rawSelector)
  for (const candidate of candidates) {
    const matches = context
      .getNodesByName(candidate)
      .filter((n) => n.language === 'swift' && (n.kind === 'method' || n.kind === 'function'))
    for (const match of matches) {
      const window = declarationSourceWindow(match, context)
      if (isObjcExposed(window)) {
        return {
          original: ref,
          targetNodeId: match.id,
          confidence: 0.6,
          resolvedBy: 'framework',
        }
      }
    }
  }
  return null
}

export const swiftObjcBridgeResolver: FrameworkResolver = {
  name: 'swift-objc-bridge',
  languages: ['swift', 'objc'],

  detect(context: ResolutionContext): boolean {
    const files = context.getAllFiles()
    let hasSwift = false
    let hasObjc = false
    for (const f of files) {
      if (f.endsWith('.swift')) hasSwift = true
      else if (f.endsWith('.m') || f.endsWith('.mm')) hasObjc = true
      if (hasSwift && hasObjc) return true
    }
    return false
  },

  claimsReference(name: string): boolean {
    if (name.includes(':')) return true
    return false
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language === 'swift') {
      return resolveSwiftCallToObjc(ref, context)
    }
    if (ref.language === 'objc') {
      return resolveObjcCallToSwift(ref, context)
    }
    return null
  },
}
