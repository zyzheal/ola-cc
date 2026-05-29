import {
  EvalDatasetManager,
  type EvalDataset,
  type EvalExample,
} from './evalDataset'

type LLMCaller = (prompt: string) => Promise<string>

/** Minimum skill text length to attempt LLM-based generation. */
const MIN_SKILL_TEXT_LENGTH = 10

/** Default values for generate() options. */
const DEFAULTS = {
  numCases: 20,
  maxRetries: 3,
  minValidCases: 5,
  timeoutMs: 30_000,
} as const

/**
 * Builds synthetic eval datasets from skill text by calling an LLM
 * to generate task/behavior examples, then validating and splitting them.
 */
export class SyntheticDatasetBuilder {
  constructor(private callLLM: LLMCaller) {}

  async generate(
    skillText: string,
    options?: {
      numCases?: number
      maxRetries?: number
      minValidCases?: number
      timeoutMs?: number
    },
  ): Promise<EvalDataset> {
    const numCases = options?.numCases ?? DEFAULTS.numCases
    const maxRetries = options?.maxRetries ?? DEFAULTS.maxRetries
    const minValidCases = options?.minValidCases ?? DEFAULTS.minValidCases

    // Early return for empty or very short skill text
    if (!skillText || skillText.trim().length < MIN_SKILL_TEXT_LENGTH) {
      return { train: [], val: [], holdout: [], skipValidation: true }
    }

    const prompt = this.buildPrompt(skillText, numCases)

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const raw = await this.callLLMWithTimeout(prompt, options?.timeoutMs)
        const parsed = JSON.parse(raw)

        if (!parsed || !Array.isArray(parsed.examples)) {
          throw new Error('LLM response missing "examples" array')
        }

        const validCases = this.validateCases(parsed.examples)

        if (validCases.length >= minValidCases) {
          return EvalDatasetManager.split(validCases)
        }

        // Not enough valid cases — retry
      } catch (err: unknown) {
        // Handle 429 rate limit with Retry-After
        if (isRateLimitError(err)) {
          const retryAfterMs = getRetryAfterMs(err)
          if (attempt < maxRetries - 1) {
            await sleep(retryAfterMs)
            continue
          }
        }

        // On last attempt, fall through to skipValidation fallback
        if (attempt === maxRetries - 1) {
          break
        }

        // Exponential backoff: 1s, 2s, 4s, ...
        await sleep(1000 * Math.pow(2, attempt))
      }
    }

    // All retries exhausted — return skipValidation fallback
    return { train: [], val: [], holdout: [], skipValidation: true }
  }

  private async callLLMWithTimeout(
    prompt: string,
    timeoutMs?: number,
  ): Promise<string> {
    const ms = timeoutMs ?? DEFAULTS.timeoutMs
    return Promise.race([
      this.callLLM(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('LLM call timed out')), ms),
      ),
    ])
  }

  private buildPrompt(skillText: string, numCases: number): string {
    return `You are generating synthetic evaluation examples for a skill/workflow.
Given the following skill text, generate ${numCases} diverse evaluation examples.

Each example must have:
- "taskInput": a realistic user task that would invoke this skill
- "expectedBehavior": what the skill should produce (detailed enough for validation, at least 20 chars)
- "difficulty": "easy", "medium", or "hard"
- "category": a relevant category string

Respond ONLY with valid JSON in this exact format:
{"examples": [...]}

Skill text:
---
${skillText}
---

Generate ${numCases} examples now:`
  }

  private validateCases(raw: unknown[]): EvalExample[] {
    const valid: EvalExample[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      if (
        typeof obj.taskInput === 'string' &&
        obj.taskInput.trim().length > 0 &&
        typeof obj.expectedBehavior === 'string' &&
        obj.expectedBehavior.trim().length >= 10 &&
        isValidDifficulty(obj.difficulty) &&
        typeof obj.category === 'string' &&
        obj.category.trim().length > 0
      ) {
        valid.push({
          taskInput: obj.taskInput.trim(),
          expectedBehavior: obj.expectedBehavior.trim(),
          difficulty: obj.difficulty,
          category: obj.category.trim(),
          source: 'synthetic',
        })
      }
    }
    return valid
  }
}

// --- Helpers ---

function isValidDifficulty(
  d: unknown,
): d is 'easy' | 'medium' | 'hard' {
  return d === 'easy' || d === 'medium' || d === 'hard'
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  return (
    e.status === 429 ||
    e.statusCode === 429 ||
    (typeof e.message === 'string' && e.message.includes('429'))
  )
}

function getRetryAfterMs(err: unknown): number {
  const e = err as Record<string, unknown>
  const header =
    (e.retryAfter as string) ?? (e.headers as Record<string, string>)?.['retry-after']
  if (header) {
    const seconds = Number.parseInt(header, 10)
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000
  }
  return 2000 // default 2s for rate limits
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
