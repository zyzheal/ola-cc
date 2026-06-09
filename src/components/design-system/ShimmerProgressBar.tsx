import React from 'react'
import { Text, useAnimationFrame } from '../../ink.js'
import { renderShimmerBar } from '../../utils/shimmer.js'

type Props = {
  /** Progress percentage 0-100 */
  progress: number
  /** Bar width in characters (default 16) */
  width?: number
  /** Disable animation for reduced-motion users */
  reducedMotion?: boolean
}

/**
 * Animated amber shimmer progress bar.
 * Replaces the static ProgressBar for CodeGraph/Grok tool progress.
 * Uses the same renderShimmerBar + useAnimationFrame(100ms) as compact progress.
 */
export function ShimmerProgressBar({ progress, width = 16, reducedMotion = false }: Props): React.ReactNode {
  const [, time] = useAnimationFrame(reducedMotion ? null : 100)
  const frame = Math.floor(time / 100)
  return <Text>{renderShimmerBar(frame, progress, width)}</Text>
}
