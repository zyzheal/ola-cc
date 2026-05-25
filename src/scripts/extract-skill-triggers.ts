/**
 * Extract trigger suggestions from existing superpowers skills.
 *
 * Reads SKILL.md files, extracts trigger words from description/when_to_use/body,
 * and outputs suggested trigger fields for human review.
 *
 * Usage: bun run src/scripts/extract-skill-triggers.ts
 */

import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'

const SUPERPOWERS_SKILLS_DIR = process.env.SUPERPOWERS_SKILLS_DIR ??
  join(process.env.HOME ?? '', '.ola-cc/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills')

// Stopwords to filter out — common English/Chinese words that add no discrimination value
const STOPWORDS = new Set([
  // English
  'to', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'use', 'using',
  'in', 'on', 'at', 'by', 'for', 'of', 'with', 'about', 'against', 'between',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'from',
  'up', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once',
  'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 'just', 'because', 'as', 'until',
  'while', 'and', 'but', 'or', 'if', 'this', 'that', 'these', 'those',
  'it', 'its', 'they', 'them', 'their', 'what', 'which', 'who', 'whom',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'we', 'us', 'our', 'i', 'me', 'my',
  // Chinese — high-frequency single chars that appear in almost any skill
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '们', '这', '那',
  '要', '会', '能', '可以', '应该', '不', '也', '就', '都', '还',
  '使用', '进行', '任何',
])

interface SkillTriggerSuggestion {
  name: string
  currentDescription: string
  suggestedTrigger: string[]
  suggestedExclusion: string | null
  suggestedScope: string | null
}

function extractTriggerFromDescription(description: string): string[] {
  // Pattern: "Trigger: xxx yyy zzz" or "触发词: xxx"
  const triggerMatch = description.match(/Trigger:\s*(.+?)(?:\.|When asked|$)/i)
  if (!triggerMatch) return []

  const raw = triggerMatch[1]!
    .split(/[,，\s]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('When') && !s.startsWith('when'))

  // Deduplicate + filter stopwords
  const seen = new Set<string>()
  const result: string[] = []
  for (const t of raw) {
    const lower = t.toLowerCase()
    if (STOPWORDS.has(lower) || STOPWORDS.has(t)) continue
    if (seen.has(lower)) continue
    seen.add(lower)
    result.push(t)
  }
  return result
}

function extractExclusionFromDescription(description: string): string | null {
  // Look for "not responsible", "不做", "exclude" etc.
  const exclusionPatterns = [
    /([^。]*不做[^。]*)/,
    /([^。]*不使用[^。]*)/,
    /([^。]*不负责[^。]*)/,
    /([^。]*not responsible[^。]*)/i,
    /([^。]*exclude[^。]*)/i,
    /([^。]*does not handle[^。]*)/i,
  ]
  for (const pattern of exclusionPatterns) {
    const match = description.match(pattern)
    if (match) return match[1]!.trim()
  }
  return null
}

function extractScopeFromBody(body: string): string | null {
  // Look for "When to Use" section or similar
  const patterns = [
    /##\s*When to Use\s*\n([\s\S]*?)(?=\n##\s)/i,
    /##\s*触发条件\s*\n([\s\S]*?)(?=\n##\s)/i,
    /##\s*Overview\s*\n([\s\S]*?)(?=\n##\s)/i,
  ]
  for (const pattern of patterns) {
    const match = body.match(pattern)
    if (match) {
      const section = match[1]!.trim().split('\n').slice(0, 3).join(' ')
      return section.length > 100 ? section.slice(0, 100) + '...' : section
    }
  }
  return null
}

function processSkill(skillDir: string): SkillTriggerSuggestion | null {
  const skillPath = join(skillDir, 'SKILL.md')
  let content: string
  try {
    content = readFileSync(skillPath, 'utf-8')
  } catch {
    return null
  }

  const { frontmatter, content: body } = parseFrontmatter(content)
  const name = String(frontmatter.name || skillDir.split('/').pop())
  const description = String(frontmatter.description || '')

  const suggestedTrigger = extractTriggerFromDescription(description)
  const suggestedExclusion = extractExclusionFromDescription(description)
  const suggestedScope = extractScopeFromBody(body)

  return {
    name,
    currentDescription: description.slice(0, 120),
    suggestedTrigger: suggestedTrigger.length > 0 ? suggestedTrigger : ['/* 需手动补充 */'],
    suggestedExclusion,
    suggestedScope,
  }
}

function main() {
  const skillDirs = readdirSync(SUPERPOWERS_SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(SUPERPOWERS_SKILLS_DIR, d.name))

  const suggestions: SkillTriggerSuggestion[] = []
  for (const dir of skillDirs) {
    const result = processSkill(dir)
    if (result) suggestions.push(result)
  }

  // Output as YAML for human review
  console.log('# Skill Trigger Suggestions (auto-extracted)')
  console.log('# Review and merge into SKILL.md files')
  console.log('')
  console.log('skills:')
  for (const s of suggestions) {
    console.log(`  - name: ${s.name}`)
    console.log(`    current_description: "${s.currentDescription.replace(/"/g, '\\"')}"`)
    console.log(`    suggested_trigger:`)
    for (const t of s.suggestedTrigger) {
      console.log(`      - "${t}"`)
    }
    if (s.suggestedExclusion) {
      console.log(`    has_exclusion: true`)
      console.log(`    exclusion_text: "${s.suggestedExclusion.replace(/"/g, '\\"')}"`)
    } else {
      console.log(`    has_exclusion: false`)
      console.log(`    exclusion_suggestion: "建议添加排除性声明，如：不做XXX（用YYY替代）"`)
    }
    console.log('')
  }

  // Also output as patch suggestions
  console.log('---')
  console.log('# Suggested SKILL.md frontmatter additions')
  console.log('')
  for (const s of suggestions) {
    if (s.suggestedTrigger[0] !== '/* 需手动补充 */') {
      console.log(`## ${s.name}`)
      console.log('```yaml')
      console.log(`trigger: ${s.suggestedTrigger.join(', ')}`)
      console.log('```')
      console.log('')
    }
  }
}

main()
