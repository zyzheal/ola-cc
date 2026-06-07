/**
 * Line-level importance detection for context compression.
 *
 * Design based on Headroom's Tiered combinator + KeywordDetector pattern:
 * - Tiered layers: high-confidence tier short-circuits, lower tiers fall through
 * - 5 importance categories with calibrated priorities
 * - Word-boundary-aware keyword matching (not substring)
 * - Context-sensitive: different keyword sets for different contexts
 *
 * Integrated into microCompact's shouldProtectToolResult for finer-grained
 * protection than the previous flat keyword list.
 */

// ── Importance Categories ──

export type ImportanceCategory =
  | 'error'
  | 'warning'
  | 'security'
  | 'importance'
  | 'structure'

export interface ImportanceSignal {
  category: ImportanceCategory | null
  /** 0.0 = drop first, 1.0 = keep at all costs */
  priority: number
  /** 0.0 = no information, 1.0 = detector is sure */
  confidence: number
}

const NEUTRAL: ImportanceSignal = { category: null, priority: 0, confidence: 0 }

// ── Category Priorities (calibrated against Headroom) ──

const CATEGORY_PRIORITY: Record<ImportanceCategory, number> = {
  error: 0.95,
  security: 0.85,
  warning: 0.75,
  importance: 0.60,
  structure: 0.45,
}

// ── Keyword Registry ──

interface KeywordSet {
  error: string[]
  warning: string[]
  security: string[]
  importance: string[]
  structure: string[]
}

const DEFAULT_KEYWORDS: KeywordSet = {
  error: [
    'error', 'exception', 'fail', 'failed', 'failure', 'fatal',
    'critical', 'crash', 'panic', 'abort', 'timeout', 'denied',
    'rejected', 'segfault', 'segv',
  ],
  warning: ['warn', 'warning', 'deprecated', 'caution'],
  security: ['security', 'auth', 'password', 'secret', 'credential', 'token_leak', 'vulnerability', 'cve'],
  importance: ['important', 'note', 'todo', 'fixme', 'hack', 'xxx', 'bug', 'fix', 'breaking'],
  structure: ['# ', '## ', '### ', '#### ', '> ', '**', '---', '```'],
}

// ── Word Boundary Detection ──

function isWordChar(ch: string): boolean {
  return /[a-zA-Z0-9_]/.test(ch)
}

/**
 * Check if keyword appears as a whole word in text.
 * Prevents "preferred" matching "error" via substring.
 */
function containsWholeWord(text: string, keyword: string): boolean {
  const lower = text.toLowerCase()
  const kw = keyword.toLowerCase()
  let idx = lower.indexOf(kw)
  while (idx !== -1) {
    const before = idx === 0 || !isWordChar(lower[idx - 1]!)
    const after = idx + kw.length >= lower.length || !isWordChar(lower[idx + kw.length]!)
    if (before && after) return true
    idx = lower.indexOf(kw, idx + 1)
  }
  return false
}

// ── Detector Interface ──

export interface LineImportanceDetector {
  score(line: string): ImportanceSignal
  readonly name: string
}

// ── Keyword Detector (Tier 1 — fast, high confidence) ──

export class KeywordDetector implements LineImportanceDetector {
  readonly name = 'keyword'
  private keywords: KeywordSet
  private confidence: number

  constructor(keywords: KeywordSet = DEFAULT_KEYWORDS, confidence = 0.7) {
    this.keywords = keywords
    this.confidence = confidence
  }

  score(line: string): ImportanceSignal {
    // Priority order: error > security > warning > importance > structure
    for (const keyword of this.keywords.error) {
      if (containsWholeWord(line, keyword)) {
        return { category: 'error', priority: CATEGORY_PRIORITY.error, confidence: this.confidence }
      }
    }
    for (const keyword of this.keywords.security) {
      if (containsWholeWord(line, keyword)) {
        return { category: 'security', priority: CATEGORY_PRIORITY.security, confidence: this.confidence }
      }
    }
    for (const keyword of this.keywords.warning) {
      if (containsWholeWord(line, keyword)) {
        return { category: 'warning', priority: CATEGORY_PRIORITY.warning, confidence: this.confidence }
      }
    }
    for (const keyword of this.keywords.importance) {
      if (containsWholeWord(line, keyword)) {
        return { category: 'importance', priority: CATEGORY_PRIORITY.importance, confidence: this.confidence }
      }
    }
    // Structure: prefix-based (not whole-word)
    for (const prefix of this.keywords.structure) {
      if (line.startsWith(prefix)) {
        return { category: 'structure', priority: CATEGORY_PRIORITY.structure, confidence: this.confidence }
      }
    }
    return NEUTRAL
  }
}

// ── Pattern Detector (Tier 2 — regex-based, medium confidence) ──

interface PatternRule {
  pattern: RegExp
  category: ImportanceCategory
  confidence: number
}

const DEFAULT_PATTERNS: PatternRule[] = [
  // Stack traces
  { pattern: /^\s*at\s+.*\(.*:\d+:\d+\)/, category: 'error', confidence: 0.8 },
  { pattern: /^\s*File ".*", line \d+/, category: 'error', confidence: 0.8 },
  // Python traceback
  { pattern: /Traceback \(most recent call last\)/, category: 'error', confidence: 0.9 },
  // Exit codes
  { pattern: /exit (code|status) [1-9]\d*/i, category: 'error', confidence: 0.6 },
  // HTTP errors
  { pattern: /\b[45]\d{2}\b.*(?:error|fail|not found|forbidden|unauthorized)/i, category: 'error', confidence: 0.6 },
  // Security patterns
  { pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/i, category: 'security', confidence: 0.7 },
  // Multi-word crash phrases (preserved from legacy BASH_ERROR_INDICATORS)
  { pattern: /segmentation\s+fault/i, category: 'error', confidence: 0.9 },
  { pattern: /core\s+dumped/i, category: 'error', confidence: 0.9 },
  { pattern: /fatal\s+error/i, category: 'error', confidence: 0.85 },
  { pattern: /unrecoverable/i, category: 'error', confidence: 0.8 },
]

export class PatternDetector implements LineImportanceDetector {
  readonly name = 'pattern'
  private rules: PatternRule[]

  constructor(rules: PatternRule[] = DEFAULT_PATTERNS) {
    this.rules = rules
  }

  score(line: string): ImportanceSignal {
    let best: ImportanceSignal = NEUTRAL
    for (const rule of this.rules) {
      if (rule.pattern.test(line)) {
        const priority = CATEGORY_PRIORITY[rule.category]
        if (rule.confidence > best.confidence) {
          best = { category: rule.category, priority, confidence: rule.confidence }
        }
      }
    }
    return best
  }
}

// ── Tiered Combinator (mirrors Headroom's Tiered<T>) ──

const ESCALATE_THRESHOLD = 0.7

/**
 * Chains an ordered list of detectors. The first tier whose signal
 * exceeds ESCALATE_THRESHOLD confidence wins; lower-confidence tiers
 * are skipped. If no tier exceeds the threshold, the highest-confidence
 * signal seen is returned.
 *
 * This mirrors Headroom's Tiered combinator pattern:
 * - PatternDetector (tier 1) runs first — higher precision, confidence 0.6-0.9
 * - KeywordDetector (tier 2) — high recall fallback, confidence 0.7
 * - PatternDetector with confidence ≥ 0.7 short-circuits before keyword check
 * - Future ML detectors with calibrated confidence ≥ 0.8 would short-circuit
 */
export class TieredDetector implements LineImportanceDetector {
  readonly name = 'tiered'
  private tiers: LineImportanceDetector[]

  constructor(tiers?: LineImportanceDetector[]) {
    this.tiers = tiers ?? [
      new PatternDetector(),   // Tier 2: regex patterns (higher precision)
      new KeywordDetector(),   // Tier 1: keyword matching (high recall)
    ]
  }

  score(line: string): ImportanceSignal {
    let best: ImportanceSignal = NEUTRAL
    for (const tier of this.tiers) {
      const signal = tier.score(line)
      if (signal.confidence >= ESCALATE_THRESHOLD) {
        return signal
      }
      if (signal.confidence > best.confidence) {
        best = signal
      }
    }
    return best
  }
}

// ── Singleton instance for use in microCompact ──

let _sharedDetector: TieredDetector | null = null

/**
 * Get the shared TieredDetector instance.
 * Lazy-initialized to avoid import-time side effects.
 */
export function getLineImportanceDetector(): TieredDetector {
  if (!_sharedDetector) {
    _sharedDetector = new TieredDetector()
  }
  return _sharedDetector
}

/**
 * Score a line's importance. Returns the priority (0-1) for use in
 * protection decisions. Higher priority = more important to keep.
 *
 * @returns priority value in [0, 1], or 0 if no detector matched
 */
export function scoreLineImportance(line: string): number {
  return getLineImportanceDetector().score(line).priority
}

/**
 * Check if a text block contains high-importance lines that should
 * be protected from micro-compact clearing.
 *
 * @param text - The tool result text content
 * @param threshold - Minimum priority to consider important (default: 0.6)
 * @returns true if any line exceeds the threshold
 */
export function containsImportantContent(text: string, threshold = 0.6): boolean {
  const detector = getLineImportanceDetector()
  const lines = text.split('\n')
  // Check up to 100 lines for performance (large outputs are dominated by noise)
  const limit = Math.min(lines.length, 100)
  for (let i = 0; i < limit; i++) {
    const line = lines[i]!
    if (line.length > 0 && detector.score(line).priority >= threshold) {
      return true
    }
  }
  return false
}
