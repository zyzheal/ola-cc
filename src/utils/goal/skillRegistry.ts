/**
 * skillRegistry — SKILL.md frontmatter scanner with 30s cache
 *
 * Scans SKILL.md files under the skills directory to build a registry of available skills.
 * Parses YAML frontmatter for metadata (name, description, triggers, etc.).
 *
 * Design reference: docs/superpowers/specs/2026-05-28-goal-react-orchestrator-design.md §4.8
 */

// ============================================
// Types
// ============================================

export interface SkillMetadata {
  name: string
  path: string
  description: string
  triggers: string[]
  priority: number
  conflictsWith: string[]
  lastModified: number
}

// ============================================
// Frontmatter parsing
// ============================================

/**
 * Parse YAML frontmatter between `---` markers into a flat key-value record.
 * Only supports single-line values. Returns empty object if no frontmatter found.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  // Match frontmatter block: starts with --- on its own line, ends with --- on its own line
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!match) return result

  const block = match[1]
  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx === -1) continue

    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()

    if (!key) continue

    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      result[key] = value.slice(1, -1)
    } else {
      result[key] = value
    }
  }

  return result
}

/**
 * Parse comma-separated trigger string into trimmed, non-empty tokens.
 */
export function parseTriggers(triggerStr: string): string[] {
  if (!triggerStr) return []
  return triggerStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

// ============================================
// Registry scanning
// ============================================

/**
 * Scan all SKILL.md files under the skills directory and parse each file's frontmatter.
 * Skips files without a `name` field or with read/parse errors.
 */
export async function scanSkillRegistry(): Promise<SkillMetadata[]> {
  const { glob } = await import("glob")
  const { readFile, stat } = await import("fs/promises")
  const { homedir } = await import("os")
  const { resolve } = await import("path")

  const skillsDir = resolve(homedir(), ".ola-cc", "skills", "*", "SKILL.md")
  const files = await glob(skillsDir)
  const results: SkillMetadata[] = []

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8")
      const frontmatter = parseFrontmatter(content)

      // Skip skills without a name field
      if (!frontmatter.name) continue

      const fileStat = await stat(filePath)

      results.push({
        name: frontmatter.name,
        path: filePath,
        description: frontmatter.description ?? "",
        triggers: parseTriggers(frontmatter.trigger ?? ""),
        priority: parseInt(frontmatter.priority ?? "0", 10) || 0,
        conflictsWith: (frontmatter["conflicts-with"] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        lastModified: fileStat.mtimeMs,
      })
    } catch {
      // Skip corrupted or unreadable files
    }
  }

  return results
}

// ============================================
// Cache layer (30s TTL)
// ============================================

let cachedSkills: SkillMetadata[] | null = null
let cacheTimestamp = 0

const CACHE_TTL_MS = 30_000

/**
 * Return cached skill metadata, refreshing if older than 30 seconds.
 */
export async function getSkillMetadata(): Promise<SkillMetadata[]> {
  if (cachedSkills && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSkills
  }
  cachedSkills = await scanSkillRegistry()
  cacheTimestamp = Date.now()
  return cachedSkills
}

/**
 * Invalidate the cache. Useful for testing or when skills change at runtime.
 */
export function invalidateSkillCache(): void {
  cachedSkills = null
  cacheTimestamp = 0
}
