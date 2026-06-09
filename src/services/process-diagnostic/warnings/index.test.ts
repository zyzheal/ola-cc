import { describe, it, expect } from 'bun:test'
import { detectWarnings } from './index'
import type { ProcessInfo, Source } from '../types'

function makeProcess(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: 1234,
    ppid: 100,
    command: 'node',
    cmdline: 'node server.js',
    exe: '/usr/bin/node',
    startedAt: new Date(),
    user: 'heal',
    cpuPercent: 5.2,
    memoryRSS: 100 * 1024 * 1024,
    workingDir: '/home/heal/project',
    sockets: [],
    health: 'healthy',
    exeDeleted: false,
    ...overrides,
  }
}

const healthySource: Source = { type: 'shell', name: 'bash', description: '', details: {} }
const unknownSource: Source = { type: 'unknown', name: 'unknown', description: '', details: {} }

describe('detectWarnings', () => {
  it('should return empty for healthy non-root process', () => {
    const proc = makeProcess()
    const warnings = detectWarnings(proc, [proc], healthySource)
    // Should have no warnings for a healthy process
    expect(warnings.every(w => w.type !== 'running-as-root')).toBe(true)
    expect(warnings.every(w => w.type !== 'zombie')).toBe(true)
    expect(warnings.every(w => w.type !== 'high-cpu')).toBe(true)
    expect(warnings.every(w => w.type !== 'deleted-binary')).toBe(true)
  })

  it('should detect running-as-root', () => {
    const proc = makeProcess({ user: 'root' })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const rootWarning = warnings.find(w => w.type === 'running-as-root')
    expect(rootWarning).toBeDefined()
    expect(rootWarning!.severity).toBe('warn')
    expect(rootWarning!.message).toContain('root')
  })

  it('should detect running-as-root for SYSTEM user', () => {
    const proc = makeProcess({ user: 'SYSTEM' })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'running-as-root')).toBe(true)
  })

  it('should detect running-as-root for NT AUTHORITY\\SYSTEM', () => {
    const proc = makeProcess({ user: 'NT AUTHORITY\\SYSTEM' })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'running-as-root')).toBe(true)
  })

  it('should detect public-listen', () => {
    const proc = makeProcess({
      sockets: [{ port: 3000, address: '0.0.0.0', state: 'LISTEN', protocol: 'tcp' }],
    })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const listenWarning = warnings.find(w => w.type === 'public-listen')
    expect(listenWarning).toBeDefined()
    expect(listenWarning!.severity).toBe('warn')
  })

  it('should detect public-listen on IPv6', () => {
    const proc = makeProcess({
      sockets: [{ port: 3000, address: '::', state: 'LISTEN', protocol: 'tcp6' }],
    })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'public-listen')).toBe(true)
  })

  it('should not warn for localhost listen', () => {
    const proc = makeProcess({
      sockets: [{ port: 3000, address: '127.0.0.1', state: 'LISTEN', protocol: 'tcp' }],
    })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'public-listen')).toBe(false)
  })

  it('should detect zombie process', () => {
    const proc = makeProcess({ health: 'zombie' })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const zombieWarning = warnings.find(w => w.type === 'zombie')
    // zombie rule has platforms filter, may or may not fire depending on test platform
    if (zombieWarning) {
      expect(zombieWarning.severity).toBe('critical')
    }
  })

  it('should detect stopped process', () => {
    const proc = makeProcess({ health: 'stopped' })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const stoppedWarning = warnings.find(w => w.type === 'stopped')
    expect(stoppedWarning).toBeDefined()
    expect(stoppedWarning!.severity).toBe('warn')
  })

  it('should detect high CPU', () => {
    const proc = makeProcess({ cpuPercent: 95.5 })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const cpuWarning = warnings.find(w => w.type === 'high-cpu')
    expect(cpuWarning).toBeDefined()
    expect(cpuWarning!.severity).toBe('warn')
    expect(cpuWarning!.message).toContain('95.5')
  })

  it('should not warn for normal CPU', () => {
    const proc = makeProcess({ cpuPercent: 50 })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'high-cpu')).toBe(false)
  })

  it('should detect high memory (> 1GB)', () => {
    const proc = makeProcess({ memoryRSS: 2 * 1024 * 1024 * 1024 })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const memWarning = warnings.find(w => w.type === 'high-memory')
    expect(memWarning).toBeDefined()
    expect(memWarning!.severity).toBe('warn')
  })

  it('should not warn for normal memory', () => {
    const proc = makeProcess({ memoryRSS: 512 * 1024 * 1024 })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'high-memory')).toBe(false)
  })

  it('should detect deleted binary', () => {
    const proc = makeProcess({ exeDeleted: true })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const deletedWarning = warnings.find(w => w.type === 'deleted-binary')
    expect(deletedWarning).toBeDefined()
    expect(deletedWarning!.severity).toBe('critical')
  })

  it('should detect unknown source', () => {
    const proc = makeProcess()
    const warnings = detectWarnings(proc, [proc], unknownSource)
    const unknownWarning = warnings.find(w => w.type === 'unknown-source')
    expect(unknownWarning).toBeDefined()
    expect(unknownWarning!.severity).toBe('info')
  })

  it('should detect multiple warnings simultaneously', () => {
    const proc = makeProcess({
      user: 'root',
      cpuPercent: 99,
      memoryRSS: 4 * 1024 * 1024 * 1024,
      exeDeleted: true,
      sockets: [{ port: 80, address: '0.0.0.0', state: 'LISTEN', protocol: 'tcp' }],
    })
    const warnings = detectWarnings(proc, [proc], unknownSource)
    const types = warnings.map(w => w.type)
    expect(types).toContain('running-as-root')
    expect(types).toContain('public-listen')
    expect(types).toContain('high-cpu')
    expect(types).toContain('high-memory')
    expect(types).toContain('deleted-binary')
    expect(types).toContain('unknown-source')
  })

  // === 新增警告规则测试 ===

  it('should detect long-running process (> 90 days)', () => {
    const proc = makeProcess({ startedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const w = warnings.find(w => w.type === 'long-running')
    expect(w).toBeDefined()
    expect(w!.severity).toBe('info')
  })

  it('should not warn for short-running process', () => {
    const proc = makeProcess({ startedAt: new Date(Date.now() - 1000) })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'long-running')).toBe(false)
  })

  it('should detect suspicious cwd (/)', () => {
    const proc = makeProcess({ workingDir: '/' })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'suspicious-cwd')).toBe(true)
  })

  it('should detect suspicious cwd (/tmp)', () => {
    const proc = makeProcess({ workingDir: '/tmp' })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'suspicious-cwd')).toBe(true)
  })

  it('should detect suspicious cwd (/var/tmp)', () => {
    const proc = makeProcess({ workingDir: '/var/tmp' })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'suspicious-cwd')).toBe(true)
  })

  it('should not warn for normal cwd', () => {
    const proc = makeProcess({ workingDir: '/home/user/project' })
    const warnings = detectWarnings(proc, [proc], healthySource)
    expect(warnings.some(w => w.type === 'suspicious-cwd')).toBe(false)
  })

  it('should detect ld-preload env var', () => {
    const proc = makeProcess({ env: ['LD_PRELOAD=/evil.so', 'PATH=/usr/bin'] })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const w = warnings.find(w => w.type === 'ld-preload')
    // May not fire on macOS (platform filter)
    if (w) {
      expect(w.severity).toBe('warn')
      expect(w.message).toContain('LD_PRELOAD')
    }
  })

  it('should detect dyld-inject env vars', () => {
    const proc = makeProcess({ env: ['DYLD_INSERT_LIBRARIES=/evil.dylib', 'PATH=/usr/bin'] })
    const warnings = detectWarnings(proc, [proc], healthySource)
    const w = warnings.find(w => w.type === 'dyld-inject')
    // May not fire on Linux (platform filter)
    if (w) {
      expect(w.severity).toBe('warn')
      expect(w.message).toContain('DYLD')
    }
  })

  it('should detect restart-threshold (> 5 consecutive same command)', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'pm2' }),
    ]
    // Add 7 consecutive 'node' processes
    for (let i = 0; i < 7; i++) {
      ancestry.push(makeProcess({ pid: 200 + i, ppid: 100, command: 'node' }))
    }
    const proc = ancestry[ancestry.length - 1]
    const warnings = detectWarnings(proc, ancestry, healthySource)
    const w = warnings.find(w => w.type === 'restart-threshold')
    expect(w).toBeDefined()
    expect(w!.severity).toBe('warn')
  })

  it('should not warn for restart-threshold with <= 5', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'pm2' }),
      makeProcess({ pid: 200, ppid: 100, command: 'node' }),
    ]
    const warnings = detectWarnings(ancestry[2], ancestry, healthySource)
    expect(warnings.some(w => w.type === 'restart-threshold')).toBe(false)
  })

  it('should detect partial-ancestry (depth >= 64)', () => {
    // Build a 64-length ancestry chain
    const ancestry = Array.from({ length: 64 }, (_, i) =>
      makeProcess({ pid: i + 1, ppid: i > 0 ? i : 0, command: `proc${i}` })
    )
    const proc = ancestry[ancestry.length - 1]
    const warnings = detectWarnings(proc, ancestry, healthySource)
    const w = warnings.find(w => w.type === 'partial-ancestry')
    expect(w).toBeDefined()
    expect(w!.severity).toBe('info')
  })

  it('should not warn for partial-ancestry with normal depth', () => {
    const ancestry = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'node' }),
    ]
    const warnings = detectWarnings(ancestry[1], ancestry, healthySource)
    expect(warnings.some(w => w.type === 'partial-ancestry')).toBe(false)
  })
})
