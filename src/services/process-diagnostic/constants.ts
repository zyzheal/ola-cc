/**
 * 共享常量 — 避免多处重复定义
 */

/** 祖先链最大深度 */
export const MAX_ANCESTRY_DEPTH = 64

/**
 * Shell 进程模式 — 用于:
 * - restart.ts: countRestarts 跳过 shell 中介 (不含 tmux/screen)
 * - detect.ts: 源检测识别 shell 来源 (含 tmux/screen)
 *
 * 两者职责不同，但基础模式共享。
 * restart 专用: SHELL_PATTERNS_FOR_RESTART
 * 检测专用: SHELL_PATTERNS_FOR_DETECT (在 detect.ts 中扩展 tmux/screen)
 */
export const SHELL_PATTERNS_BASE = [
  /\/bash$/, /\/zsh$/, /\/fish$/, /\/sh$/, /\/dash$/, /\/ksh$/,
  /\/csh$/, /\/tcsh$/, /\/ash$/, /\/busybox$/,
  /\\cmd\.exe$/i, /\\powershell\.exe$/i, /\\pwsh\.exe$/i, /\\explorer\.exe$/i,
]

/** 重启计数用 — 不含终端复用器 */
export const SHELL_PATTERNS_FOR_RESTART = SHELL_PATTERNS_BASE

/** 源检测用 — 含终端复用器 */
export const SHELL_PATTERNS_FOR_DETECT = [
  ...SHELL_PATTERNS_BASE,
  /\/tmux$/, /\/screen$/,
]

/** 超时阈值 (ms) */
export const EXEC_TIMEOUT_MS = 5000

/** 警告阈值 */
export const ONE_DAY_MS = 24 * 60 * 60 * 1000
export const LONG_RUNNING_DAYS = 90
export const HIGH_CPU_PERCENT = 90
export const HIGH_MEMORY_BYTES = 1024 * 1024 * 1024  // 1GB
export const RESTART_THRESHOLD = 5

/** 可疑工作目录 */
export const SUSPICIOUS_CWDS = ['/', '/tmp', '/var/tmp']
