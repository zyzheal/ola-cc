import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { ThreadGoalStatus } from '../../commands/goal/types.js'
import type { GoalTask, TurnRecord } from '../../commands/goal/types.js'

// 错误边界组件
class GoalProgressErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: string }
> {
  state = { hasError: false, error: undefined }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[GoalProgress Error]', error.message)
    this.setState({ hasError: true, error: error.message.slice(0, 100) })
  }

  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}

// ── Constants ──

const STATUS_EMOJI: Record<string, string> = {
  active: '🎯',
  paused: '⏸️',
  budget_limited: '⚠️',
  complete: '✅',
}

const STATUS_COLORS: Record<string, string> = {
  active: 'cyan',
  paused: 'yellow',
  budget_limited: 'red',
  complete: 'green',
}

const PHASE_COLORS: Record<string, string> = {
  ANALYZE: 'blue',
  SKILL: 'magenta',
  REVIEW: 'yellow',
  FIX: 'cyan',
  VERIFY: 'green',
}

const SCENARIO_LABELS: Record<string, string> = {
  code_change: 'code_change',
  doc_writing: 'doc_writing',
  troubleshooting: 'troubleshooting',
  design_improve: 'design_improve',
  refactoring: 'refactoring',
}

const SCENARIO_PREFERRED_SKILLS: Record<string, string[]> = {
  code_change: ['test-driven-development', 'verification', 'feature-dev'],
  doc_writing: ['design-doc-reviewer', 'docs-navigator', 'writing-plans'],
  troubleshooting: ['systematic-debugging', 'orion-deep-audit', 'orion-repairing'],
  design_improve: ['brainstorming', 'design-constraint', 'code-design-analyzer'],
  refactoring: ['simplify', 'design-constraint', 'test-driven-development'],
}

// ── Helpers ──

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins < 60) return `${mins}m ${secs}s`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  return `${hours}h ${remainMins}m ${secs}s`
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString()
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(tokens < 10000 ? 1 : 0)}k`
  return `${(tokens / 1000000).toFixed(1)}M`
}

function progressBar(progress: number, width: number = 20): string {
  const clamped = Math.max(0, Math.min(100, progress))
  const filled = Math.round((clamped / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** Render trend arrows for a numeric array */
function trend(values: number[], maxItems: number = 3): string {
  const recent = values.slice(-maxItems)
  if (recent.length === 0) return '—'
  return recent
    .map((v, i) => {
      const formatted = v < 1 ? v.toFixed(2) : Math.round(v).toString()
      if (i === recent.length - 1) {
        if (recent.length > 1) {
          const prev = recent[i - 1]
          if (v > prev * 1.1) return `${formatted}↑`
          if (v < prev * 0.9) return `${formatted}↓`
        }
        return `${formatted}`
      }
      return formatted
    })
    .join('→')
}

/** Truncate string to maxLen, adding ellipsis */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + '…'
}

/** Separator line for section headers */
function sectionLabel(label: string): string {
  const lineLen = 72 - label.length - 3
  return `── ${label} ${'─'.repeat(Math.max(0, lineLen))}`
}

/** Compute avg turn time from turnBuffer */
function avgTurnTime(turnBuffer: TurnRecord[]): number | null {
  const completed = turnBuffer.filter(t => t.wallEndMs > t.wallStartMs)
  if (completed.length === 0) return null
  const totalMs = completed.reduce((sum, t) => sum + (t.wallEndMs - t.wallStartMs), 0)
  return totalMs / completed.length / 1000 // seconds
}

// Stable empty array reference to avoid re-renders from ?? []
const EMPTY_STRING_ARRAY: string[] = []

// ── Main Component ──

export function GoalProgress() {
  // ── Goal core state ──
  const goalStatus = useAppState(s => s.goal?.status ?? '')
  const goalObjective = useAppState(s => s.goal?.objective ?? '')
  const goalTokenBudget = useAppState(s => s.goal?.tokenBudget ?? null)
  const goalTokensUsed = useAppState(s => s.goal?.tokensUsed ?? 0)
  const goalTimeUsedSeconds = useAppState(s => s.goal?.timeUsedSeconds ?? 0)
  const goalTotalApiTokens = useAppState(s => s.goal?.totalApiTokens ?? 0)
  const goalMode = useAppState(s => s.goal?.mode ?? 'standard')
  const goalAutoEdit = useAppState(s => s.goal?.autoEdit ?? false)

  // ── Runtime state ──
  const consecutiveErrors = useAppState(s => s.goalRuntime?.consecutiveErrors ?? 0)
  const turnsWithNoChanges = useAppState(s => s.goalRuntime?.turnsWithNoChanges ?? 0)
  const lastAnalysisResult = useAppState(s => s.goalRuntime?.lastAnalysisResult)
  const consecutiveCritical = useAppState(s => s.goalRuntime?.consecutiveCritical ?? 0)
  const toolCallsThisTurn = useAppState(s => s.goalRuntime?._toolCallsThisTurn ?? EMPTY_STRING_ARRAY)
  const turnBuffer = useAppState(s => s.goalRuntime?.turnBuffer ?? EMPTY_STRING_ARRAY as unknown as TurnRecord[])

  // ── Orchestrator state (v3 — graceful degradation) ──
  const currentScenario = useAppState(s => s.goalRuntime?.currentScenario)
  const convergenceState = useAppState(s => s.goalRuntime?.convergenceState)
  const lastObservation = useAppState(s => s.goalRuntime?.lastObservation)
  const errorTracker = useAppState(s => s.goalRuntime?.errorTracker)

  // ── Task state ──
  const goalTasks = useAppState(s => {
    const taskListId = s.goal?.goalTaskListId
    if (!taskListId) return null
    return s.goalTasks?.[taskListId] ?? null
  })
  const todoListId = useAppState(s => s.goal?.todoListId ?? undefined)
  const todos = useAppState(s => {
    if (!todoListId) return null
    return s.todos?.[todoListId] ?? null
  })

  // Hide when complete
  if (goalStatus === ThreadGoalStatus.Complete) return null

  // ── Derived values ──
  const statusKey = goalStatus as string
  const emoji = STATUS_EMOJI[statusKey] ?? '📌'
  const color = STATUS_COLORS[statusKey] ?? 'gray'

  type TaskItem = { status?: string; content?: string; id?: string }
  const taskItems: TaskItem[] = (goalTasks ?? (todos ?? [])) as TaskItem[]
  const currentTask = taskItems.find(t => t.status === 'in_progress')
  const nextTask = taskItems.find(t => t.status === 'pending')
  const completedTasks = taskItems.filter(t => t.status === 'completed').length
  const totalTasks = taskItems.length
  const taskProgress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  const displayTokens = Math.max(0, goalTotalApiTokens > 0 ? goalTotalApiTokens : goalTokensUsed)
  const budgetProgress = goalTokenBudget != null && goalTokenBudget > 0
    ? Math.max(0, Math.min(100, (displayTokens / goalTokenBudget) * 100))
    : 0
  const remaining = goalTokenBudget != null ? goalTokenBudget - displayTokens : null

  // Orchestrator-derived labels
  const scenarioLabel = currentScenario ? (SCENARIO_LABELS[currentScenario] ?? currentScenario) : null
  const mainPhase = lastObservation?.mainPhase ?? null
  const round = convergenceState?.round
  const maxRounds = 5 // default, would come from scenario config
  const recoveryLayer = errorTracker?.recoveryLayer ?? null

  // Quality signals for display
  const signals: string[] = []
  if (lastObservation?.qualitySignals?.hasProgress) signals.push('progress')
  if (lastObservation?.qualitySignals?.hasSuccess) signals.push('success')
  if (lastObservation?.qualitySignals?.hasErrors) signals.push('errors')

  // Convergence status text
  const ig = convergenceState?.informationGains
  const qs = convergenceState?.qualityScores
  const cm = convergenceState?.changeMagnitudes
  const qualityMet = qs && qs.length > 0 && qs[qs.length - 1] >= 80
  const igLow = ig && ig.length >= 2 && ig.slice(-2).every(g => g < 0.15)
  let convergenceStatus: string | null = null
  if (ig && qs && cm && round) {
    if (igLow && qualityMet) convergenceStatus = 'ready to converge'
    else if (qualityMet) convergenceStatus = 'quality gate passed, waiting for IG drop'
    else if (igLow) convergenceStatus = 'IG low, waiting for quality'
    else convergenceStatus = 'converging'
  }

  // Per-turn stats
  const avgTime = avgTurnTime(Array.isArray(turnBuffer) ? turnBuffer : [])

  // Recovery status
  const recoveryOk = !recoveryLayer || recoveryLayer === 'FIX_RETRY'

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      {/* ═══ Header ═══ */}
      <Box>
        <Text color={color}>{emoji} </Text>
        <Text bold color={color}>{truncate(goalObjective, 40)}</Text>
        {scenarioLabel && <Text color="magenta">  {scenarioLabel}</Text>}
        {mainPhase && <Text color={PHASE_COLORS[mainPhase] ?? 'white'}>  {mainPhase} ▶</Text>}
        {round != null && <Text dimColor>  R{round}/{maxRounds}</Text>}
        <Text dimColor>  {formatDuration(goalTimeUsedSeconds)}</Text>
      </Box>
      <Box>
        <Text dimColor>{goalMode}</Text>
        {goalAutoEdit && <Text dimColor> | auto-edit</Text>}
        <Text dimColor> | </Text>
        <Text color={recoveryOk ? 'green' : 'yellow'}>
          {recoveryOk ? 'recovery OK' : `recovery: ${recoveryLayer}`}
        </Text>
        {errorTracker && Object.values(errorTracker.categories).some(c => c.count > 0) && (
          <Text color="red">
            {' | errors: '}
            {Object.entries(errorTracker.categories)
              .filter(([_, c]) => c.count > 0)
              .map(([cat, c]) => `${cat}:${c.count}/${c.threshold}`)
              .join(' ')}
          </Text>
        )}
        {consecutiveErrors > 0 && !errorTracker && (
          <Text color="red"> | errors: {consecutiveErrors}/3</Text>
        )}
        {turnsWithNoChanges > 0 && (
          <Text color="yellow"> | dead turns: {turnsWithNoChanges}</Text>
        )}
      </Box>

      {/* ═══ Tasks ═══ */}
      {totalTasks > 0 && (
        <Box flexDirection="column">
          <Box><Text dimColor>{sectionLabel('Tasks')}</Text></Box>
          {/* Task items with status icons */}
          <Box flexDirection="column">
            {taskItems.slice(0, 6).map((t, i) => {
              const icon = t.status === 'completed' ? '✓'
                : t.status === 'in_progress' ? '▶'
                : t.status === 'skipped' ? '⊘'
                : '○'
              const textColor = t.status === 'completed' ? 'green'
                : t.status === 'in_progress' ? 'cyan'
                : t.status === 'skipped' ? 'yellow'
                : undefined
              return (
                <Box key={t.id ?? i}>
                  <Text color={textColor}> {icon} {truncate(t.content ?? '', 50)}</Text>
                </Box>
              )
            })}
          </Box>
          {/* Progress bar */}
          <Box>
            <Text dimColor> {completedTasks}/{totalTasks} [{progressBar(taskProgress, 20)}] {taskProgress}%</Text>
          </Box>
        </Box>
      )}

      {/* ═══ Active Phase (orchestrator data) ═══ */}
      {mainPhase && lastObservation && (
        <Box flexDirection="column">
          <Box><Text dimColor>{sectionLabel(`Active: ${mainPhase}`)}</Text></Box>
          <Box>
            <Text dimColor>Tools: </Text>
            <Text>{toolCallsThisTurn.length > 0
              ? [...new Set(toolCallsThisTurn)].map(t => {
                  const count = toolCallsThisTurn.filter(x => x === t).length
                  return count > 1 ? `${t}(${count})` : t
                }).join(' ')
              : '—'
            }</Text>
            {signals.length > 0 && (
              <Text dimColor> | {signals.map(s =>
                s === 'progress' ? '✓ progress' : s === 'success' ? '✓ success' : '✗ errors'
              ).join(' ')}</Text>
            )}
          </Box>
        </Box>
      )}

      {/* ═══ Convergence (orchestrator data) ═══ */}
      {convergenceState && (
        <Box flexDirection="column">
          <Box><Text dimColor>{sectionLabel('Convergence')}</Text></Box>
          <Box>
            <Text dimColor>IG: </Text>
            <Text color={(ig && ig.length > 0 && ig[ig.length - 1] < 0.15) ? 'green' : 'yellow'}>
              {ig ? trend(ig) : '—'}
            </Text>
            <Text dimColor>  QS: </Text>
            <Text color={qualityMet ? 'green' : 'yellow'}>
              {qs ? trend(qs) : '—'}
            </Text>
            <Text dimColor>  CM: </Text>
            <Text>{cm ? trend(cm) : '—'}</Text>
          </Box>
          {convergenceStatus && (
            <Box>
              <Text dimColor>{convergenceStatus}</Text>
            </Box>
          )}
        </Box>
      )}

      {/* ═══ Budget ═══ */}
      <Box flexDirection="column">
        <Box><Text dimColor>{sectionLabel('Budget')}</Text></Box>
        <Box>
          <Text>{formatTokens(displayTokens)}</Text>
          {goalTokenBudget != null ? (
            <Box>
              <Text dimColor> / {formatTokens(goalTokenBudget)}</Text>
              <Text dimColor> [{progressBar(budgetProgress, 20)}]</Text>
              <Text dimColor> {Math.round(budgetProgress)}%</Text>
              {remaining != null && (
                <Text dimColor>  Remain: {formatTokens(remaining)}</Text>
              )}
            </Box>
          ) : (
            <Text dimColor> (unbounded)</Text>
          )}
        </Box>
        {avgTime != null && (
          <Box>
            <Text dimColor>avg {avgTime.toFixed(1)}s/turn</Text>
          </Box>
        )}
      </Box>

      {/* ═══ Skills (orchestrator data) ═══ */}
      {currentScenario && (
        <Box flexDirection="column">
          <Box><Text dimColor>{sectionLabel('Skills')}</Text></Box>
          <Box>
            <Text>
              {(SCENARIO_PREFERRED_SKILLS[currentScenario] ?? []).slice(0, 3).map((s, i) => (
                <React.Fragment key={s}>
                  {i > 0 && <Text dimColor>  </Text>}
                  <Text color="blue">{s}</Text>
                </React.Fragment>
              ))}
            </Text>
          </Box>
        </Box>
      )}

      {/* ═══ Legacy: Analysis result (backward compat) ═══ */}
      {lastAnalysisResult && !convergenceState && (
        <Box>
          <Text color="yellow">Analysis: </Text>
          <Text dimColor>{truncate(lastAnalysisResult, 60)}</Text>
          {consecutiveCritical > 0 && (
            <Text color="red"> ({consecutiveCritical}/3 critical)</Text>
          )}
        </Box>
      )}
    </Box>
  )
}

// 包装导出，带错误边界
export function GoalProgressWithBoundary() {
  return (
    <GoalProgressErrorBoundary>
      <GoalProgress />
    </GoalProgressErrorBoundary>
  )
}
