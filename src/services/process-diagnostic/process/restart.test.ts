import { describe, it, expect } from 'bun:test'
import { countRestarts } from './restart'
import type { ProcessInfo } from '../types'

function makeProcess(overrides: Partial<ProcessInfo> & { pid: number }): ProcessInfo {
  return {
    pid: overrides.pid,
    ppid: overrides.ppid ?? 0,
    command: overrides.command ?? `proc-${overrides.pid}`,
    cmdline: overrides.cmdline ?? '',
    exe: overrides.exe ?? '',
    startedAt: overrides.startedAt ?? new Date(),
    user: overrides.user ?? 'root',
    cpuPercent: 0,
    memoryRSS: 0,
    workingDir: '',
    sockets: [],
    health: 'healthy',
    exeDeleted: false,
    ...overrides,
  }
}

describe('countRestarts', () => {
  it('should return 0 for single process', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'pm2' }),
      makeProcess({ pid: 200, ppid: 100, command: 'node' }),
    ]
    expect(countRestarts(ancestry, 'node')).toBe(0)
  })

  it('should count consecutive same-command processes', () => {
    // Supervisor restarts node: [init, pm2, node(restart1), node(restart2)]
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'pm2' }),
      makeProcess({ pid: 200, ppid: 100, command: 'node', startedAt: new Date(Date.now() - 60000) }),
      makeProcess({ pid: 300, ppid: 100, command: 'node' }),
    ]
    expect(countRestarts(ancestry, 'node')).toBe(1)
  })

  it('should skip shell intermediaries', () => {
    // Chain: [init, pm2, bash, node, bash, node] — shells are skipped
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'pm2' }),
      makeProcess({ pid: 150, ppid: 100, command: 'bash', exe: '/bin/bash' }),
      makeProcess({ pid: 200, ppid: 150, command: 'node' }),
      makeProcess({ pid: 250, ppid: 200, command: 'bash', exe: '/bin/bash' }),
      makeProcess({ pid: 300, ppid: 250, command: 'node' }),
    ]
    // After skipping shells: [pm2, node, node] → count = 2 → restarts = 1
    expect(countRestarts(ancestry, 'node')).toBe(1)
  })

  it('should stop at different command', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'pm2' }),
      makeProcess({ pid: 200, ppid: 100, command: 'python' }),
      makeProcess({ pid: 300, ppid: 200, command: 'node' }),
    ]
    expect(countRestarts(ancestry, 'node')).toBe(0)
  })

  it('should return 0 for empty ancestry', () => {
    expect(countRestarts([], 'node')).toBe(0)
  })

  it('should handle multiple restarts', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'node', startedAt: new Date(Date.now() - 120000) }),
      makeProcess({ pid: 200, ppid: 1, command: 'node', startedAt: new Date(Date.now() - 60000) }),
      makeProcess({ pid: 300, ppid: 1, command: 'node' }),
    ]
    expect(countRestarts(ancestry, 'node')).toBe(2)
  })
})
