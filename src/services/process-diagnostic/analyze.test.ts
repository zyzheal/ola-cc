import { describe, it, expect, mock } from 'bun:test'
import type { PlatformOps } from './platform/types'
import type { ProcessInfo } from './types'

// Mock getPlatformOps before importing analyze
const mockPlatform: PlatformOps = {
  findPIDs: async () => [],
  readProcess: async () => makeProcess({ pid: 1 }),
  getParentPID: async () => null,
  getInitPID: async () => 1,
}

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

// We test analyze indirectly by testing with the real platform
// For unit tests, we test the module's error paths and behavior
describe('analyze', () => {
  it('should export analyze function', async () => {
    const mod = await import('./analyze')
    expect(typeof mod.analyze).toBe('function')
  })

  it('should throw NotFoundError when no PIDs found', async () => {
    // This will use the real platform, which won't find a process for this port
    const { analyze } = await import('./analyze')
    const { NotFoundError } = await import('./types')
    await expect(analyze({
      target: { type: 'port', value: '59999' },
    })).rejects.toThrow(NotFoundError)
  })

  it('should analyze a real process by PID', async () => {
    // Test with PID 1 (init/launchd) which always exists
    const { analyze } = await import('./analyze')
    const result = await analyze({
      target: { type: 'pid', value: '1' },
    })
    expect(result.process.pid).toBe(1)
    expect(result.ancestry.length).toBeGreaterThanOrEqual(1)
    expect(result.source).toBeDefined()
    expect(result.source.type).toBeDefined()
    expect(result.warnings).toBeDefined()
    expect(Array.isArray(result.warnings)).toBe(true)
    expect(result.capabilities).toBeDefined()
    expect(result.capabilities.canReadProcess).toBe(true)
  })

  it('should analyze current bun process by PID', async () => {
    const { analyze } = await import('./analyze')
    const result = await analyze({
      target: { type: 'pid', value: String(process.pid) },
    })
    expect(result.process.pid).toBe(process.pid)
    expect(result.ancestry.length).toBeGreaterThanOrEqual(1)
    // Current process should have a known source
    expect(result.source.type).not.toBe('unknown')
  })
})
