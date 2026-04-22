// src/utils/searchEngine.ts
// Translate ripgrep CLI args to ugrep CLI args

import { logForDebugging } from './debug.js'

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
