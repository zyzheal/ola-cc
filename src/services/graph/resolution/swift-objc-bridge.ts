/**
 * Swift <-> Objective-C bridging rules.
 *
 * Apple's auto-bridging mechanism exposes Swift declarations to the ObjC
 * runtime under a deterministic selector name.
 *
 * This module is **pure name math** — no graph/DB access.
 * Migrated from codegraph/src/resolution/swift-objc-bridge.ts.
 */

function capFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s
}

/**
 * Compute the auto-bridged ObjC selector for a Swift method declaration.
 */
export function objcSelectorForSwiftMethod(
  baseName: string,
  externalLabels: (string | null)[],
  explicitObjcName?: string | null
): string | null {
  if (!baseName) return null
  if (explicitObjcName) return explicitObjcName

  if (externalLabels.length === 0) {
    return baseName
  }

  const [first, ...rest] = externalLabels
  const firstKeyword =
    first === null || first === undefined || first === '_' || first === ''
      ? `${baseName}:`
      : `${baseName}With${capFirst(first)}:`

  const restKeywords = rest.map((l) => `${l ?? ''}:`).join('')
  return firstKeyword + restKeywords
}

/**
 * Compute the bridged ObjC selector for a Swift `init(...)` declaration.
 */
export function objcSelectorForSwiftInit(
  externalLabels: (string | null)[],
  internalNames: string[],
  explicitObjcName?: string | null
): string | null {
  if (explicitObjcName) return explicitObjcName

  if (externalLabels.length === 0) {
    return 'init'
  }

  const [firstExt, ...restExt] = externalLabels
  const [firstInt] = internalNames
  const firstLabel =
    firstExt === null || firstExt === '_' || firstExt === ''
      ? firstInt
      : firstExt
  if (!firstLabel) return null

  const firstKeyword = `initWith${capFirst(firstLabel)}:`
  const restKeywords = restExt
    .map((label, idx) => {
      const internal = internalNames[idx + 1]
      const name = label && label !== '_' ? label : internal ?? ''
      return `${name}:`
    })
    .join('')
  return firstKeyword + restKeywords
}

/**
 * Compute the bridged ObjC getter + setter for a Swift `@objc` property.
 */
export function objcAccessorsForSwiftProperty(
  swiftName: string,
  explicitObjcName?: string | null
): { getter: string; setter: string } | null {
  if (!swiftName) return null
  const getter = explicitObjcName ?? swiftName
  return {
    getter,
    setter: `set${capFirst(getter)}:`,
  }
}

/**
 * Reverse: from an ObjC selector, return the candidate Swift base names
 * the resolver should try when looking for the bridged Swift declaration.
 */
export function swiftBaseNamesForObjcSelector(selector: string): string[] {
  if (!selector) return []

  const keywords = selector.replace(/:+$/g, '').split(':')
  const firstKeyword = keywords[0]
  if (!firstKeyword) return []

  const candidates: Set<string> = new Set()

  candidates.add(firstKeyword)

  // `initWith<X>:` always reduces to `init`.
  if (firstKeyword.startsWith('initWith')) {
    candidates.add('init')
  }

  // Preposition-prefix patterns
  const prepositionMatch = firstKeyword.match(
    /^([a-z][a-zA-Z0-9]*?)(?:With|For|By|In|On|At|From|To|Of|As)[A-Z]/
  )
  if (prepositionMatch && prepositionMatch[1]) {
    candidates.add(prepositionMatch[1])
  }

  // `setX:` could be a property setter
  if (
    keywords.length === 1 &&
    /^set[A-Z]/.test(firstKeyword) &&
    selector.endsWith(':')
  ) {
    const propName = lowerFirst(firstKeyword.slice(3))
    if (propName) candidates.add(propName)
  }

  return Array.from(candidates)
}

/**
 * Detect whether a Swift method `@objc` declaration uses the `@objc(custom:)`
 * override form, returning the literal selector when present.
 */
export function detectExplicitObjcName(sourceSlice: string): string | null {
  const m = sourceSlice.match(/@objc\s*\(\s*([^)\s]+)\s*\)/)
  return m && m[1] ? m[1] : null
}

/**
 * Detect whether a Swift declaration is `@objc`-exposed.
 */
export function isObjcExposed(sourceSlice: string): boolean {
  if (/@nonobjc\b/.test(sourceSlice)) return false
  return /@objc\b/.test(sourceSlice)
}
