import { describe, it, expect } from 'bun:test'
import { resolveAncestry } from './ancestry'
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

function makeMockPlatform(processes: Map<number, ProcessInfo>, initPID = 1): PlatformOps {
  return {
    findPIDs: async () => [],
    readProcess: async (pid: number) => {
      const p = processes.get(pid)
      if (!p) throw new Error(`Process ${pid} not found`)
      return p
    },
    getParentPID: async (pid: number) => {
      const p = processes.get(pid)
      return p?.ppid && p.ppid > 0 ? p.ppid : null
    },
    getInitPID: async () => initPID,
  }
}

describe('resolveAncestry', () => {
  it('should build ancestry chain from target to init', async () => {
    const processes = new Map<number, ProcessInfo>([
      [1, makeProcess({ pid: 1, ppid: 0, command: 'systemd' })],
      [100, makeProcess({ pid: 100, ppid: 1, command: 'sshd' })],
      [200, makeProcess({ pid: 200, ppid: 100, command: 'bash' })],
      [300, makeProcess({ pid: 300, ppid: 200, command: 'node' })],
    ])
    const platform = makeMockPlatform(processes)
    const chain = await resolveAncestry(300, platform)

    expect(chain.length).toBe(4)
    expect(chain[0].pid).toBe(1)    // init
    expect(chain[1].pid).toBe(100)  // sshd
    expect(chain[2].pid).toBe(200)  // bash
    expect(chain[3].pid).toBe(300)  // target
  })

  it('should handle PID 1 as target', async () => {
    const processes = new Map<number, ProcessInfo>([
      [1, makeProcess({ pid: 1, ppid: 0, command: 'systemd' })],
    ])
    const platform = makeMockPlatform(processes)
    const chain = await resolveAncestry(1, platform)

    expect(chain.length).toBe(1)
    expect(chain[0].pid).toBe(1)
  })

  it('should stop at max depth', async () => {
    // Create a chain longer than MAX_ANCESTRY_DEPTH (64)
    const processes = new Map<number, ProcessInfo>()
    for (let i = 1; i <= 70; i++) {
      processes.set(i, makeProcess({ pid: i, ppid: i > 1 ? i - 1 : 0, command: `proc${i}` }))
    }
    const platform = makeMockPlatform(processes)
    const chain = await resolveAncestry(70, platform)

    // Should stop at 64 depth
    expect(chain.length).toBeLessThanOrEqual(64)
  })

  it('should detect cycle and break early', async () => {
    // Simulate a cycle: 100 → 200 → 100
    const processes = new Map<number, ProcessInfo>([
      [1, makeProcess({ pid: 1, ppid: 0, command: 'init' })],
      [100, makeProcess({ pid: 100, ppid: 200, command: 'a', startedAt: new Date(Date.now() - 10000) })],
      [200, makeProcess({ pid: 200, ppid: 100, command: 'b', startedAt: new Date(Date.now() - 10000) })],
    ])
    const platform = makeMockPlatform(processes)
    const chain = await resolveAncestry(200, platform)

    // Should detect cycle (PID 100 seen twice) and break early
    expect(chain.length).toBeLessThan(10)
  })
})
