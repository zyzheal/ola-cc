/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution.
 * Migrated from codegraph/src/resolution/name-matcher.ts — adapted to use
 * NodeMetadata from our GraphStore (file, line, end_line, qualified_name,
 * is_exported, language).
 */

import type { NodeMetadata } from '../GraphStore.js'
import type { UnresolvedRef, ResolvedRef, ResolutionContext } from './types.js'

/**
 * Try to resolve a path-like reference (e.g., "snippets/drawer-menu.liquid")
 * by matching the filename against file nodes.
 */
export function matchByFilePath(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (!ref.referenceName.includes('/')) return null

  const fileName = ref.referenceName.split('/').pop()
  if (!fileName) return null

  const candidates = context.getNodesByName(fileName)
  const fileNodes = candidates.filter(n => n.kind === 'file')

  if (fileNodes.length === 0) return null

  // Prefer exact path match on qualified_name
  const exactMatch = fileNodes.find(n => n.qualified_name === ref.referenceName || n.file === ref.referenceName)
  if (exactMatch) {
    return {
      original: ref,
      targetNodeId: exactMatch.id,
      confidence: 0.95,
      resolvedBy: 'file-path',
    }
  }

  // Fall back to suffix match
  const suffixMatch = fileNodes.find(n => n.qualified_name?.endsWith(ref.referenceName) || n.file.endsWith(ref.referenceName))
  if (suffixMatch) {
    return {
      original: ref,
      targetNodeId: suffixMatch.id,
      confidence: 0.85,
      resolvedBy: 'file-path',
    }
  }

  // If only one file node with this name, use it with lower confidence
  if (fileNodes.length === 1) {
    return {
      original: ref,
      targetNodeId: fileNodes[0]!.id,
      confidence: 0.7,
      resolvedBy: 'file-path',
    }
  }

  return null
}

/**
 * Try to resolve a reference by exact name match
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const candidates = context.getNodesByName(ref.referenceName)

  if (candidates.length === 0) {
    return null
  }

  // If only one match, use it — but penalize cross-language matches
  if (candidates.length === 1) {
    const isCrossLanguage = candidates[0]!.language !== ref.language
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? 0.5 : 0.9,
      resolvedBy: 'exact-match',
    }
  }

  // Multiple matches - try to narrow down
  const bestMatch = findBestMatch(ref, candidates, context)
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
 * Try to resolve by qualified name
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null
  }

  const candidates = context.getNodesByQualifiedName(ref.referenceName)

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
    const partialCandidates = context.getNodesByName(lastName)
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

function resolveMethodOnType(
  typeName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  confidence: number,
  resolvedBy: ResolvedRef['resolvedBy'],
  preferredFqn?: string,
): ResolvedRef | null {
  const methodCandidates = context.getNodesByName(methodName)
  const want = `${typeName}::${methodName}`
  const matches: NodeMetadata[] = []
  for (const m of methodCandidates) {
    if (m.kind !== 'method') continue
    if (m.language !== ref.language) continue
    const qn = m.qualified_name
    if (qn === want || qn?.endsWith(`::${want}`)) {
      matches.push(m)
    }
  }
  if (matches.length === 0) return null

  if (matches.length > 1 && preferredFqn) {
    const ext = ref.language === 'kotlin' ? '.kt' : '.java'
    const fqnPath = preferredFqn.replace(/\./g, '/') + ext
    const chosen = matches.find((m) => {
      const fp = m.file.replace(/\\/g, '/')
      return fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath)
    })
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence,
        resolvedBy,
      }
    }
  }

  return {
    original: ref,
    targetNodeId: matches[0]!.id,
    confidence,
    resolvedBy,
  }
}

// C++ keywords/control-flow tokens
const CPP_NON_TYPE_TOKENS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto', 'throw', 'new', 'delete', 'co_await', 'co_yield',
  'co_return', 'static_cast', 'const_cast', 'dynamic_cast', 'reinterpret_cast',
  'sizeof', 'alignof', 'typeid', 'and', 'or', 'not', 'xor',
])

function normalizeCppTypeName(typeName: string): string | null {
  const normalized = typeName
    .replace(/\b(const|volatile|mutable|typename|class|struct)\b/g, ' ')
    .replace(/[&*]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return null
  const parts = normalized.split(/::/).filter(Boolean)
  const last = parts[parts.length - 1]
  if (!last) return null
  if (CPP_NON_TYPE_TOKENS.has(last)) return null
  return last
}

function buildDeclaratorRegex(escapedReceiver: string): RegExp {
  return new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s*\\b${escapedReceiver}\\b\\s*(?=[;=,)\\[{(]|$)`,
  )
}

function inferCppReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const source = context.readFile(ref.filePath)
  if (!source) return null

  const lines = source.split(/\r?\n/)
  const callLineIndex = Math.max(0, Math.min(lines.length - 1, ref.line - 1))
  const escapedReceiver = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const receiverPattern = new RegExp(`\\b${escapedReceiver}\\b`)
  const declaratorRegex = buildDeclaratorRegex(escapedReceiver)

  for (let i = callLineIndex; i >= 0; i--) {
    const line = lines[i]
    if (!line || !receiverPattern.test(line)) continue

    const declaratorMatch = line.match(declaratorRegex)
    if (declaratorMatch) {
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '')
      if (normalized) return normalized
    }
  }

  const headerCandidates = [
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.h'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hpp'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hxx'),
  ].filter((candidate, index, arr) => arr.indexOf(candidate) === index && candidate !== ref.filePath)

  for (const headerPath of headerCandidates) {
    if (!context.fileExists(headerPath)) continue
    const headerSource = context.readFile(headerPath)
    if (!headerSource) continue

    for (const line of headerSource.split(/\r?\n/)) {
      if (!receiverPattern.test(line)) continue
      const declaratorMatch = line.match(declaratorRegex)
      if (!declaratorMatch) continue
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '')
      if (normalized) return normalized
    }
  }

  return null
}

/**
 * Java/Kotlin: infer a receiver's declared type by walking field declarations
 * in the class enclosing the call site.
 */
function inferJavaFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const inFile = context.getNodesInFile(ref.filePath)
  if (inFile.length === 0) return null

  let enclosing: NodeMetadata | null = null
  for (const n of inFile) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue
    if (n.language !== ref.language) continue
    const end = n.end_line ?? n.line
    if (n.line <= ref.line && end >= ref.line) {
      if (!enclosing || n.line >= enclosing.line) enclosing = n
    }
  }
  if (!enclosing) return null

  const enclosingEnd = enclosing.end_line ?? enclosing.line
  const field = inFile.find(
    (n) =>
      n.kind === 'field' &&
      n.name === receiverName &&
      n.language === ref.language &&
      n.line >= enclosing.line &&
      (n.end_line ?? n.line) <= enclosingEnd,
  )
  if (!field || !field.signature) return null

  const beforeName = field.signature.slice(
    0,
    field.signature.lastIndexOf(field.name),
  )
  const typeRaw = beforeName.trim()
  if (!typeRaw) return null

  const typeNoGenerics = typeRaw.replace(/<[^>]*>/g, '').trim()
  const typeNoArray = typeNoGenerics.replace(/\[\s*\]/g, '').replace(/\.\.\.$/, '').trim()
  const parts = typeNoArray.split(/[.\s]+/).filter(Boolean)
  const lastPart = parts[parts.length - 1]
  if (!lastPart) return null
  if (!/^[A-Z]/.test(lastPart)) return null
  return lastPart
}

/**
 * Try to resolve by method name on a class/object
 */
export function matchMethodCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const dotMatch = ref.referenceName.match(/^(\w+)\.(\w+)$/)
  const colonMatch = ref.referenceName.match(/^(\w+)::(\w+)$/)

  const match = dotMatch || colonMatch
  if (!match) {
    return null
  }

  const [, objectOrClass, methodName] = match

  if (ref.language === 'cpp' && dotMatch) {
    const inferredType = inferCppReceiverType(objectOrClass!, ref, context)
    if (inferredType) {
      const typedMatch = resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
      )
      if (typedMatch) {
        return typedMatch
      }
    }
  }

  // Java/Kotlin: receiver may be a field whose name doesn't match the type
  if ((ref.language === 'java' || ref.language === 'kotlin') && dotMatch) {
    const inferredType = inferJavaFieldReceiverType(objectOrClass!, ref, context)
    if (inferredType) {
      const imports = context.getImportMappings(ref.filePath, ref.language)
      const importedFqn = imports.find((i) => i.localName === inferredType)?.source
      const typedMatch = resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      )
      if (typedMatch) {
        return typedMatch
      }
    }
  }

  // Strategy 1: Direct class name match
  const classCandidates = context.getNodesByName(objectOrClass!)

  for (const classNode of classCandidates) {
    if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
      if (classNode.language !== ref.language) continue

      const nodesInFile = context.getNodesInFile(classNode.file)
      const methodNode = nodesInFile.find(
        (n) =>
          n.kind === 'method' &&
          n.name === methodName &&
          n.qualified_name?.includes(classNode.name)
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

  // Strategy 2: Instance variable receiver - try capitalized form
  const capitalizedReceiver = objectOrClass!.charAt(0).toUpperCase() + objectOrClass!.slice(1)
  if (capitalizedReceiver !== objectOrClass) {
    const fuzzyClassCandidates = context.getNodesByName(capitalizedReceiver)
    for (const classNode of fuzzyClassCandidates) {
      if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
        if (classNode.language !== ref.language) continue

        const nodesInFile = context.getNodesInFile(classNode.file)
        const methodNode = nodesInFile.find(
          (n) =>
            n.kind === 'method' &&
            n.name === methodName &&
            n.qualified_name?.includes(classNode.name)
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

  // Strategy 3: Find methods by name across the codebase
  if (methodName) {
    const methodCandidates = context.getNodesByName(methodName!)
    const methods = methodCandidates.filter(
      (n) => n.kind === 'method' && n.name === methodName
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

    // Multiple methods: score by receiver name word overlap with class name
    if (targetMethods.length > 1) {
      const receiverWords = splitCamelCase(objectOrClass!)
      let bestMatch: typeof targetMethods[0] | undefined
      let bestScore = 0

      for (const method of targetMethods) {
        const classWords = splitCamelCase(method.qualified_name ?? '')
        let score = receiverWords.filter(w =>
          classWords.some(cw => cw.toLowerCase() === w.toLowerCase())
        ).length
        if (method.language === ref.language) score += 1
        if (score > bestScore) {
          bestScore = score
          bestMatch = method
        }
      }

      if (bestMatch && bestScore >= 2) {
        return {
          original: ref,
          targetNodeId: bestMatch.id,
          confidence: 0.65,
          resolvedBy: 'instance-method',
        }
      }
    }
  }

  return null
}

/**
 * Split a camelCase or PascalCase string into words.
 */
function splitCamelCase(str: string): string[] {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:\/\\]+/)
    .filter(w => w.length > 1)
}

/**
 * Compute directory proximity between two file paths.
 */
function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/').slice(0, -1)
  const dir2 = filePath2.split('/').slice(0, -1)

  let shared = 0
  for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
    if (dir1[i] === dir2[i]) {
      shared++
    } else {
      break
    }
  }

  return Math.min(shared * 15, 80)
}

/**
 * Find the best matching node when there are multiple candidates
 */
function findBestMatch(
  ref: UnresolvedRef,
  candidates: NodeMetadata[],
  _context: ResolutionContext
): NodeMetadata | null {
  let bestScore = -1
  let bestNode: NodeMetadata | null = null

  for (const candidate of candidates) {
    let score = 0

    // Same file bonus
    if (candidate.file === ref.filePath) {
      score += 100
    }

    // Directory proximity bonus
    score += computePathProximity(ref.filePath, candidate.file)

    // Language matching
    if (candidate.language === ref.language) {
      score += 50
    } else {
      score -= 80
    }

    // For call references, prefer functions/methods
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25
      }
    }

    // For instantiation references
    if (ref.referenceKind === 'instantiates') {
      if (
        candidate.kind === 'class' ||
        candidate.kind === 'struct' ||
        candidate.kind === 'interface'
      ) {
        score += 25
      }
    }

    // For decorator references
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15
      }
    }

    // Exported bonus
    if (candidate.is_exported) {
      score += 10
    }

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
 * Fuzzy match - last resort with lower confidence
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase()

  const candidates = context.getNodesByLowerName(lowerName)

  const callableKinds = new Set(['function', 'method', 'class'])
  const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind))

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
 * Match all strategies in order of confidence
 */
export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  let result: ResolvedRef | null

  // 0. File path match
  result = matchByFilePath(ref, context)
  if (result) return result

  // 1. Qualified name match (highest confidence)
  result = matchByQualifiedName(ref, context)
  if (result) return result

  // 2. Method call pattern
  result = matchMethodCall(ref, context)
  if (result) return result

  // 3. Exact name match
  result = matchByExactName(ref, context)
  if (result) return result

  // 4. Fuzzy match (lowest confidence)
  result = matchFuzzy(ref, context)
  if (result) return result

  return null
}
