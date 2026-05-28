/**
 * goalReActObserver — ReAct 阶段可观测协议
 *
 * 从 toolCalls 推断当前 ReAct 阶段（ANALYZE/SKILL/REVIEW/FIX/VERIFY），
 * 从 outputSummary 提取质量信号（error/success/progress）。
 *
 * 纯函数，<1ms，无副作用。
 *
 * 设计参考: docs/superpowers/specs/2026-05-28-goal-react-orchestrator-design.md §4.2
 */

// ============================================
// 类型定义
// ============================================

export type ReActPhase = "ANALYZE" | "SKILL" | "REVIEW" | "FIX" | "VERIFY"

export interface QualitySignals {
  hasErrors: boolean
  hasSuccess: boolean
  hasProgress: boolean
}

export interface ReActObservation {
  phases: ReActPhase[]
  mainPhase: ReActPhase | null
  phaseTools: Map<ReActPhase, string[]>
  qualitySignals: QualitySignals
}

// ============================================
// 常量
// ============================================

/** 工具名 → ReAct 阶段的静态映射。新增工具只需加一行。 */
export const TOOL_PHASE_MAP: Record<string, ReActPhase> = {
  // ANALYZE 阶段
  Read: "ANALYZE",
  Glob: "ANALYZE",
  Grep: "ANALYZE",
  codegraph: "ANALYZE",
  grok: "ANALYZE",
  // SKILL 阶段
  Skill: "SKILL",
  SkillTool: "SKILL",
  // REVIEW 阶段
  Agent: "REVIEW",
  AgentTool: "REVIEW",
  // FIX 阶段
  Edit: "FIX",
  Write: "FIX",
  FileEdit: "FIX",
  FileWrite: "FIX",
  // VERIFY 阶段
  Bash: "VERIFY",
  // 不参与阶段推断
  TodoWrite: "ANALYZE",
  update_goal: "VERIFY",
}

/**
 * Fallback strategy for unknown tools (MCP, dynamic tools).
 * Infers ReAct phase from tool name patterns.
 */
function inferPhaseFromName(toolName: string): ReActPhase {
  const lower = toolName.toLowerCase()
  if (lower.includes("test") || lower.includes("verify") || lower.includes("check")) return "VERIFY"
  if (lower.includes("fix") || lower.includes("repair") || lower.includes("patch")) return "FIX"
  if (lower.includes("review") || lower.includes("audit") || lower.includes("lint")) return "REVIEW"
  if (lower.includes("build") || lower.includes("compile") || lower.includes("deploy")) return "SKILL"
  return "ANALYZE"
}

// ============================================
// 核心函数
// ============================================

/**
 * 从 toolCalls 推断 ReAct 阶段。
 * 纯函数，<1ms。
 */
export function inferReActPhases(toolCalls: string[]): Omit<ReActObservation, "qualitySignals"> {
  const phaseTools = new Map<ReActPhase, string[]>()
  for (const tool of toolCalls) {
    const phase = TOOL_PHASE_MAP[tool] ?? inferPhaseFromName(tool)
    if (!phaseTools.has(phase)) phaseTools.set(phase, [])
    phaseTools.get(phase)!.push(tool)
  }
  const phases = [...phaseTools.keys()]
  const mainPhase =
    phases.sort(
      (a, b) => (phaseTools.get(b)?.length ?? 0) - (phaseTools.get(a)?.length ?? 0),
    )[0] ?? null

  return { phases, mainPhase, phaseTools }
}

/**
 * 从 outputSummary 提取质量信号。关键词匹配，<1ms。
 *
 * hasErrors 使用负向环视排除 "no error" / "no errors" 等否定语境。
 */
export function extractQualitySignals(outputSummary: string): QualitySignals {
  const lower = (outputSummary ?? "").toLowerCase()
  // 先移除否定语境再匹配，避免 "no error" / "no errors" 假阳性
  const errorText = lower.replace(/no errors?/g, "")
  return {
    hasErrors: /error|failed|cannot|exception|crash/.test(errorText),
    hasSuccess: /success|completed|passed|build complete|all tests pass/.test(lower),
    hasProgress: /created|added|fixed|updated|implemented|resolved/.test(lower),
  }
}

/**
 * 完整观测一轮。挂载到 GoalRuntimeState.lastObservation。
 */
export function observeTurn(toolCalls: string[], outputSummary: string): ReActObservation {
  const partial = inferReActPhases(toolCalls)
  return {
    ...partial,
    qualitySignals: extractQualitySignals(outputSummary),
  }
}
