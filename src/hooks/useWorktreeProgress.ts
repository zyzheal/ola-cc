/**
 * Hook: useWorktreeProgress
 *
 * Periodically writes the current session's progress to a shared file
 * so other sessions (e.g., the main session) can display it.
 *
 * Usage: call useWorktreeProgress() in a root component of worktree sessions.
 */

import { useEffect, useRef, useState } from 'react'
import { writeProgress, type WorktreeProgress } from '../utils/worktreeProgress.js'

interface UseWorktreeProgressOptions {
  branch: string
  task: string
  intervalMs?: number
}

/**
 * Call this hook in worktree sessions to periodically update progress.
 * Returns a setter to update current step and progress.
 */
export function useWorktreeProgress({
  branch,
  task,
  intervalMs = 3000,
}: UseWorktreeProgressOptions): {
  setProgress: (step: string, progress: number, status?: WorktreeProgress['status']) => void
} {
  const stateRef = useRef({
    currentStep: 'initializing',
    progress: 0,
    status: 'running' as WorktreeProgress['status'],
  })

  const [tick, setTick] = useState(0)

  const setProgress = (
    step: string,
    progress: number,
    status?: WorktreeProgress['status'],
  ) => {
    stateRef.current.currentStep = step
    stateRef.current.progress = progress
    if (status) stateRef.current.status = status
    setTick(t => t + 1)
  }

  useEffect(() => {
    const write = () => {
      writeProgress({
        branch,
        task,
        currentStep: stateRef.current.currentStep,
        progress: stateRef.current.progress,
        status: stateRef.current.status,
        workdir: process.cwd(),
      })
    }

    // Write immediately on mount
    write()

    // Then periodically
    const interval = setInterval(write, intervalMs)
    return () => clearInterval(interval)
  }, [branch, task, intervalMs, tick])

  return { setProgress }
}
