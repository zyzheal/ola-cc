/**
 * TerminalProgress — Direct terminal progress animation
 *
 * Bypasses Ink/React rendering pipeline to write ANSI escape codes
 * directly to stderr. Matches codegraph's shimmer-worker architecture.
 *
 * Key design:
 * - 50ms render loop (20 FPS), independent of React's render cycle
 * - ANSI truecolor (38;2;r;g;b) for smooth gradient transitions
 * - Shimmer: sine-wave RGB oscillation (160,100,9)→(251,191,36)
 * - Moving highlight band (width=3) sweeps across progress bar
 * - Phase-aware: scanning → parsing → resolving → done
 */

import { writeSync } from 'fs'

// ANSI escape codes — matching codegraph exactly
const RST = '\x1b[0m'
const DM = '\x1b[2m'
const GRN = '\x1b[32m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const CLEAR_LINE = '\r\x1b[K'

// Spinner glyphs — matching codegraph's UNICODE_GLYPHS.spinner
const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽']
const BAR_FILLED = '█'
const BAR_EMPTY = '░'
const PHASE_DONE = '◆'
const PHASE_ERR = '✗'
const RAIL = '│'

// Match codegraph: 50ms render interval (20 FPS), 150ms per glyph
const ANIM_INTERVAL = 50
const FRAMES_PER_GLYPH = 3

export interface ProgressPhase {
  name: string
  label: string
  percent?: number   // 0-100, undefined for indeterminate
  count?: number     // e.g. "1234 files found"
  detail?: string    // extra detail text
}

export interface TerminalProgressHandle {
  update(phase: ProgressPhase): void
  finishPhase(label?: string): void
  error(label: string): void
  stop(): void
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

function shimmerColor(frame: number): string {
  const t = (Math.sin(frame * 2 * Math.PI / 13) + 1) / 2
  const r = lerp(160, 251, t)
  const g = lerp(100, 191, t)
  const b = lerp(9, 36, t)
  return `\x1b[38;2;${r};${g};${b}m${BOLD}`
}

function renderBar(frame: number, filled: number, empty: number): string {
  if (filled === 0) return `${DM}${BAR_EMPTY.repeat(empty)}${RST}`
  const cycleFrames = 24
  const shimmerPos = ((frame % cycleFrames) / cycleFrames) * (filled + 6) - 3
  const shimmerWidth = 3
  let bar = ''
  for (let i = 0; i < filled; i++) {
    const dist = Math.abs(i - shimmerPos)
    const t = Math.max(0, 1 - dist / shimmerWidth)
    const r = lerp(160, 251, t)
    const g = lerp(100, 191, t)
    const b = lerp(9, 36, t)
    bar += `\x1b[38;2;${r};${g};${b}m${BOLD}${BAR_FILLED}`
  }
  bar += `${RST}${DM}${BAR_EMPTY.repeat(empty)}${RST}`
  return bar
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

/**
 * Create a terminal progress renderer.
 *
 * @param toolName - Display name (e.g. "CodeGraph", "Grok")
 * @returns Handle to update/stop the progress
 */
export function createTerminalProgress(toolName: string): TerminalProgressHandle {
  const startTime = Date.now()
  let currentPhase: ProgressPhase | null = null
  let stopped = false
  let tickTimer: ReturnType<typeof setInterval> | null = null

  function writeStderr(s: string): void {
    writeSync(2, s)
  }

  function animFrame(): number {
    return Math.floor((Date.now() - startTime) / ANIM_INTERVAL)
  }

  function render(): void {
    if (stopped || !currentPhase) return
    const frame = animFrame()
    const glyphIdx = Math.floor(frame / FRAMES_PER_GLYPH) % SPINNER_GLYPHS.length
    const glyph = SPINNER_GLYPHS[glyphIdx] ?? SPINNER_GLYPHS[0] ?? '.'
    const color = shimmerColor(frame)

    let line: string
    const label = currentPhase.label || currentPhase.name

    if (currentPhase.percent != null && currentPhase.percent >= 0) {
      // Match codegraph: barWidth=25
      const barWidth = 25
      const filled = Math.round(barWidth * currentPhase.percent / 100)
      const empty = barWidth - filled
      const detail = currentPhase.detail ? ` ${DM}${currentPhase.detail}${RST}` : ''
      // Format: │  ✶ label  ▓▓▓▓░░░░  45%
      line = `${DM}${RAIL}${RST}  ${color}${glyph}${RST} ${label}  ${renderBar(frame, filled, empty)}  ${currentPhase.percent}%${detail}`
    } else if (currentPhase.count != null && currentPhase.count > 0) {
      // Format: │  ✶ label... 1,234 found
      line = `${DM}${RAIL}${RST}  ${color}${glyph}${RST} ${label}... ${formatNumber(currentPhase.count)} found`
    } else {
      // Format: │  ✶ label...
      line = `${DM}${RAIL}${RST}  ${color}${glyph}${RST} ${label}...`
    }

    writeStderr(`${CLEAR_LINE}${line}`)
  }

  // Start render loop
  tickTimer = setInterval(render, ANIM_INTERVAL)

  return {
    update(phase: ProgressPhase) {
      currentPhase = phase
    },

    finishPhase(label?: string) {
      if (!currentPhase && !label) return
      const phaseLabel = label || currentPhase?.label || currentPhase?.name || ''
      writeStderr(CLEAR_LINE)
      // Match codegraph: │  ◆ label — done
      let detail = ''
      if (currentPhase?.percent != null) detail = ` ${DM}— done${RST}`
      else if (currentPhase?.count != null && currentPhase.count > 0) detail = ` ${DM}— ${formatNumber(currentPhase.count)} found${RST}`
      writeStderr(`${DM}${RAIL}${RST}  ${GRN}${PHASE_DONE}${RST} ${phaseLabel}${detail}\n`)
      currentPhase = null
    },

    error(label: string) {
      writeStderr(CLEAR_LINE)
      writeStderr(`${DM}${RAIL}${RST}  ${RED}${PHASE_ERR}${RST} ${label}\n`)
      currentPhase = null
    },

    stop() {
      if (stopped) return
      stopped = true
      if (tickTimer) {
        clearInterval(tickTimer)
        tickTimer = null
      }
      // Clear the progress line
      writeStderr(CLEAR_LINE)
    },
  }
}
