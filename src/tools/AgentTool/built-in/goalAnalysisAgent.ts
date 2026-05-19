import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

const GOAL_ANALYSIS_SYSTEM_PROMPT = `You are analyzing execution trace for an AI agent working toward a goal.

Analyze:
1. Progress: Is the agent making measurable progress?
2. Pattern: Any recurring issues (errors, empty outputs)?
3. Direction: Is current approach effective?

Output format:
- If progressing: "CONTINUE: [brief encouragement]"
- If adjust needed: "ADJUST: [specific next-step recommendation]"
- If pause needed: "PAUSE: [reason] + /goal pause suggestion"
`

export const GOAL_ANALYSIS_AGENT: BuiltInAgentDefinition = {
  agentType: 'goal-analysis',
  whenToUse: 'When goal execution has stalled or produced errors',
  source: 'built-in',
  baseDir: 'built-in',
  model: 'haiku',
  disallowedTools: ['FileEdit', 'FileWrite', 'Bash', 'Edit', 'Write'],
  getSystemPrompt: () => GOAL_ANALYSIS_SYSTEM_PROMPT,
}