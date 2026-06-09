import { describe, it, expect } from 'bun:test'
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

const source: Source = { type: 'shell', name: 'bash', description: '', details: {} }

// C4: restart-threshold should skip shell intermediary processes
describe('detectWarnings - C4: restart-threshold skips shell', () => {
  it('should count through shell intermediaries for restart-threshold', async () => {
    const { detectWarnings } = await import('./index')
    // Chain: [init, pm2, bash, node, bash, node, bash, node, bash, node, bash, node, bash, node, bash, node]
    // After skipping bash: 7 consecutive 'node' → should trigger restart-threshold (>5)
    const ancestry: ProcessInfo[] = [
      makeProcess({ pid: 1, command: 'systemd' }),
      makeProcess({ pid: 100, ppid: 1, command: 'pm2' }),
    ]
    for (let i = 0; i < 7; i++) {
      ancestry.push(makeProcess({ pid: 200 + i * 2, ppid: 100, command: 'bash', exe: '/bin/bash' }))
      ancestry.push(makeProcess({ pid: 201 + i * 2, ppid: 200 + i * 2, command: 'node' }))
    }
    const proc = ancestry[ancestry.length - 1]
    const warnings = detectWarnings(proc, ancestry, source)
    const w = warnings.find(w => w.type === 'restart-threshold')
    expect(w).toBeDefined()
  })
})

// I7: detectWarnings should accept optional platform parameter
describe('detectWarnings - I7: platform injection', () => {
  it('should accept platform parameter for cross-platform testing', async () => {
    const { detectWarnings } = await import('./index')
    const proc = makeProcess({ health: 'zombie' })
    // On darwin, zombie warning should fire (platforms: ['darwin', 'linux', 'freebsd'])
    const warnings = detectWarnings(proc, [proc], source, 'darwin')
    const zombieWarning = warnings.find(w => w.type === 'zombie')
    expect(zombieWarning).toBeDefined()
    expect(zombieWarning!.severity).toBe('critical')
  })

  it('should not fire zombie warning on win32', async () => {
    const { detectWarnings } = await import('./index')
    const proc = makeProcess({ health: 'zombie' })
    const warnings = detectWarnings(proc, [proc], source, 'win32')
    expect(warnings.some(w => w.type === 'zombie')).toBe(false)
  })

  it('should fire ld-preload on linux', async () => {
    const { detectWarnings } = await import('./index')
    const proc = makeProcess({ env: ['LD_PRELOAD=/evil.so'] })
    const warnings = detectWarnings(proc, [proc], source, 'linux')
    expect(warnings.some(w => w.type === 'ld-preload')).toBe(true)
  })

  it('should not fire ld-preload on darwin', async () => {
    const { detectWarnings } = await import('./index')
    const proc = makeProcess({ env: ['LD_PRELOAD=/evil.so'] })
    const warnings = detectWarnings(proc, [proc], source, 'darwin')
    expect(warnings.some(w => w.type === 'ld-preload')).toBe(false)
  })

  it('should fire dyld-inject on darwin', async () => {
    const { detectWarnings } = await import('./index')
    const proc = makeProcess({ env: ['DYLD_INSERT_LIBRARIES=/evil.dylib'] })
    const warnings = detectWarnings(proc, [proc], source, 'darwin')
    expect(warnings.some(w => w.type === 'dyld-inject')).toBe(true)
  })
})
