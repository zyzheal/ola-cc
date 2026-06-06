/**
 * Git Worktree Awareness
 *
 * When a command runs from a git worktree, the resolved graph index might
 * belong to a *different* working tree (the main checkout). This module
 * detects that "borrowed index" situation so callers can warn about it.
 */

import { existsSync, realpathSync } from 'fs'
import { resolve } from 'path'
import { execFileSync } from 'child_process'

/**
 * Absolute, symlink-resolved toplevel of the git working tree that `dir`
 * belongs to, or null when `dir` isn't inside a git repo.
 */
export function gitWorktreeRoot(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()
    return out ? realpath(out) : null
  } catch {
    return null
  }
}

export interface WorktreeIndexMismatch {
  worktreeRoot: string
  indexRoot: string
}

/**
 * Detect when `startPath` lives in one git working tree but the resolved
 * index (`indexRoot`) belongs to a *different* working tree.
 */
export function detectWorktreeIndexMismatch(
  startPath: string,
  indexRoot: string,
): WorktreeIndexMismatch | null {
  const worktreeRoot = gitWorktreeRoot(startPath)
  if (!worktreeRoot) return null

  const resolvedIndexRoot = realpath(indexRoot)
  if (worktreeRoot === resolvedIndexRoot) return null

  // Only flag when the index root is itself a real working-tree root.
  if (gitWorktreeRoot(resolvedIndexRoot) !== resolvedIndexRoot) return null

  return { worktreeRoot, indexRoot: resolvedIndexRoot }
}

/** One-line-per-fact warning describing a detected mismatch. */
export function worktreeMismatchWarning(m: WorktreeIndexMismatch): string {
  return (
    `This graph index belongs to a different git working tree.\n` +
    `  Running in: ${m.worktreeRoot}\n` +
    `  Index from: ${m.indexRoot}\n` +
    `Results reflect that tree's code, not this worktree.`
  )
}

/** Compact, single-line variant for prefixing a tool's result. */
export function worktreeMismatchNotice(m: WorktreeIndexMismatch): string {
  return (
    `Graph results below come from a different git worktree (${m.indexRoot}), ` +
    `not where you're working (${m.worktreeRoot}) — they may reflect another branch.`
  )
}

/** Resolve symlinks where possible. */
function realpath(p: string): string {
  try {
    return realpathSync(resolve(p))
  } catch {
    return resolve(p)
  }
}
