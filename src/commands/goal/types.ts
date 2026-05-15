export enum ThreadGoalStatus {
  Active = 'active',
  Paused = 'paused',
  BudgetLimited = 'budget_limited',
  Complete = 'complete',
}

// GoalMode: tiered prompt complexity
export type GoalMode = 'simple' | 'standard' | 'complex'

// TurnRecord: per-turn API usage for ring buffer
export interface TurnRecord {
  turnId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  wallStartMs: number
  wallEndMs: number
}

// GoalTask: dedicated task (decoupled from TodoWrite)
export interface GoalTask {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  order: number
}

export interface Goal {
  id: string
  threadId: string
  objective: string
  status: ThreadGoalStatus | ''
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
  // 方案 C: 关联 TodoWrite 列表
  todoListId?: string  // 关联的 TodoWrite 列表 ID（sessionId 或 agentId）
  totalApiTokens: number          // Authoritative API token sum
  totalApiWallMs: number          // Total API wall time ms
  mode: GoalMode                  // Prompt tier
  autoEdit: boolean               // Auto-approve file edits only
  goalTaskListId?: string         // Dedicated task list ID
  consecutiveErrors?: number      // Error counter for auto-pause
  turnsWithNoChanges?: number     // Dead-turn detection
}

export interface GoalRuntimeState {
  accounting: {
    turn: { turnId: string; lastTokenUsage: TokenUsage; activeGoalId: string | null } | null
    wallClock: { lastAccountedAt: number; activeGoalId: string | null }
  }
  budgetLimitReportedGoalId: string | null
  continuationTurnId: string | null
  turnBuffer: TurnRecord[]        // Ring buffer, max 3
  totalApiTokens: number           // Sum of API response tokens
  totalApiWallMs: number           // Sum of API wall time
  consecutiveErrors: number        // Consecutive error counter
  turnsWithNoChanges: number       // Turns with no observable changes
  _currentTurnWallStartMs: number  // Internal: track current turn API start
}

export interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export const IDLE_GOAL: Goal = {
  id: '',
  threadId: '',
  objective: '',
  status: '',
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 0,
  updatedAt: 0,
  totalApiTokens: 0,
  totalApiWallMs: 0,
  mode: 'standard' as GoalMode,
  autoEdit: false,
  consecutiveErrors: 0,
  turnsWithNoChanges: 0,
}

/**
 * Migrate an existing Goal to the new schema with all fields populated.
 * Called on first access to a goal that may lack new fields.
 */
export function migrateGoal(goal: Goal): Goal {
  return {
    ...goal,
    totalApiTokens: goal.totalApiTokens ?? goal.tokensUsed ?? 0,
    totalApiWallMs: goal.totalApiWallMs ?? (goal.timeUsedSeconds ?? 0) * 1000,
    mode: goal.mode ?? 'standard',
    autoEdit: goal.autoEdit ?? false,
    consecutiveErrors: goal.consecutiveErrors ?? 0,
    turnsWithNoChanges: goal.turnsWithNoChanges ?? 0,
  }
}