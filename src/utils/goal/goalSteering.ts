import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import type { Goal } from '../../commands/goal/types.js'
import { getRemainingBudget } from './goalAccounting.js'

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../commands/goal/templates')

// Lazy-loaded template cache to avoid repeated file I/O
const templateCache = new Map<string, string>()

function getTemplate(templateName: string): string {
  if (!templateCache.has(templateName)) {
    const content = readFileSync(join(TEMPLATES_DIR, templateName), 'utf-8')
    templateCache.set(templateName, content)
  }
  return templateCache.get(templateName)!
}

function renderTemplate(templateName: string, vars: Record<string, string>): string {
  let template = getTemplate(templateName)
  for (const [key, value] of Object.entries(vars)) {
    // Escape regex special characters in key to prevent injection
    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    template = template.replace(new RegExp(`{{${safeKey}}}`, 'g'), value)
  }
  return template
}

export function buildContinuationPrompt(goal: Goal): string {
  const tokenBudget = goal.tokenBudget?.toString() ?? 'unbounded'
  const remainingVal = getRemainingBudget(goal)
  const remaining = remainingVal === 'unbounded' ? 'unbounded' : remainingVal.toString()

  return renderTemplate('continuation.md', {
    objective: escapeXml(goal.objective),
    tokens_used: goal.tokensUsed.toString(),
    time_used_seconds: goal.timeUsedSeconds.toString(),
    token_budget: tokenBudget,
    remaining_tokens: remaining,
  })
}

export function buildBudgetLimitPrompt(goal: Goal): string {
  const tokenBudget = goal.tokenBudget?.toString() ?? 'none'
  
  return renderTemplate('budget_limit.md', {
    objective: escapeXml(goal.objective),
    tokens_used: goal.tokensUsed.toString(),
    time_used_seconds: goal.timeUsedSeconds.toString(),
    token_budget: tokenBudget,
  })
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}