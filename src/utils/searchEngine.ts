// src/utils/searchEngine.ts
// Translate ripgrep CLI args to ugrep CLI args and spawn ugrep binary

import { spawn } from 'child_process'
import * as path from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { logForDebugging } from './debug.js'
import { getPlatform } from './platform.js'
import { logEvent } from 'src/services/analytics/index.js'
import { ripGrep } from './ripgrep.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const MAX_BUFFER_SIZE = 20_000_000 // 20MB, same as ripgrep.ts

/**
 * Translate ripgrep CLI args to ugrep CLI args.
 *
 * Only handles flags that GrepTool actually sends (verified from GrepTool.ts).
 * Unsupported flags are dropped with a debug log entry.
 *
 * Key mapping decisions:
 * - ugrep needs explicit `-r` for recursion (ripgrep recurses by default)
 * - `--no-ignore` maps to ugrep's own `--no-ignore` (both tools support this flag)
 * - `--sort=modified` is dropped — sorting is done in GrepTool post-processing
 * - `--max-columns` is dropped — ugrep handles long lines natively
 * - `-U` (multiline) is dropped — ugrep supports multiline by default
 *
 * @param rgArgs - Array of ripgrep CLI arguments (flags, values, and search pattern)
 * @returns Array of ugrep CLI arguments, always starting with `-r` for recursion
 */
export function translateRgToUgrep(rgArgs: string[]): string[] {
  const ugrepArgs: string[] = []
  let i = 0

  // ugrep needs explicit -r for recursion; ripgrep recurses by default
  ugrepArgs.push('-r')

  while (i < rgArgs.length) {
    const arg = rgArgs[i]!

    switch (arg) {
      case '--hidden':
        ugrepArgs.push('--hidden')
        break

      case '--glob': {
        i++
        const pattern = rgArgs[i]
        if (pattern) ugrepArgs.push('-g', pattern)
        break
      }

      case '--max-columns':
        i++ // skip value, drop flag
        break

      case '-U':
        // Drop — ugrep supports multiline by default
        break

      case '--multiline-dotall':
        ugrepArgs.push('--dotall')
        break

      case '-j': {
        i++
        const val = rgArgs[i]
        if (val) ugrepArgs.push('-J', val)
        break
      }

      case '--sort=modified':
        break // Drop — sorting done in GrepTool post-processing

      case '--type': {
        i++
        const val = rgArgs[i]
        if (val) ugrepArgs.push('-t', val)
        break
      }

      case '--no-ignore':
        ugrepArgs.push('--no-ignore')
        break

      case '-c':
        ugrepArgs.push('-c', '--min-count=1')
        break

      case '-l':
      case '-n':
      case '-i':
        ugrepArgs.push(arg)
        break

      case '-e': {
        ugrepArgs.push(arg)
        i++
        const val = rgArgs[i]
        if (val) ugrepArgs.push(val)
        break
      }

      case '-B':
      case '-A':
      case '-C': {
        i++
        const val = rgArgs[i]
        if (val) ugrepArgs.push(arg, val)
        break
      }

      default:
        if (!arg.startsWith('-')) {
          ugrepArgs.push(arg)
        } else {
          logForDebugging(`[searchEngine] unknown ripgrep flag: ${arg}`)
        }
    }
    i++
  }

  return ugrepArgs
}

/**
 * Check if ugrep is available on this platform.
 * Currently: Windows x64 only.
 */
export function canUseUgrep(): boolean {
  return process.platform === 'win32' && process.arch === 'x64'
}

/**
 * Get the path to the ugrep binary for the current platform.
 * Returns null if ugrep is not available for this platform/arch.
 */
function getUgrepPath(): string | null {
  const ugRoot = path.join(__dirname, 'vendor', 'ugrep')

  if (process.platform === 'win32' && process.arch === 'x64') {
    const p = path.join(ugRoot, 'x64-win32', 'ugrep.exe')
    if (!existsSync(p)) return null
    return p
  }
  return null
}

function logEngineFallback(from: string, to: string, reason: string): void {
  logEvent('search_engine_fallback', { from, to, reason })
  logForDebugging(`[searchEngine] ${from} failed (${reason}), falling back to ${to}`)
}

/**
 * Spawn ugrep binary with translated args.
 * Returns array of output lines (same format as ripGrep).
 */
export async function ugrepBinary(
  rgArgs: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  const ugrepPath = getUgrepPath()
  if (!ugrepPath) {
    throw new Error('ugrep binary not available for this platform')
  }

  const ugrepArgs = translateRgToUgrep(rgArgs)

  return new Promise((resolve, reject) => {
    const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000
    const parsedSeconds = parseInt(process.env.OLA_CC_GLOB_TIMEOUT_SECONDS || '', 10) || 0
    const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout

    const child = spawn(ugrepPath, [...ugrepArgs, target], {
      signal: abortSignal,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false

    child.stdout?.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        stdout += data.toString()
        if (stdout.length > MAX_BUFFER_SIZE) {
          stdout = stdout.slice(0, MAX_BUFFER_SIZE)
          stdoutTruncated = true
        }
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        stderr += data.toString()
        if (stderr.length > MAX_BUFFER_SIZE) {
          stderr = stderr.slice(0, MAX_BUFFER_SIZE)
          stderrTruncated = true
        }
      }
    })

    let killTimeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutId = setTimeout(() => {
      if (process.platform === 'win32') {
        child.kill()
      } else {
        child.kill('SIGTERM')
        killTimeoutId = setTimeout(() => child.kill('SIGKILL'), 5_000)
      }
    }, timeout)

    let settled = false
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)

      // Distinguish abort from real failure
      if (abortSignal.aborted) {
        resolve([])
        return
      }

      if (code === 0 || code === 1) {
        resolve(
          stdout
            .trim()
            .split('\n')
            .map(line => line.replace(/\r$/, ''))
            .filter(Boolean),
        )
      } else {
        reject(new Error(`ugrep exited with code ${code}: ${stderr}`))
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      clearTimeout(killTimeoutId)
      reject(err)
    })
  })
}

/**
 * Unified search entry point.
 * On Windows x64: tries ugrep first, falls back to ripgrep on any error.
 * On all other platforms: uses ripgrep directly.
 */
export async function unifiedSearch(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  if (canUseUgrep()) {
    try {
      return await ugrepBinary(args, target, abortSignal)
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err)
      logEngineFallback('ugrep', 'ripgrep', reason)
      // Fall through to ripgrep
    }
  }
  return ripGrep(args, target, abortSignal)
}
