/**
 * Agent classification system for context pruning.
 *
 * Maps agent types to their required tool sets and system prompt sections,
 * enabling the harness to strip dead weight from sub-agent contexts.
 *
 * Classification determines which tools an agent can access and which
 * system prompt sections are relevant.
 */

export type AgentClass = 'research' | 'implementation' | 'review' | 'planning' | 'general'

export interface AgentClassification {
  agentType: string
  class: AgentClass
  /** Tools this agent class is allowed to use */
  allowedTools: string[]
  /** Tools to explicitly deny */
  deniedTools?: string[]
  /** System prompt sections to omit */
  omitSystemSections?: string[]
}

// Tool constants we reference (imported from their respective modules)
const CORE_READ_TOOLS = ['file_read', 'file_read_tool', 'glob', 'glob_tool', 'grep', 'grep_tool']
const CORE_BASH = ['bash', 'bash_tool']
const WRITE_TOOLS = ['file_write', 'file_write_tool', 'file_edit', 'file_edit_tool', 'notebook_edit', 'notebook_edit_tool']
const AGENT_SPAWN = ['agent', 'agent_tool']

/**
 * Default classifications for built-in agent types.
 * Custom agents can override these via frontmatter.
 */
export const DEFAULT_CLASSIFICATIONS: AgentClassification[] = [
  {
    agentType: 'Explore',
    class: 'research',
    allowedTools: CORE_READ_TOOLS,
    deniedTools: [...WRITE_TOOLS, ...AGENT_SPAWN],
    omitSystemSections: ['commit-conventions', 'git-status'],
  },
  {
    agentType: 'Plan',
    class: 'planning',
    allowedTools: CORE_READ_TOOLS,
    deniedTools: [...WRITE_TOOLS, CORE_BASH, ...AGENT_SPAWN],
    omitSystemSections: ['commit-conventions', 'git-status'],
  },
  {
    agentType: 'verification',
    class: 'review',
    allowedTools: [...CORE_READ_TOOLS, ...CORE_BASH],
    deniedTools: [...WRITE_TOOLS, ...AGENT_SPAWN],
    omitSystemSections: ['commit-conventions'],
  },
]

/**
 * Get the classification for an agent type.
 * Returns undefined if no classification is defined (agent gets all tools).
 */
export function getClassification(agentType: string): AgentClassification | undefined {
  return DEFAULT_CLASSIFICATIONS.find(c => c.agentType === agentType)
}

/**
 * Get the list of tool names allowed for an agent class.
 */
export function getToolAllowanceForClass(agentClass: AgentClass): string[] {
  switch (agentClass) {
    case 'research':
      return CORE_READ_TOOLS
    case 'planning':
      return CORE_READ_TOOLS
    case 'review':
      return [...CORE_READ_TOOLS, ...CORE_BASH]
    case 'implementation':
    case 'general':
      return [] // empty = all tools
  }
}

/**
 * Check if an agent class should have gitStatus included.
 */
export function shouldIncludeGitStatus(agentClass: AgentClass): boolean {
  return agentClass === 'implementation' || agentClass === 'general'
}
