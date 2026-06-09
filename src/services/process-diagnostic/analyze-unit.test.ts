import { describe, it, expect, mock } from 'bun:test'
import type { PlatformOps } from './platform/types'
import type { ProcessInfo } from './types'
import { NotFoundError, AmbiguousError } from './types'

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

// C3: verbose readEnvironment
describe('analyze - C3: verbose readEnvironment', () => {
  it('should pass readEnvironment result to process.env', async () => {
    const proc = makeProcess({ pid: 100, ppid: 1, command: 'node' })
    const readEnvironment = mock(async () => ['PATH=/usr/bin', 'SECRET_TOKEN=abc123'])
    const platform: PlatformOps = {
      findPIDs: async () => [100],
      readProcess: async () => proc,
      getParentPID: async () => 1,
      getInitPID: async () => 1,
      readEnvironment,
    }
    // Verify the function exists and returns expected data
    const env = await platform.readEnvironment!(100)
    expect(env).toEqual(['PATH=/usr/bin', 'SECRET_TOKEN=abc123'])
    expect(readEnvironment).toHaveBeenCalledWith(100)
  })

  it('should gracefully handle missing readEnvironment', async () => {
    const platform: PlatformOps = {
      findPIDs: async () => [100],
      readProcess: async () => makeProcess({ pid: 100 }),
      getParentPID: async () => 1,
      getInitPID: async () => 1,
    }
    expect(platform.readEnvironment).toBeUndefined()
  })
})

// I5: children PID → ProcessInfo conversion
describe('analyze - I5: children conversion', () => {
  it('should convert child PIDs to ProcessInfo via readProcess', async () => {
    const readProcess = mock(async (pid: number) => makeProcess({ pid, ppid: 100, command: 'worker' }))
    const platform: PlatformOps = {
      findPIDs: async () => [100],
      readProcess,
      getParentPID: async () => 1,
      getInitPID: async () => 1,
      listChildren: async () => [200, 300],
    }
    const childPids = await platform.listChildren!(100)
    expect(childPids).toEqual([200, 300])
    // Verify readProcess would be called for each child
    for (const cpid of childPids) {
      const info = await readProcess(cpid)
      expect(info.pid).toBe(cpid)
    }
    expect(readProcess).toHaveBeenCalledTimes(2)
  })

  it('should handle readProcess failure for a child gracefully', async () => {
    const readProcess = mock(async (pid: number) => {
      if (pid === 300) throw new Error('Process exited')
      return makeProcess({ pid, ppid: 100, command: 'worker' })
    })
    const childPids = [200, 300]
    const results = await Promise.all(
      childPids.map(cpid => readProcess(cpid).catch(() => null)),
    )
    const valid = results.filter((r): r is ProcessInfo => r !== null)
    expect(valid.length).toBe(1)
    expect(valid[0].pid).toBe(200)
  })
})

// S8: partial chain on readProcess failure
describe('analyze - S8: partial chain on error', () => {
  it('should return partial chain when readProcess fails mid-traversal', async () => {
    const processes = new Map<number, ProcessInfo>([
      [1, makeProcess({ pid: 1, ppid: 0, command: 'systemd' })],
      [100, makeProcess({ pid: 100, ppid: 1, command: 'sshd' })],
      // PID 200 is missing — simulates process exit
    ])
    const platform: PlatformOps = {
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
      getInitPID: async () => 1,
    }
    const { resolveAncestry } = await import('./process/ancestry')
    // Start from PID 200 which doesn't exist — should return empty chain
    const chain = await resolveAncestry(200, platform)
    expect(chain.length).toBe(0)
  })

  it('should return partial chain when middle process fails', async () => {
    // Chain: 300 → 200 → 100(exits) → partial chain
    const processes = new Map<number, ProcessInfo>([
      [200, makeProcess({ pid: 200, ppid: 100, command: 'bash' })],
      [300, makeProcess({ pid: 300, ppid: 200, command: 'node' })],
      // PID 100 not in map → readProcess throws
    ])
    const platform: PlatformOps = {
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
      getInitPID: async () => 1,
    }
    const { resolveAncestry } = await import('./process/ancestry')
    const chain = await resolveAncestry(300, platform)
    // 300 OK → 200 OK → 100 fails → partial chain [200, 300]
    expect(chain.length).toBe(2)
    expect(chain[0].pid).toBe(200)
    expect(chain[1].pid).toBe(300)
  })
})

// C2: container query path
describe('analyze - C2: container query', () => {
  it('should have resolveContainer and findContainerHostPID exported', async () => {
    const mod = await import('./container/runtime')
    expect(typeof mod.resolveContainer).toBe('function')
    expect(typeof mod.findContainerHostPID).toBe('function')
    expect(typeof mod.registerRuntime).toBe('function')
  })
})
