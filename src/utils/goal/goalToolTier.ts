/**
 * goalToolTier — L3/L2/L1 工具层级系统 for ANALYZE phase
 *
 * 主动调用 CodeGraph + Grok 获取深度分析结果，
 * 注入 continuation prompt 为模型提供上下文。
 *
 * 设计参考: docs/superpowers/specs/2026-05-29-goal-quality-gated-single-loop-design.md §7
 *
 * 纯函数 + 有副作用分离:
 * - computeAnalysisPlan() — 纯函数，决定调用什么
 * - executeProactiveAnalysis() — 有副作用，实际调用 CodeGraph/Grok
 * - formatL3Results() — 纯函数，格式化结果用于 prompt 注入
 * - gateAnalyze() — 纯函数，ANALYZE 阶段质量门控
 */

import type { ReActPhase } from "./goalReActObserver.js"

// ============================================
// 类型定义
// ============================================

export interface L3Result {
  tool: "codegraph" | "grok"
  operation: string
  data: string
  success: boolean
  elapsedMs: number
}

export interface L3Results {
  results: L3Result[]
  codegraphCalls: number
  grokCalls: number
  degraded: boolean
  degradeReason?: string
}

export interface AnalysisPlan {
  codegraphOps: string[]
  grokOps: string[]
  reason: string
}

export interface GateAnalyzeResult {
  passed: boolean
  l3CallCount: number
  details: string
}

export interface ToolTierState {
  /** 上次调用时间戳 (per tool) */
  lastCallTime: Map<string, number>
  /** 上次调用时间戳 (per operation) */
  opLastCallTime: Map<string, number>
  /** 当前任务的 CodeGraph 调用次数 */
  codegraphCallCount: number
  /** 当前任务的 Grok 调用次数 */
  grokCallCount: number
  /** 当前任务标识 (用于检测任务切换重置计数) */
  currentTaskId: string
  /** 是否首次 ANALYZE */
  isFirstAnalyze: boolean
}

// ============================================
// 常量
// ============================================

const DEBOUNCE_MS = 30_000
const CODEGRAPH_MAX_CALLS = 2
const GROK_MAX_CALLS = 1
const CODEGRAPH_TIMEOUT_MS = 10_000
const GROK_TIMEOUT_MS = 15_000
const RESULT_TRUNCATE_CHARS = 2000
const MAX_TRACKED_TOOLS = 20

// ============================================
// 状态管理
// ============================================

export function createToolTierState(): ToolTierState {
  return {
    lastCallTime: new Map(),
    opLastCallTime: new Map(),
    codegraphCallCount: 0,
    grokCallCount: 0,
    currentTaskId: "",
    isFirstAnalyze: true,
  }
}

/**
 * 重置任务计数器 (任务切换时调用)
 */
export function resetTaskCounters(state: ToolTierState, taskId: string): void {
  if (state.currentTaskId !== taskId) {
    state.codegraphCallCount = 0
    state.grokCallCount = 0
    state.currentTaskId = taskId
    state.isFirstAnalyze = true
    state.opLastCallTime.clear()
  }
}

/**
 * 检查防抖: 操作或工具在 DEBOUNCE_MS 内是否已调用。
 * 优先检查 per-operation 级别，再 fallback 到 per-tool 级别。
 */
export function isDebounced(state: ToolTierState, toolOrOperation: string): boolean {
  // Check per-operation debounce first
  const opTime = state.opLastCallTime.get(toolOrOperation)
  if (opTime && Date.now() - opTime < DEBOUNCE_MS) return true

  // Fall back to per-tool debounce
  const lastTime = state.lastCallTime.get(toolOrOperation)
  if (!lastTime) return false
  return Date.now() - lastTime < DEBOUNCE_MS
}

/**
 * 检查是否达到调用上限
 */
export function isAtLimit(state: ToolTierState, tool: "codegraph" | "grok"): boolean {
  if (tool === "codegraph") return state.codegraphCallCount >= CODEGRAPH_MAX_CALLS
  return state.grokCallCount >= GROK_MAX_CALLS
}

/**
 * 记录一次成功的调用。仅在调用成功后调用。
 * 可选传入 operation 名称以启用 per-operation 防抖。
 */
export function recordCall(state: ToolTierState, tool: "codegraph" | "grok", operation?: string): void {
  state.lastCallTime.set(tool, Date.now())
  if (operation) state.opLastCallTime.set(operation, Date.now())
  if (tool === "codegraph") state.codegraphCallCount++
  else state.grokCallCount++
  if (state.isFirstAnalyze) state.isFirstAnalyze = false

  // 防止 lastCallTime 无限增长
  if (state.lastCallTime.size > MAX_TRACKED_TOOLS) {
    const oldest = [...state.lastCallTime.entries()]
      .sort((a, b) => a[1] - b[1])[0]
    if (oldest) state.lastCallTime.delete(oldest[0])
  }

  // 防止 opLastCallTime 无限增长
  if (state.opLastCallTime.size > MAX_TRACKED_TOOLS) {
    const oldest = [...state.opLastCallTime.entries()]
      .sort((a, b) => a[1] - b[1])[0]
    if (oldest) state.opLastCallTime.delete(oldest[0])
  }
}

// ============================================
// 纯函数: 质量门控
// ============================================

/**
 * ANALYZE 阶段质量门控。
 * 设计参考: §6.2 — 通过条件: ≥1 次 L3 工具调用
 * 纯函数。
 */
export function gateAnalyze(l3Results: L3Results | undefined): GateAnalyzeResult {
  if (!l3Results) {
    return { passed: false, l3CallCount: 0, details: "No L3 results available" }
  }
  const l3CallCount = l3Results.codegraphCalls + l3Results.grokCalls
  if (l3CallCount < 1) {
    return {
      passed: false,
      l3CallCount,
      details: l3Results.degraded
        ? `L3 degraded: ${l3Results.degradeReason}`
        : "No successful L3 calls",
    }
  }
  return { passed: true, l3CallCount, details: `${l3CallCount} L3 calls successful` }
}

// ============================================
// 纯函数: 分析计划计算
// ============================================

/**
 * 根据当前阶段和任务，计算应该调用哪些 L3 工具。
 * 纯函数，无副作用。
 */
export function computeAnalysisPlan(
  state: ToolTierState,
  phase: ReActPhase,
  taskDescription: string,
): AnalysisPlan {
  const codegraphOps: string[] = []
  const grokOps: string[] = []

  if (phase === "ANALYZE") {
    // 首轮 ANALYZE: CodeGraph 初始化 + 基础扫描
    if (state.isFirstAnalyze && !isDebounced(state, "codegraph") && !isAtLimit(state, "codegraph")) {
      codegraphOps.push("codegraph_context")
    }
    // 后续 ANALYZE: 基于任务描述搜索
    else if (!isDebounced(state, "codegraph") && !isAtLimit(state, "codegraph")) {
      codegraphOps.push("codegraph_search")
    }

    // Grok: 基于任务描述问答 (每任务仅 1 次)
    if (!isDebounced(state, "grok") && !isAtLimit(state, "grok")) {
      grokOps.push("grok_chat")
    }
  } else if (phase === "FIX") {
    // FIX 阶段: 如果引入新文件，做 impact analysis
    if (!isDebounced(state, "codegraph") && !isAtLimit(state, "codegraph")) {
      codegraphOps.push("codegraph_impact")
    }
  }

  const reason = codegraphOps.length + grokOps.length > 0
    ? `L3 proactive: ${codegraphOps.join(",")}${grokOps.length ? ", " + grokOps.join(",") : ""}`
    : "L3 skipped: debounced or at limit"

  return { codegraphOps, grokOps, reason }
}

// ============================================
// 纯函数: 结果格式化
// ============================================

/**
 * 将 L3 结果格式化为可注入 continuation prompt 的文本。
 * 截断到 RESULT_TRUNCATE_CHARS 字符。
 * 纯函数。
 */
export function formatL3Results(results: L3Results): string {
  if (results.results.length === 0) return ""

  const successfulResults = results.results.filter(r => r.success)
  if (successfulResults.length === 0 && !results.degraded) return ""

  const lines: string[] = ["## L3 Analysis Context (CodeGraph + Grok)"]
  lines.push("Use this context to inform your analysis. Do NOT repeat these calls.\n")

  for (const r of successfulResults) {
    const prefix = r.tool === "codegraph" ? "[CodeGraph]" : "[Grok]"
    lines.push(`### ${prefix} ${r.operation} (${r.elapsedMs}ms)`)
    lines.push(r.data)
    lines.push("")
  }

  if (results.degraded) {
    lines.push(`> Note: Degraded — ${results.degradeReason}`)
  }

  const full = lines.join("\n")
  if (full.length <= RESULT_TRUNCATE_CHARS) return full
  return full.slice(0, RESULT_TRUNCATE_CHARS) + "\n...(truncated)"
}

/**
 * 构建 CodeGraph 查询参数
 */
export function buildCodegraphQuery(taskDescription: string, operation: string): {
  query?: string
  symbol?: string
  maxNodes?: number
  format?: string
} {
  if (operation === "codegraph_context") {
    return { query: taskDescription.slice(0, 500), maxNodes: 10, format: "json" }
  }
  if (operation === "codegraph_search") {
    // 从任务描述提取关键词
    const keywords = taskDescription
      .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2)
      .slice(0, 5)
      .join(" ")
    return { query: keywords || taskDescription.slice(0, 200) || "code", maxNodes: 10 }
  }
  if (operation === "codegraph_impact") {
    // impact 需要 symbol，从任务描述提取可能的符号名
    const symbolMatch = taskDescription.match(/[A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?/)
    return { symbol: symbolMatch?.[0] ?? taskDescription.slice(0, 50), depth: 2 }
  }
  return {}
}

/**
 * 构建 Grok 查询参数
 */
export function buildGrokQuery(taskDescription: string): string {
  return taskDescription.slice(0, 500)
}

// ============================================
// 有副作用: 执行主动分析
// ============================================

type ToolCaller = (operation: string, params: Record<string, unknown>) => Promise<string>

/**
 * 执行 L3 主动分析。有副作用。
 *
 * @param state — 工具层级状态 (会被修改)
 * @param phase — 当前 ReAct 阶段
 * @param taskDescription — 当前任务描述
 * @param callCodegraph — CodeGraph 调用函数 (注入以支持测试)
 * @param callGrok — Grok 调用函数 (注入以支持测试)
 */
export async function executeProactiveAnalysis(
  state: ToolTierState,
  phase: ReActPhase,
  taskDescription: string,
  callCodegraph?: ToolCaller,
  callGrok?: ToolCaller,
): Promise<L3Results> {
  const plan = computeAnalysisPlan(state, phase, taskDescription)
  const results: L3Result[] = []
  let degraded = false
  let degradeReason: string | undefined

  // 执行 CodeGraph 调用
  for (const op of plan.codegraphOps) {
    if (isDebounced(state, "codegraph") || isAtLimit(state, "codegraph")) break

    const { result, degraded: d, degradeReason: dr } = await executeToolCall({
      tool: "codegraph",
      operation: op,
      params: buildCodegraphQuery(taskDescription, op),
      caller: callCodegraph,
      timeoutMs: CODEGRAPH_TIMEOUT_MS,
    })

    results.push(result)
    if (result.success) recordCall(state, "codegraph", op)
    if (d) { degraded = true; degradeReason = appendReason(degradeReason, dr) }
  }

  // 执行 Grok 调用
  for (const op of plan.grokOps) {
    if (isDebounced(state, "grok") || isAtLimit(state, "grok")) break

    const { result, degraded: d, degradeReason: dr } = await executeToolCall({
      tool: "grok",
      operation: op,
      params: { question: buildGrokQuery(taskDescription) },
      caller: callGrok,
      timeoutMs: GROK_TIMEOUT_MS,
    })

    results.push(result)
    if (result.success) recordCall(state, "grok", op)
    if (d) { degraded = true; degradeReason = appendReason(degradeReason, dr) }
  }

  return {
    results,
    codegraphCalls: results.filter(r => r.tool === "codegraph" && r.success).length,
    grokCalls: results.filter(r => r.tool === "grok" && r.success).length,
    degraded,
    degradeReason,
  }
}

// ============================================
// 辅助函数
// ============================================

/** 执行单个工具调用，带超时和错误处理 */
async function executeToolCall(opts: {
  tool: "codegraph" | "grok"
  operation: string
  params: Record<string, unknown>
  caller: ToolCaller | undefined
  timeoutMs: number
}): Promise<{ result: L3Result; degraded: boolean; degradeReason?: string }> {
  const { tool, operation, params, caller, timeoutMs } = opts
  const start = Date.now()

  if (!caller) {
    return {
      result: { tool, operation, data: "", success: false, elapsedMs: 0 },
      degraded: true,
      degradeReason: `${tool} caller not available`,
    }
  }

  try {
    const data = await withTimeout(caller(operation, params), timeoutMs)
    return {
      result: { tool, operation, data: truncate(data, 800), success: true, elapsedMs: Date.now() - start },
      degraded: false,
    }
  } catch (err) {
    return {
      result: { tool, operation, data: "", success: false, elapsedMs: Date.now() - start },
      degraded: true,
      degradeReason: `${tool} error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * 带超时的 Promise 包装。超时后正确清理 timer，无泄漏。
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + "...(truncated)"
}

function appendReason(existing: string | undefined, newReason: string | undefined): string | undefined {
  if (!newReason) return existing
  return existing ? `${existing}; ${newReason}` : newReason
}
