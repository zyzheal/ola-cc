import { describe, it, expect } from 'bun:test'
import { formatDiagnosticResult } from './index'
import type { DiagnosticResult, ProcessInfo, Source, Warning, DiagnosticCapabilities } from '../types'

function makeResult(overrides?: Partial<DiagnosticResult>): DiagnosticResult {
  const proc: ProcessInfo = {
    pid: 1234,
    ppid: 100,
    command: 'node',
    cmdline: 'node server.js',
    exe: '/usr/bin/node',
    startedAt: new Date('2024-01-01T00:00:00Z'),
    user: 'heal',
    cpuPercent: 5.2,
    memoryRSS: 1024 * 1024 * 100,
    workingDir: '/home/heal/project',
    gitRepo: 'my-project',
    gitBranch: 'main',
    sockets: [{ port: 3000, address: '0.0.0.0', state: 'LISTEN', protocol: 'tcp' }],
    health: 'healthy',
    exeDeleted: false,
  }
  const source: Source = {
    type: 'ssh',
    name: 'ssh session',
    description: 'from 192.168.1.5',
    details: {},
  }
  const capabilities: DiagnosticCapabilities = {
    canReadProcess: true,
    canReadSockets: true,
    canReadEnvironment: false,
    canReadExtended: false,
    canDetectSource: true,
    limitations: ['verbose=false'],
  }
  return {
    target: { type: 'port', value: '3000' },
    process: proc,
    ancestry: [
      { ...proc, pid: 1, ppid: 0, command: 'systemd' },
      { ...proc, pid: 100, ppid: 1, command: 'sshd' },
      proc,
    ],
    children: [],
    source,
    warnings: [{ type: 'public-listen', message: 'Listening on public interface', severity: 'warn' }],
    restartCount: 0,
    capabilities,
    ...overrides,
  }
}

describe('formatDiagnosticResult - JSON', () => {
  it('should return valid JSON by default', () => {
    const result = formatDiagnosticResult(makeResult())
    const parsed = JSON.parse(result)
    expect(parsed.target.type).toBe('port')
    expect(parsed.target.value).toBe('3000')
  })

  it('should include process info', () => {
    const parsed = JSON.parse(formatDiagnosticResult(makeResult()))
    expect(parsed.process.pid).toBe(1234)
    expect(parsed.process.command).toBe('node')
    expect(parsed.process.user).toBe('heal')
  })

  it('should include ancestry chain', () => {
    const parsed = JSON.parse(formatDiagnosticResult(makeResult()))
    expect(parsed.ancestry.length).toBe(3)
    expect(parsed.ancestry[0].command).toBe('systemd')
    expect(parsed.ancestry[2].command).toBe('node')
  })

  it('should include source', () => {
    const parsed = JSON.parse(formatDiagnosticResult(makeResult()))
    expect(parsed.source.type).toBe('ssh')
    expect(parsed.source.name).toBe('ssh session')
  })

  it('should include warnings', () => {
    const parsed = JSON.parse(formatDiagnosticResult(makeResult()))
    expect(parsed.warnings.length).toBe(1)
    expect(parsed.warnings[0].type).toBe('public-listen')
  })

  it('should include capabilities', () => {
    const parsed = JSON.parse(formatDiagnosticResult(makeResult()))
    expect(parsed.capabilities.canReadProcess).toBe(true)
    expect(parsed.capabilities.limitations).toContain('verbose=false')
  })

  // I11: JSON should include all process fields
  it('should include cmdline, exe, cpuPercent, memoryRSS, sockets in JSON', () => {
    const parsed = JSON.parse(formatDiagnosticResult(makeResult()))
    expect(parsed.process.cmdline).toBe('node server.js')
    expect(parsed.process.exe).toBe('/usr/bin/node')
    expect(parsed.process.cpuPercent).toBe(5.2)
    expect(parsed.process.memoryRSS).toBe(1024 * 1024 * 100)
    expect(parsed.process.sockets.length).toBe(1)
    expect(parsed.process.sockets[0].port).toBe(3000)
  })
})

describe('formatDiagnosticResult - text', () => {
  it('should include header', () => {
    const text = formatDiagnosticResult(makeResult(), 'text')
    expect(text).toContain('=== Process Diagnostic ===')
  })

  it('should include target info', () => {
    const text = formatDiagnosticResult(makeResult(), 'text')
    expect(text).toContain('Target: 3000 (port)')
  })

  it('should include process info', () => {
    const text = formatDiagnosticResult(makeResult(), 'text')
    expect(text).toContain('Process: node (pid 1234)')
    expect(text).toContain('User: heal')
    expect(text).toContain('Command: node server.js')
  })

  it('should include ancestry chain', () => {
    const text = formatDiagnosticResult(makeResult(), 'text')
    expect(text).toContain('Why It Exists:')
    expect(text).toContain('systemd (1)')
    expect(text).toContain('node (1234)')
  })

  it('should include source', () => {
    const text = formatDiagnosticResult(makeResult(), 'text')
    expect(text).toContain('Source: ssh session (from 192.168.1.5)')
  })

  it('should include listening ports', () => {
    const text = formatDiagnosticResult(makeResult(), 'text')
    expect(text).toContain('Listening:')
    expect(text).toContain('0.0.0.0:3000')
  })

  it('should include warnings', () => {
    const text = formatDiagnosticResult(makeResult(), 'text')
    expect(text).toContain('Warnings:')
    expect(text).toContain('Listening on public interface')
  })

  it('should include working dir and git', () => {
    const text = formatDiagnosticResult(makeResult(), 'text')
    expect(text).toContain('Working Dir: /home/heal/project')
    expect(text).toContain('Git: my-project (main)')
  })

  it('should show restart count when > 0', () => {
    const text = formatDiagnosticResult(makeResult({ restartCount: 3 }), 'text')
    expect(text).toContain('Restart Count: 3')
  })

  it('should not show restart count when 0', () => {
    const text = formatDiagnosticResult(makeResult({ restartCount: 0 }), 'text')
    expect(text).not.toContain('Restart Count')
  })
})
