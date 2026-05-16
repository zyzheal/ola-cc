// IPC protocol definitions for Daemon communication

// Request types from client to daemon
export type DaemonRequest =
  | { type: 'start_session'; prompt: string; workdir: string }
  | { type: 'list_sessions' }
  | { type: 'get_session'; id: string }
  | { type: 'kill_session'; id: string }
  | { type: 'get_logs'; id: string; tail?: number }
  | { type: 'attach_session'; id: string }
  | { type: 'ping' }

// Response types from daemon to client
export type DaemonResponse =
  | { type: 'ok'; data?: unknown }
  | { type: 'error'; message: string; code?: string }
  | { type: 'session_output'; id: string; output: string }

// Session status
export type SessionStatus = 'starting' | 'running' | 'completed' | 'failed' | 'killed'

export interface SessionInfo {
  id: string
  status: SessionStatus
  pid: number
  prompt: string
  workdir: string
  startedAt: number
  lastActivity: number
}

// Protocol version for compatibility checking
export const PROTOCOL_VERSION = 1
export const MAGIC_HEADER = 'OLACC-DAEMON'
