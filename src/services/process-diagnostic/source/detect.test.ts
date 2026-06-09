import { describe, it, expect } from 'bun:test'
import { detectSource } from './detect'
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

const mockPlatform: PlatformOps = {
  findPIDs: async () => [],
  readProcess: async () => makeProcess({ pid: 1 }),
  getParentPID: async () => null,
  getInitPID: async () => 1,
}

describe('detectSource', () => {
  it('should detect SSH source', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'sshd' }),
      makeProcess({ pid: 200, ppid: 100, command: 'bash' }),
      makeProcess({ pid: 300, ppid: 200, command: 'node' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('ssh')
    expect(source.name).toBe('ssh session')
  })

  it('should detect shell source', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'bash', exe: '/usr/bin/bash' }),
      makeProcess({ pid: 200, ppid: 100, command: 'node' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('shell')
    expect(source.name).toBe('bash')
  })

  it('should detect container source', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'containerd' }),
      makeProcess({ pid: 200, ppid: 100, command: 'node', container: 'abc123' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('container')
    expect(source.name).toBe('abc123')
  })

  it('should detect supervisor source (pm2)', () => {
    // Use agetty (non-matching) as PID 1 so supervisor detector matches pm2, not init
    const ancestry = [
      makeProcess({ pid: 1, command: 'agetty' }),
      makeProcess({ pid: 100, ppid: 1, command: 'pm2' }),
      makeProcess({ pid: 200, ppid: 100, command: 'node' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('supervisor')
    expect(source.name).toBe('pm2')
  })

  it('should detect cron source', () => {
    // Avoid systemd (matches supervisor before cron)
    const ancestry = [
      makeProcess({ pid: 1, command: 'agetty' }),
      makeProcess({ pid: 100, ppid: 1, command: 'cron' }),
      makeProcess({ pid: 200, ppid: 100, command: 'backup.sh' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('cron')
  })

  it('should detect init source when root is PID 1', () => {
    // Use a command that doesn't contain any SUPERVISOR_COMMANDS substring
    const ancestry = [
      makeProcess({ pid: 1, command: 'my-custom-boot' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('init')
    expect(source.name).toBe('my-custom-boot')
  })

  it('should return unknown for unrecognized origin', () => {
    const ancestry = [
      makeProcess({ pid: 500, command: 'mystery' }),
      makeProcess({ pid: 600, ppid: 500, command: 'node' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('unknown')
  })

  it('should detect systemd service from .service suffix', () => {
    const ancestry = [
      makeProcess({ pid: 500, ppid: 0, command: 'my-boot' }),
      makeProcess({ pid: 600, ppid: 500, command: 'nginx', service: 'nginx.service' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('systemd')
    expect(source.name).toBe('nginx.service')
  })

  it('should detect launchd service from label format', () => {
    const ancestry = [
      makeProcess({ pid: 500, ppid: 0, command: 'my-boot' }),
      makeProcess({ pid: 600, ppid: 500, command: 'agent', service: 'com.apple.WebKit.NetworkingAgent' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('launchd')
    expect(source.name).toBe('com.apple.WebKit.NetworkingAgent')
  })

  it('should return unknown for unrecognized service format', () => {
    const ancestry = [
      makeProcess({ pid: 500, ppid: 0, command: 'my-boot' }),
      makeProcess({ pid: 600, ppid: 500, command: 'foo', service: 'custom-service' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('unknown')
    expect(source.name).toBe('custom-service')
  })

  it('should prioritize container over shell', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'bash', exe: '/usr/bin/bash', container: 'docker-abc' }),
      makeProcess({ pid: 200, ppid: 100, command: 'node' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('container')
  })

  // I1: PID 1 systemd should be detected as init, not supervisor
  it('should detect PID 1 systemd as init, not supervisor', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'node' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('init')
    expect(source.name).toBe('systemd')
  })

  // I2: launchd requires 2+ dot segments, no-dot should not match
  it('should not detect no-dot service as launchd', () => {
    const ancestry = [
      makeProcess({ pid: 500, ppid: 0, command: 'my-boot' }),
      makeProcess({ pid: 600, ppid: 500, command: 'foo', service: 'my-service-name' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('unknown')
  })

  // I2: launchd should match com.xxx.yyy format (2+ dot segments)
  it('should detect multi-dot service as launchd', () => {
    const ancestry = [
      makeProcess({ pid: 500, ppid: 0, command: 'my-boot' }),
      makeProcess({ pid: 600, ppid: 500, command: 'foo', service: 'com.example.myapp.worker' }),
    ]
    const source = detectSource(ancestry, mockPlatform)
    expect(source.type).toBe('launchd')
  })
})
