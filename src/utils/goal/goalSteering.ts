import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import type { Goal } from '../../commands/goal/types.js'

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../commands/goal/templates')

function renderTemplate(templateName: string, vars: Record<string, string>): string {
  let template = readFileSync(join(TEMPLATES_DIR, templateName), 'utf-8')
  for (const [key, value] of Object.entries(vars)) {
    template = template.replace(new RegExp(`{{${key}}}`, 'g'), value)
  }
  return template
}

export function buildContinuationPrompt(goal: Goal): string {
  const tokenBudget = goal.tokenBudget?.toString() ?? 'unbounded'
  const remaining = goal.tokenBudget 
    ? Math.max(0, goal.tokenBudget - goal.tokensUsed).toString() 
    : 'unbounded'
  
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