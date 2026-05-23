/**
 * Trigger word conflict detection for skills.
 *
 * Detects overlapping trigger words between skills to prevent model confusion
 * when multiple skills could match the same user request.
 *
 * Algorithm: comma-split tokenization + substring matching + synonym expansion.
 * Runs once at session startup after all skills are loaded. O(n²) pairwise
 * comparison, but n is typically < 100.
 */

import { logForDebugging } from '../utils/debug.js'

export type ConflictSeverity = 'error' | 'warning' | 'info'

export type Conflict = {
  skillA: string
  skillB: string
  overlappingTerms: string[]
  severity: ConflictSeverity
}

/**
 * Synonym expansion map — only clear 1:1 mappings or language variants.
 * Ambiguous words like "检查" (which can mean both "review" and "check")
 * are deliberately excluded to avoid false positives.
 */
const SYNONYM_MAP: ReadonlyMap<string, string[]> = new Map([
  ['评审', ['review']],
  ['设计', ['design', 'architecture']],
  ['代码', ['code', 'implementation']],
  ['文档', ['doc', 'document']],
  ['分析', ['analyze', 'analysis']],
])

/**
 * Tokenize a raw trigger string into individual terms with synonym expansion.
 *
 * Input: "评审文档, review doc"
 * Output: ["评审文档", "评审", "文档", "review doc", "review", "doc", "review文档", "评审document", "reviewdocument"]
 */
export function tokenizeTriggers(rawTriggers: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const raw of rawTriggers) {
    // Split by comma, trim each term
    const terms = raw.split(',').map(s => s.trim()).filter(s => s.length > 0)

    for (const trimmed of terms) {
      if (seen.has(trimmed.toLowerCase())) continue
      seen.add(trimmed.toLowerCase())
      result.push(trimmed)

      // Expand synonyms for each term
      const expanded = expandSynonyms(trimmed)
      for (const exp of expanded) {
        if (!seen.has(exp.toLowerCase())) {
          seen.add(exp.toLowerCase())
          result.push(exp)
        }
      }
    }
  }

  return result
}

/**
 * Expand synonyms within a single trigger term.
 * Generates the Cartesian product of all synonym replacements.
 *
 * Example: "评审文档" -> ["评审文档", "review文档", "评审doc", "reviewdoc", "评审document", "reviewdocument"]
 * Multi-key: "评审设计" -> ["评审设计", "review设计", "评审architecture", "reviewarchitecture"]
 */
function expandSynonyms(term: string): string[] {
  const results = new Set<string>([term])

  function expand(current: string): void {
    for (const [key, synonyms] of SYNONYM_MAP) {
      if (!current.includes(key)) continue
      for (const syn of synonyms) {
        const replaced = current.replaceAll(key, syn)
        if (replaced !== current && !results.has(replaced)) {
          results.add(replaced)
          expand(replaced)
        }
      }
    }
  }

  expand(term)
  return [...results]
}

/**
 * Find overlapping terms between two trigger sets.
 * Uses exact match + substring matching.
 */
function findOverlap(triggersA: string[], triggersB: string[]): string[] {
  const overlap: string[] = []

  for (const a of triggersA) {
    for (const b of triggersB) {
      if (a === b) {
        overlap.push(`${a} (精确匹配)`)
      } else if (a.length >= 3 && b.length >= 3) {
        // Only substring match for terms >= 3 chars to avoid high-frequency
        // bigram false positives like "代码"/"测试" matching too broadly.
        if (a.includes(b) || b.includes(a)) {
          overlap.push(`"${a}" <-> "${b}" (子串匹配)`)
        }
      }
    }
  }

  return overlap
}

/**
 * Compute severity based on overlap type.
 */
function computeSeverity(overlap: string[]): ConflictSeverity {
  const hasExact = overlap.some(o => o.includes('精确匹配'))
  if (hasExact) return 'error'
  return 'warning'
}

/**
 * Detect trigger conflicts across all skills.
 *
 * Returns a list of conflicts. Empty array means no conflicts.
 */
export function detectTriggerConflicts(
  allSkills: { name: string; trigger?: string[] }[],
): Conflict[] {
  const conflicts: Conflict[] = []

  for (let i = 0; i < allSkills.length; i++) {
    for (let j = i + 1; j < allSkills.length; j++) {
      const skillA = allSkills[i]!
      const skillB = allSkills[j]!

      // Skip skills without triggers
      if (!skillA.trigger || skillA.trigger.length === 0) continue
      if (!skillB.trigger || skillB.trigger.length === 0) continue

      const triggersA = tokenizeTriggers(skillA.trigger)
      const triggersB = tokenizeTriggers(skillB.trigger)

      const overlap = findOverlap(triggersA, triggersB)
      if (overlap.length > 0) {
        conflicts.push({
          skillA: skillA.name,
          skillB: skillB.name,
          overlappingTerms: overlap,
          severity: computeSeverity(overlap),
        })
      }
    }
  }

  return conflicts
}

/**
 * In-memory cache for detected conflicts. Populated once at startup.
 */
let _cachedConflicts: Conflict[] = []

/**
 * Get the cached conflicts. Returns empty array if not yet initialized.
 */
export function getConflicts(): Conflict[] {
  return _cachedConflicts
}

/**
 * Run conflict detection and cache the results.
 * Should be called once after all skills are loaded.
 */
export function runConflictDetection(
  allSkills: { name: string; trigger?: string[] }[],
): Conflict[] {
  _cachedConflicts = detectTriggerConflicts(allSkills)
  logTriggerConflicts(_cachedConflicts)
  return _cachedConflicts
}

/**
 * Get conflicts for a specific skill name.
 */
export function getConflictsForSkill(skillName: string): Conflict[] {
  return _cachedConflicts.filter(
    c => c.skillA === skillName || c.skillB === skillName,
  )
}
export function logTriggerConflicts(conflicts: Conflict[]): void {
  if (conflicts.length === 0) return

  for (const conflict of conflicts) {
    const level = conflict.severity === 'error' ? 'warn' : 'info'
    logForDebugging(
      `[!] Skill '${conflict.skillA}' trigger conflicts with '${conflict.skillB}': ${conflict.overlappingTerms.join(', ')}\n` +
        `Suggested: 1) refine triggers, 2) add to conflicts-with field, or 3) set disable-model-invocation: true`,
      { level },
    )
  }
}
