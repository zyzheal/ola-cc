/**
 * Hook: useWorktreeProgressPoller
 *
 * Polls the shared progress file and returns active worktree entries.
 * Used by the main session to display worktree agent progress in the footer.
 */

import { useEffect, useState } from 'react'
import { readAllProgress, pruneStaleProgress, type WorktreeProgress } from '../utils/worktreeProgress.js'

const POLL_INTERVAL = 2000
const STALE_MS = 5 * 60 * 1000 // 5 minutes

export function useWorktreeProgressPoller(): WorktreeProgress[] {
  const [entries, setEntries] = useState<WorktreeProgress[]>([])

  useEffect(() => {
    const poll = () => {
      const all = readAllProgress()
      const active = pruneStaleProgress(all, STALE_MS)
      setEntries(active)
    }

    poll()
    const interval = setInterval(poll, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [])

  return entries
}
