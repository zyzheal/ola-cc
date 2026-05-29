/**
 * CostTracker — 进化管道 LLM 调用成本追踪
 *
 * 记录每次 LLM 调用的 token 数、模型和费用，
 * 提供预算检查和按模型分组统计能力。
 * 每个进化周期通过 reset() 重置。
 */

interface CallRecord {
  model: string
  tokens: number
  cost: number
}

export class CostTrackerImpl {
  private calls: CallRecord[] = []

  /** 记录单次 LLM 调用成本 */
  recordLLMCall(tokens: number, model: string, cost: number): void {
    this.calls.push({ model, tokens, cost })
  }

  /** 获取当前进化周期的累计成本 */
  getTotalCost(): number {
    return this.calls.reduce((sum, c) => sum + c.cost, 0)
  }

  /** 检查是否超出预算 */
  isOverBudget(budget: number): boolean {
    return this.getTotalCost() > budget
  }

  /** 重置计数器（新进化周期开始时） */
  reset(): void {
    this.calls = []
  }

  /** 获取调用次数 */
  getCallCount(): number {
    return this.calls.length
  }

  /** 按模型分组统计 */
  getCallsByModel(): Record<string, { count: number; tokens: number; cost: number }> {
    const result: Record<string, { count: number; tokens: number; cost: number }> = {}
    for (const call of this.calls) {
      if (!result[call.model]) {
        result[call.model] = { count: 0, tokens: 0, cost: 0 }
      }
      result[call.model].count++
      result[call.model].tokens += call.tokens
      result[call.model].cost += call.cost
    }
    return result
  }

  /** 平均每次调用成本 */
  getAverageCostPerCall(): number {
    if (this.calls.length === 0) return 0
    return this.getTotalCost() / this.calls.length
  }
}
