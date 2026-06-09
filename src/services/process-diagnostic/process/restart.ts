import type { ProcessInfo } from '../types.js'
import { SHELL_PATTERNS_FOR_RESTART } from '../constants.js'

function isShell(proc: ProcessInfo): boolean {
  const name = proc.exe || proc.command
  return SHELL_PATTERNS_FOR_RESTART.some(p => p.test(name))
}

/**
 * 统计祖先链中连续相同命令的进程数（跳过 shell 中介）
 * 返回重启次数 = count - 1（目标自身不计）
 */
export function countRestarts(ancestry: ProcessInfo[], targetCommand: string): number {
  let count = 0

  for (let i = ancestry.length - 1; i >= 0; i--) {
    if (isShell(ancestry[i])) continue
    if (ancestry[i].command === targetCommand) count++
    else break
  }

  return Math.max(0, count - 1)
}
