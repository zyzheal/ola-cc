/**
 * Shimmer — amber-orange color gradient utility
 *
 * Ported from codegraph's shimmer-worker.ts for progress bar visual effects.
 * Uses lerp + sin wave for dependency-free color animation.
 *
 * Color range: RGB(160,100,9) ↔ RGB(251,191,36) — amber to bright orange
 * Position cycle: 24 frames (~1.2s at 100ms tick)
 */

const AMBER = { r: 160, g: 100, b: 9 }
const ORANGE = { r: 251, g: 191, b: 36 }

/**
 * Compute shimmer color for a given frame.
 * Returns RGB values using sin wave interpolation between amber and orange.
 * Period matches the position cycle (24 frames) so color and position sync.
 */
export function shimmerColor(frame: number): { r: number; g: number; b: number } {
  const t = (Math.sin(frame * 2 * Math.PI / 24) + 1) / 2
  return {
    r: Math.round(AMBER.r + (ORANGE.r - AMBER.r) * t),
    g: Math.round(AMBER.g + (ORANGE.g - AMBER.g) * t),
    b: Math.round(AMBER.b + (ORANGE.b - AMBER.b) * t),
  }
}

/**
 * Render a shimmer progress bar with amber-orange gradient.
 *
 * @param frame - Current animation frame (drives shimmer position)
 * @param percent - Progress percentage (0-100)
 * @param width - Bar width in characters (default 25)
 * @returns ANSI-colored progress bar string
 */
export function renderShimmerBar(
  frame: number,
  percent: number,
  width: number = 25,
): string {
  width = Math.max(0, width)
  if (width === 0) return ''
  const clampedPercent = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clampedPercent / 100) * width)
  const empty = width - filled

  // Shimmer light moves across the filled portion
  const shimmerPos = ((frame % 24) / 24) * (filled + 6) - 3
  const shimmerWidth = 3

  // Uniform color for the entire shimmer glow (no per-character offset)
  const glowColor = shimmerColor(frame)

  let bar = ''
  for (let i = 0; i < filled; i++) {
    const dist = Math.abs(i - shimmerPos)
    const t = Math.max(0, 1 - dist / shimmerWidth)
    if (t > 0) {
      bar += `\x1b[38;2;${glowColor.r};${glowColor.g};${glowColor.b}m\x1b[1m█\x1b[0m`
    } else {
      bar += '█'
    }
  }
  bar += `\x1b[2m${'░'.repeat(empty)}\x1b[0m`
  return bar
}
