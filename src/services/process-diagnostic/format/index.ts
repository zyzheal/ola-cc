import type { DiagnosticResult } from '../types.js'

export function formatDiagnosticResult(
  result: DiagnosticResult,
  format: 'json' | 'text' = 'json',
): string {
  if (format === 'json') {
    return JSON.stringify({
      target: result.target,
      process: {
        pid: result.process.pid,
        ppid: result.process.ppid,
        command: result.process.command,
        cmdline: result.process.cmdline,
        exe: result.process.exe,
        user: result.process.user,
        health: result.process.health,
        cpuPercent: result.process.cpuPercent,
        memoryRSS: result.process.memoryRSS,
        startedAt: result.process.startedAt,
        workingDir: result.process.workingDir,
        sockets: result.process.sockets,
        gitRepo: result.process.gitRepo,
        gitBranch: result.process.gitBranch,
        service: result.process.service,
        container: result.process.container,
        env: result.process.env,
        exeDeleted: result.process.exeDeleted,
      },
      ancestry: result.ancestry.map(p => ({ pid: p.pid, command: p.command })),
      children: result.children.map(p => ({ pid: p.pid, command: p.command, health: p.health })),
      source: result.source,
      warnings: result.warnings,
      restartCount: result.restartCount,
      capabilities: result.capabilities,
    }, null, 2)
  }

  // text 格式：人类可读的结构化文本
  const lines: string[] = []
  lines.push(`=== Process Diagnostic ===`)
  lines.push(`Target: ${result.target.value} (${result.target.type})`)
  lines.push('')
  lines.push(`Process: ${result.process.command} (pid ${result.process.pid})`)
  lines.push(`User: ${result.process.user}`)
  lines.push(`Command: ${result.process.cmdline}`)
  lines.push(`Health: ${result.process.health}`)
  if (result.process.workingDir) lines.push(`Working Dir: ${result.process.workingDir}`)
  if (result.process.gitRepo) lines.push(`Git: ${result.process.gitRepo} (${result.process.gitBranch})`)
  lines.push('')
  lines.push(`Why It Exists:`)
  lines.push(`  ${result.ancestry.map(p => `${p.command} (${p.pid})`).join(' -> ')}`)
  lines.push('')
  lines.push(`Source: ${result.source.name} (${result.source.description})`)
  if (result.process.sockets.length > 0) {
    lines.push(`Listening:`)
    for (const s of result.process.sockets) {
      lines.push(`  ${s.address}:${s.port} (${s.protocol}, ${s.state})`)
    }
  }
  if (result.warnings.length > 0) {
    lines.push('Warnings:')
    for (const w of result.warnings) {
      lines.push(`  ! ${w.message}`)
    }
  }
  if (result.restartCount > 0) lines.push(`Restart Count: ${result.restartCount}`)
  if (result.process.env && result.process.env.length > 0) {
    lines.push('')
    lines.push(`Environment (${result.process.env.length} vars):`)
    for (const e of result.process.env.slice(0, 20)) {
      lines.push(`  ${e}`)
    }
    if (result.process.env.length > 20) lines.push(`  ... (${result.process.env.length - 20} more)`)
  }
  return lines.join('\n')
}
