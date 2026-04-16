/**
 * WorktreeProgressPills
 *
 * Renders progress pills for worktree agents running in separate Claude Code processes.
 * Displayed in the footer alongside BackgroundTaskStatus.
 */

import * as React from 'react'
import { Text, Box } from '../../ink.js'
import figures from 'figures'
import { useWorktreeProgressPoller } from '../../hooks/useWorktreeProgressPoller.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { formatDuration } from '../../utils/format.js'
import { useState } from 'react'

const SPINNER = [figures.circleDotted, figures.circle, figures.circleFilled]

function statusIcon(status: string, progress: number): React.ReactNode {
  switch (status) {
    case 'completed':
      return <Text color="green">{figures.tick}</Text>
    case 'failed':
      return <Text color="red">{figures.cross}</Text>
    default:
      return <Text color="yellow">{figures.ellipsis}</Text>
  }
}

export function WorktreeProgressPills(): React.ReactNode {
  const entries = useWorktreeProgressPoller()
  const [frame, setFrame] = useState(0)

  React.useEffect(() => {
    const interval = setInterval(() => setFrame(f => (f + 1) % SPINNER.length), 500)
    return () => clearInterval(interval)
  }, [])

  if (entries.length === 0) return null

  const pills = entries.map(entry => {
    const progressStr = entry.progress > 0 ? ` ${entry.progress}%` : ''
    const step = entry.currentStep.length > 40 ? entry.currentStep.slice(0, 40) + '…' : entry.currentStep

    return (
      <Text key={entry.branch}>
        <Text dimColor>·</Text>{' '}
        {statusIcon(entry.status, entry.progress)}{' '}
        <Text bold>{entry.branch}</Text>
        <Text dimColor>{progressStr}</Text>
        {' '}
        <Text dimColor color="yellow">{SPINNER[frame]}</Text>
        {' '}
        <Text dimColor>{step}</Text>
      </Text>
    )
  })

  return (
    <Box flexDirection="column">
      <Text dimColor>worktree agents:</Text>
      <Box flexWrap="wrap">{pills}</Box>
    </Box>
  )
}
