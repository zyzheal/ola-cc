export enum ThreadGoalStatus {
  Active = 'active',
  Paused = 'paused',
  BudgetLimited = 'budget_limited',
  Complete = 'complete',
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
}

export interface GoalRuntimeState {
  accounting: {
    turn: { turnId: string; lastTokenUsage: TokenUsage; activeGoalId: string | null } | null
    wallClock: { lastAccountedAt: number; activeGoalId: string | null }
  }
  budgetLimitReportedGoalId: string | null
  continuationTurnId: string | null
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
}