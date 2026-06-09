import { describe, it, expect, mock } from 'bun:test'
import type { PlatformOps } from '../platform/types'
import type { ProcessInfo } from '../types'

function makeProcess(overrides: Partial<ProcessInfo> & { pid: number }): ProcessInfo {
  return {
    pid: overrides.pid,
    ppid: overrides.ppid ?? 0,
    command: overrides.command ?? `proc-${overrides.pid}`,
    cmdline: overrides.cmdline ?? '',
    exe: overrides.exe ?? '',
    startedAt: overrides.startedAt ?? new Date(),
    user: overrides.user ?? 'heal',
    cpuPercent: overrides.cpuPercent ?? 5,
    memoryRSS: overrides.memoryRSS ?? 100 * 1024 * 1024,
    workingDir: overrides.workingDir ?? '',
    sockets: overrides.sockets ?? [],
    health: overrides.health ?? 'healthy',
    exeDeleted: overrides.exeDeleted ?? false,
    ...overrides,
  }
}

function makeMockPlatform(overrides: Partial<PlatformOps> = {}): PlatformOps {
  return {
    findPIDs: async () => [100],
    readProcess: async (pid: number) => makeProcess({ pid, ppid: 1, command: 'node' }),
    getParentPID: async () => 1,
    getInitPID: async () => 1,
    ...overrides,
  }
}

// C6: resolveAncestry should use proc.ppid directly, not call getParentPID separately
describe('resolveAncestry - C6: use proc.ppid', () => {
  it('should not call getParentPID when ppid is available', async () => {
    const getParentPID = mock(async () => 1)
    const processes = new Map<number, ProcessInfo>([
      [1, makeProcess({ pid: 1, ppid: 0, command: 'systemd' })],
      [100, makeProcess({ pid: 100, ppid: 1, command: 'node' })],
    ])
    const platform: PlatformOps = {
      findPIDs: async () => [],
      readProcess: async (pid: number) => {
        const p = processes.get(pid)
        if (!p) throw new Error(`Process ${pid} not found`)
        return p
      },
      getParentPID,
      getInitPID: async () => 1,
    }
    const { resolveAncestry } = await import('./ancestry')
    await resolveAncestry(100, platform)
    // Should use proc.ppid directly, not call getParentPID
    expect(getParentPID).not.toHaveBeenCalled()
  })
})
