/**
 * Watch Policy
 *
 * Decides whether the live file watcher should run for a given project.
 *
 * Native recursive `fs.watch` is pathologically slow on WSL2 `/mnt/*`
 * drives (NTFS exposed over the 9p/drvfs bridge). This module centralizes
 * the on/off decision so the watcher, diagnostics, and installer all agree.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

let wslChecked = false
let wslValue = false

/**
 * Detect whether the current process is running under WSL.
 * Result is cached after the first call.
 */
export function detectWsl(): boolean {
  if (wslChecked) return wslValue
  wslChecked = true

  if (process.platform !== 'linux') {
    wslValue = false
    return wslValue
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    wslValue = true
    return wslValue
  }
  try {
    const version = readFileSync('/proc/version', 'utf8').toLowerCase()
    wslValue = version.includes('microsoft') || version.includes('wsl')
  } catch {
    wslValue = false
  }
  return wslValue
}

/**
 * True for WSL Windows-drive mounts like `/mnt/c` or `/mnt/d/project`.
 */
function isWindowsDriveMount(projectRoot: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(resolve(projectRoot))
}

export interface WatchProbe {
  env?: NodeJS.ProcessEnv
  isWsl?: boolean
}

/**
 * Decide whether the file watcher should be disabled for a project, and why.
 *
 * Returns a short human-readable reason when watching should be skipped, or
 * `null` when it should run normally.
 */
export function watchDisabledReason(
  projectRoot: string,
  probe: WatchProbe = {},
): string | null {
  const env = probe.env ?? process.env

  if (env.OLA_CC_NO_WATCH === '1') {
    return 'OLA_CC_NO_WATCH=1 is set'
  }
  if (env.OLA_CC_FORCE_WATCH === '1') {
    return null
  }

  const isWsl = probe.isWsl ?? detectWsl()
  if (isWsl && isWindowsDriveMount(projectRoot)) {
    return 'project is on a WSL2 /mnt/ drive, where recursive fs.watch is too slow'
  }

  return null
}

/** Test-only: reset the cached WSL detection. */
export function __resetWslCacheForTests(): void {
  wslChecked = false
  wslValue = false
}
