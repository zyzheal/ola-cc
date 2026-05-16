import * as React from 'react'
import { useCallback, useMemo, useState, useEffect } from 'react'
import figures from 'figures'
import { Box, Text } from '../../ink.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Dialog } from '../design-system/Dialog.js'
import type { SessionEntry } from '../../daemon/sessionRegistry.js'

type Props = {
  onExit: (result?: string) => void
}

type SessionGroup = {
  label: string
  sessions: SessionEntry[]
  color: string
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString()
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function renderSessionItem(session: SessionEntry, isSelected: boolean): React.ReactNode {
  const statusColor =
    session.status === 'running' ? 'green' :
    session.status === 'completed' ? 'cyan' :
    session.status === 'killed' ? 'yellow' :
    'red'

  const duration = formatDuration(Date.now() - session.startedAt)
  const promptText = session.prompt.length > 50 ? session.prompt.slice(0, 47) + '...' : session.prompt

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Box>
        <Text color={isSelected ? 'suggestion' : undefined}>
          {isSelected ? `${figures.pointer} ` : '  '}
        </Text>
        <Text color={statusColor}>[{session.status}]</Text>
        <Text dimColor> {session.id.slice(0, 12)}...</Text>
      </Box>
      <Box paddingLeft={isSelected ? 2 : 4}>
        <Text>{promptText}</Text>
      </Box>
      <Box paddingLeft={isSelected ? 2 : 4}>
        <Text dimColor>PID: {session.pid} | Duration: {duration} | Started: {formatTimestamp(session.startedAt)}</Text>
      </Box>
    </Box>
  )
}

export function BgSessionView({ onExit }: Props): React.ReactNode {
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [selectedSession, setSelectedSession] = useState<SessionEntry | null>(null)
  const [logs, setLogs] = useState<string | null>(null)

  // Load sessions
  const loadSessions = useCallback(async () => {
    try {
      const { listSessions, cleanupDeadSessions } = await import('../../daemon/sessionRegistry.js')
      await cleanupDeadSessions()
      const allSessions = await listSessions()
      allSessions.sort((a, b) => b.startedAt - a.startedAt)
      setSessions(allSessions)
    } catch {
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // Group sessions by status
  const groups = useMemo<SessionGroup[]>(() => {
    const running = sessions.filter(s => s.status === 'running')
    const completed = sessions.filter(s => s.status === 'completed')
    const killed = sessions.filter(s => s.status === 'killed')
    const failed = sessions.filter(s => s.status === 'failed')

    const result: SessionGroup[] = []
    if (running.length > 0) result.push({ label: 'Running', sessions: running, color: 'green' })
    if (completed.length > 0) result.push({ label: 'Completed', sessions: completed, color: 'cyan' })
    if (killed.length > 0) result.push({ label: 'Killed', sessions: killed, color: 'yellow' })
    if (failed.length > 0) result.push({ label: 'Failed', sessions: failed, color: 'red' })
    return result
  }, [sessions])

  // Flatten for selection
  const flatSessions = useMemo(() => groups.flatMap(g => g.sessions), [groups])

  // Keyboard handling
  const handleKeyPress = useCallback((key: { name: string }) => {
    if (logs !== null) {
      setLogs(null)
      return
    }

    if (key.name === 'up' || key.name === 'k') {
      setSelectedIndex(prev => Math.max(0, prev - 1))
    } else if (key.name === 'down' || key.name === 'j') {
      setSelectedIndex(prev => Math.min(flatSessions.length - 1, prev + 1))
    } else if (key.name === 'return' || key.name === 'enter') {
      const session = flatSessions[selectedIndex]
      if (session) {
        setSelectedSession(session)
      }
    } else if (key.name === 'r') {
      setLoading(true)
      loadSessions()
    } else if (key.name === 'escape') {
      if (selectedSession) {
        setSelectedSession(null)
      } else {
        onExit()
      }
    } else if (key.name === 'q') {
      onExit()
    }
  }, [flatSessions, selectedIndex, logs, selectedSession, loadSessions, onExit])

  useExitOnCtrlCDWithKeybindings(handleKeyPress)

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text>Loading sessions...</Text>
      </Box>
    )
  }

  // Show logs for selected session
  if (logs !== null && selectedSession) {
    const logLines = logs.split('\n').slice(-40)
    return (
      <Box flexDirection="column" width="100%" height="100%">
        <Box flexDirection="column">
          <Text bold color="cyan">Logs for {selectedSession.id}</Text>
          <Text dimColor>Press any key to go back</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {logLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      </Box>
    )
  }

  if (groups.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>No background sessions.</Text>
        <Text dimColor>Use `ola-cc --bg "prompt"` to start one.</Text>
        <Text dimColor>Press q or Ctrl+C to exit.</Text>
      </Box>
    )
  }

  return (
    <Dialog title="Background Sessions" footer="j/k: navigate | enter: details | l: logs | r: refresh | q: quit">
      <Box flexDirection="column">
        {groups.map((group, gi) => (
          <Box key={group.label} flexDirection="column">
            <Box paddingX={1}>
              <Text bold color={group.color}>{figures.arrowRight} {group.label} ({group.sessions.length})</Text>
            </Box>
            {group.sessions.map((session) => {
              const flatIdx = flatSessions.indexOf(session)
              const isSelected = flatIdx === selectedIndex
              return renderSessionItem(session, isSelected)
            })}
          </Box>
        ))}
      </Box>
    </Dialog>
  )
}
