/**
 * Agent prompt template engine.
 *
 * Provides a structured way to compose agent system prompts from sections,
 * each of which can be conditionally included or excluded based on the
 * agent's classification and task context.
 *
 * Usage:
 *   const prompt = buildAgentPrompt({
 *     role: 'You are a code reviewer...',
 *     sections: ['capability', 'constraints', 'output-format'],
 *     context: { agentType: 'code-reviewer', taskType: 'review' },
 *   })
 */

export type PromptSection = {
  id: string
  label: string
  content: string | ((context: PromptContext) => string)
  /** If set, only include when context.taskType matches */
  taskTypes?: string[]
  /** If set, only include when context.agentType matches */
  agentTypes?: string[]
  /** If true, always include regardless of filters */
  required?: boolean
}

export type PromptContext = {
  agentType: string
  taskType?: string
  cwd?: string
  gitStatus?: string
  [key: string]: unknown
}

export type PromptTemplate = {
  name: string
  role: string
  sections: PromptSection[]
  /** Sections to omit for this template */
  omitSections?: string[]
}

/**
 * Build a composed prompt from a template and context.
 */
export function buildAgentPrompt(
  template: PromptTemplate,
  context: PromptContext,
): string {
  const omitSet = new Set(template.omitSections ?? [])
  const parts: string[] = []

  // Role (always included)
  parts.push(`# Role\n\n${template.role}`)

  // Sections
  for (const section of template.sections) {
    // Check omit list
    if (omitSet.has(section.id)) continue
    // Check required (always included)
    if (!section.required) {
      // Check task type filter
      if (section.taskTypes && !section.taskTypes.includes(context.taskType ?? ''))
        continue
      // Check agent type filter
      if (section.agentTypes && !section.agentTypes.includes(context.agentType))
        continue
    }

    const content =
      typeof section.content === 'function'
        ? section.content(context)
        : section.content

    parts.push(`# ${section.label}\n\n${content}`)
  }

  return parts.join('\n\n---\n\n')
}

/**
 * Built-in section definitions that can be composed into any template.
 */
export const BUILT_IN_SECTIONS: Record<string, Omit<PromptSection, 'label'>> = {
  'capability': {
    id: 'capability',
    content:
      'You have access to read and analyze code files. You can run commands to build, test, and inspect the codebase.',
  },
  'constraints': {
    id: 'constraints',
    content: (ctx: PromptContext) => {
      const lines: string[] = []
      lines.push('- Make surgical changes. Touch only what you must.')
      lines.push("- Don't refactor what isn't broken. Match existing style.")
      lines.push('- Minimum code that solves the problem.')
      lines.push("- Don't add error handling for scenarios that can't happen.")
      lines.push("- Don't create helpers for one-time operations.")

      // Research agents get additional constraints
      if (ctx.taskType === 'research') {
        lines.push("- Don't modify any files.")
        lines.push("- Report findings concisely with file:line references.")
      }

      // Review agents
      if (ctx.taskType === 'review') {
        lines.push("- Don't modify any files.")
        lines.push("- List issues with severity and specific fixes.")
      }

      return lines.join('\n')
    },
  },
  'output-format': {
    id: 'output-format',
    content: (ctx: PromptContext) => {
      if (ctx.taskType === 'research') {
        return 'Report your findings as a structured summary:\n## Key Findings\n## Files of Interest\n## Recommendations'
      }
      if (ctx.taskType === 'review') {
        return 'Report issues in this format:\n## Issues Found\n| Severity | File | Line | Issue | Fix |\n\nEnd with a verdict: PASS / FAIL / PARTIAL'
      }
      return 'After completing the task, briefly summarize what you changed and why.'
    },
  },
  'context': {
    id: 'context',
    content: (ctx: PromptContext) => {
      const parts: string[] = []
      if (ctx.cwd) parts.push(`Working directory: \`${ctx.cwd}\``)
      if (ctx.gitStatus) parts.push(`Git status:\n\`\`\`\n${ctx.gitStatus}\n\`\`\``)
      return parts.length > 0 ? parts.join('\n') : 'No additional context.'
    },
    taskTypes: ['implementation', 'general'],
  },
} as const

/**
 * Predefined templates for common agent types.
 */
export const BUILT_IN_TEMPLATES: Record<string, PromptTemplate> = {
  'research': {
    name: 'research',
    role: 'You are a research agent. Your job is to investigate and report findings.',
    sections: [
      { ...BUILT_IN_SECTIONS.capability, label: 'Capabilities' },
      { ...BUILT_IN_SECTIONS.constraints, label: 'Constraints' },
      { ...BUILT_IN_SECTIONS['output-format'], label: 'Output Format' },
    ],
    omitSections: ['context'],
  },
  'review': {
    name: 'review',
    role: 'You are a code review agent. Your job is to find issues in the code.',
    sections: [
      { ...BUILT_IN_SECTIONS.capability, label: 'Capabilities' },
      { ...BUILT_IN_SECTIONS.constraints, label: 'Constraints' },
      { ...BUILT_IN_SECTIONS['output-format'], label: 'Output Format' },
    ],
    omitSections: ['context'],
  },
} as const
