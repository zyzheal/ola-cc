import type { AgentId } from '../../types/ids.js'

/**
 * Per-agent resource quota. Assigned when a subagent is spawned.
 */
export type AgentQuota = {
  /** Maximum USD cost this agent may incur (0 = unlimited) */
  maxBudgetUsd: number
  /** Maximum output tokens this agent may produce (0 = unlimited) */
  maxTokens: number
  /** Maximum wall-clock time in milliseconds (0 = unlimited) */
  timeoutMs: number
}

/**
 * Current consumption snapshot for a single agent.
 */
export type AgentConsumption = {
  costUsd: number
  outputTokens: number
  elapsedMs: number
}

/**
 * Result of a quota check.
 */
export type QuotaCheckResult = {
  allowed: boolean
  /** Which quota was exceeded, or null if within limits */
  exceeded: 'budget' | 'tokens' | 'timeout' | null
  /** Human-readable reason for denial */
  reason: string
}

/**
 * Tracks and enforces per-agent resource quotas.
 *
 * Design goals:
 * - Stateless: caller passes current consumption values each check
 * - No global state: each parent session creates its own instance
 * - Lightweight: no async operations, no external dependencies
 */
export class ResourceQuotaManager {
  /** Map of agentId → assigned quota */
  private quotas = new Map<AgentId, AgentQuota>()

  /** Map of agentId → baseline cost at spawn time (for delta tracking) */
  private baselines = new Map<AgentId, { costUsd: number }>()

  /** Session-level global budget cap (overrides all per-agent quotas) */
  private globalBudgetUsd: number

  /** Session-level global token cap (overrides all per-agent quotas) */
  private globalMaxTokens: number

  /** Current session-level accumulated cost */
  private sessionCostUsd: number

  /** Current session-level accumulated output tokens */
  private sessionOutputTokens: number

  constructor(opts?: {
    globalBudgetUsd?: number
    globalMaxTokens?: number
    initialSessionCostUsd?: number
    initialSessionOutputTokens?: number
  }) {
    this.globalBudgetUsd = opts?.globalBudgetUsd ?? 0
    this.globalMaxTokens = opts?.globalMaxTokens ?? 0
    this.sessionCostUsd = opts?.initialSessionCostUsd ?? 0
    this.sessionOutputTokens = opts?.initialSessionOutputTokens ?? 0
  }

  /**
   * Update session-level cost/token trackers after any API call.
   */
  recordSessionCost(costUsd: number, outputTokens: number): void {
    this.sessionCostUsd += costUsd
    this.sessionOutputTokens += outputTokens
  }

  /**
   * Assign a quota to a subagent before spawning.
   */
  allocateQuota(agentId: AgentId, quota: AgentQuota, baselineCostUsd: number): void {
    this.quotas.set(agentId, quota)
    this.baselines.set(agentId, { costUsd: baselineCostUsd })
  }

  /**
   * Check if an agent has remaining quota.
   * Call this before each API turn within the agent.
   */
  checkQuota(
    agentId: AgentId,
    consumption: AgentConsumption,
  ): QuotaCheckResult {
    const quota = this.quotas.get(agentId)
    const baseline = this.baselines.get(agentId)

    // Agent-specific quota
    if (quota) {
      const agentCostDelta = consumption.costUsd - (baseline?.costUsd ?? 0)

      if (quota.maxBudgetUsd > 0 && agentCostDelta >= quota.maxBudgetUsd) {
        return {
          allowed: false,
          exceeded: 'budget',
          reason: `Agent exceeded budget: spent $${agentCostDelta.toFixed(4)} of $${quota.maxBudgetUsd}`,
        }
      }

      if (quota.maxTokens > 0 && consumption.outputTokens >= quota.maxTokens) {
        return {
          allowed: false,
          exceeded: 'tokens',
          reason: `Agent exceeded token limit: produced ${consumption.outputTokens} of ${quota.maxTokens} tokens`,
        }
      }

      if (quota.timeoutMs > 0 && consumption.elapsedMs >= quota.timeoutMs) {
        return {
          allowed: false,
          exceeded: 'timeout',
          reason: `Agent timed out: ran for ${(consumption.elapsedMs / 1000).toFixed(0)}s of ${(quota.timeoutMs / 1000).toFixed(0)}s`,
        }
      }
    }

    // Global session-level checks
    if (this.globalBudgetUsd > 0 && this.sessionCostUsd >= this.globalBudgetUsd) {
      return {
        allowed: false,
        exceeded: 'budget',
        reason: `Session exceeded global budget: spent $${this.sessionCostUsd.toFixed(4)} of $${this.globalBudgetUsd}`,
      }
    }

    if (this.globalMaxTokens > 0 && this.sessionOutputTokens >= this.globalMaxTokens) {
      return {
        allowed: false,
        exceeded: 'tokens',
        reason: `Session exceeded global token limit: produced ${this.sessionOutputTokens} of ${this.globalMaxTokens} tokens`,
      }
    }

    return { allowed: true, exceeded: null, reason: '' }
  }

  /**
   * Release quota tracking for a completed/aborted agent.
   */
  releaseQuota(agentId: AgentId): void {
    this.quotas.delete(agentId)
    this.baselines.delete(agentId)
  }

  /**
   * Get the assigned quota for an agent (for reporting).
   */
  getQuota(agentId: AgentId): AgentQuota | undefined {
    return this.quotas.get(agentId)
  }

  /**
   * Get remaining budget for an agent.
   */
  getRemainingBudget(agentId: AgentId): number | null {
    const quota = this.quotas.get(agentId)
    const baseline = this.baselines.get(agentId)
    if (!quota || quota.maxBudgetUsd <= 0) return null

    const spent = this.sessionCostUsd - (baseline?.costUsd ?? 0)
    return Math.max(0, quota.maxBudgetUsd - spent)
  }

  /**
   * Set session-level global budget cap.
   */
  setGlobalBudget(usd: number): void {
    this.globalBudgetUsd = usd
  }

  /**
   * Set session-level global token cap.
   */
  setGlobalTokenLimit(tokens: number): void {
    this.globalMaxTokens = tokens
  }
}

// Session-scoped singleton. One ResourceQuotaManager per conversation;
// created lazily on first agent spawn with quota params.
let _sessionQuotaManager: ResourceQuotaManager | null = null

/**
 * Gets or creates the session-level quota manager.
 * All agents spawned in the same session share this instance for
 * cross-agent budget tracking and global budget enforcement.
 */
export function getSessionQuotaManager(): ResourceQuotaManager {
  if (!_sessionQuotaManager) {
    _sessionQuotaManager = new ResourceQuotaManager()
  }
  return _sessionQuotaManager
}

/**
 * Sets the session-level quota manager (for restore/testing).
 */
export function setSessionQuotaManager(manager: ResourceQuotaManager): void {
  _sessionQuotaManager = manager
}

/**
 * Resets the session quota manager (for testing).
 */
export function resetSessionQuotaManager(): void {
  _sessionQuotaManager = null
}
