/**
 * Sync Module — Re-exports
 *
 * Provides synchronization functionality for keeping the code graph
 * up-to-date with file system changes.
 */

export { FileWatcher, type WatchOptions, type PendingFile, LockUnavailableError } from './FileWatcher.js'
export { isSourceFile, SimpleIgnoreMatcher } from './FileWatcher.js'
export { watchDisabledReason, detectWsl, __resetWslCacheForTests } from './watchPolicy.js'
export {
  installGitSyncHook,
  removeGitSyncHook,
  isSyncHookInstalled,
  isGitRepo,
  DEFAULT_SYNC_HOOKS,
  type GitHookName,
  type GitHookResult,
} from './gitHooks.js'
export {
  gitWorktreeRoot,
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from './worktree.js'
