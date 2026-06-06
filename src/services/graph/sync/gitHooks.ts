/**
 * Git Sync Hooks
 *
 * When the live file watcher is disabled (e.g. on WSL2 `/mnt/*` drives),
 * the graph index would otherwise go stale. As an opt-in alternative, we
 * install git hooks that refresh the index after commit, merge, and checkout.
 *
 * Hooks run in the background so they never block git, and are guarded by
 * `command -v` so they no-op cleanly when the CLI isn't on PATH.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync } from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { execFileSync } from 'child_process'

const MARKER_BEGIN = '# >>> graph-engine sync hook >>>'
const MARKER_END = '# <<< graph-engine sync hook <<<'

export type GitHookName = 'post-commit' | 'post-merge' | 'post-checkout'

export const DEFAULT_SYNC_HOOKS: GitHookName[] = [
  'post-commit',
  'post-merge',
  'post-checkout',
]

export interface GitHookResult {
  installed: GitHookName[]
  hooksDir: string | null
  skipped?: string
}

/**
 * Whether `projectRoot` is inside a git working tree.
 */
export function isGitRepo(projectRoot: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
    return out === 'true'
  } catch {
    return false
  }
}

/**
 * Resolve the git hooks directory for a project.
 */
function gitHooksDir(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
    if (!out) return null
    return isAbsolute(out) ? out : resolve(projectRoot, out)
  } catch {
    return null
  }
}

/** The shell snippet (between markers) injected into each hook. */
function markerBlock(): string {
  return [
    MARKER_BEGIN,
    '# Keeps the graph index fresh while the live file watcher is off',
    '# Runs in the background so it never blocks git.',
    'if command -v ola-cc >/dev/null 2>&1; then',
    '  ( ola-cc graph sync >/dev/null 2>&1 & ) >/dev/null 2>&1',
    'fi',
    MARKER_END,
  ].join('\n')
}

/** Remove our marker block from hook content. */
function stripMarkerBlock(content: string): string {
  const lines = content.split('\n')
  const kept: string[] = []
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === MARKER_BEGIN) { inBlock = true; continue }
    if (trimmed === MARKER_END) { inBlock = false; continue }
    if (!inBlock) kept.push(line)
  }
  return kept.join('\n')
}

/** Whether a hook body is just a shebang / blank lines. */
function isEffectivelyEmpty(content: string): boolean {
  return content
    .split('\n')
    .map((l) => l.trim())
    .every((l) => l.length === 0 || l.startsWith('#!'))
}

function chmodExecutable(file: string): void {
  try {
    chmodSync(file, 0o755)
  } catch {
    /* unsupported on some platforms */
  }
}

/**
 * Install (or update) the graph sync hooks in a git repository.
 * Idempotent: re-running replaces our marker block rather than duplicating it.
 */
export function installGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot)
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' }
  }

  try {
    mkdirSync(hooksDir, { recursive: true })
  } catch {
    return { installed: [], hooksDir, skipped: 'could not access the git hooks directory' }
  }

  const block = markerBlock()
  const installed: GitHookName[] = []

  for (const hook of hooks) {
    const file = join(hooksDir, hook)
    let content: string

    if (existsSync(file)) {
      const base = stripMarkerBlock(readFileSync(file, 'utf8')).replace(/\s*$/, '')
      content = base.length > 0
        ? `${base}\n\n${block}\n`
        : `#!/bin/sh\n${block}\n`
    } else {
      content = `#!/bin/sh\n${block}\n`
    }

    writeFileSync(file, content)
    chmodExecutable(file)
    installed.push(hook)
  }

  return { installed, hooksDir }
}

/**
 * Remove the graph sync hooks. Strips only our marker block.
 */
export function removeGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot)
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' }
  }

  const removed: GitHookName[] = []

  for (const hook of hooks) {
    const file = join(hooksDir, hook)
    if (!existsSync(file)) continue

    const original = readFileSync(file, 'utf8')
    if (!original.includes(MARKER_BEGIN)) continue

    const stripped = stripMarkerBlock(original)
    if (isEffectivelyEmpty(stripped)) {
      unlinkSync(file)
    } else {
      writeFileSync(file, `${stripped.replace(/\s*$/, '')}\n`)
      chmodExecutable(file)
    }
    removed.push(hook)
  }

  return { installed: removed, hooksDir }
}

/** Whether any graph sync hook is currently installed. */
export function isSyncHookInstalled(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): boolean {
  const hooksDir = gitHooksDir(projectRoot)
  if (!hooksDir) return false
  return hooks.some((hook) => {
    const file = join(hooksDir, hook)
    return existsSync(file) && readFileSync(file, 'utf8').includes(MARKER_BEGIN)
  })
}
