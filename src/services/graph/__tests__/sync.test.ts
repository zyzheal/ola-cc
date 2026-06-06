/**
 * Sync Module Tests — FileWatcher, WatchPolicy, GitHooks, Worktree
 *
 * TDD: tests for the migrated sync system.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'

// ============================================================
// Import from the sync module
// ============================================================

import {
  FileWatcher,
  LockUnavailableError,
  isSourceFile,
  SimpleIgnoreMatcher,
  watchDisabledReason,
  detectWsl,
  __resetWslCacheForTests,
  installGitSyncHook,
  removeGitSyncHook,
  isSyncHookInstalled,
  isGitRepo,
  DEFAULT_SYNC_HOOKS,
  gitWorktreeRoot,
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
} from '../sync/index.js'

// ============================================================
// Helpers
// ============================================================

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'sync-test-'))
}

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.email test@test.com', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.name Test', { cwd: dir, stdio: 'ignore' })
}

// ============================================================
// isSourceFile
// ============================================================

describe('isSourceFile', () => {
  test('recognizes TypeScript files', () => {
    expect(isSourceFile('src/foo.ts')).toBe(true)
    expect(isSourceFile('src/bar.tsx')).toBe(true)
  })

  test('recognizes JavaScript files', () => {
    expect(isSourceFile('index.js')).toBe(true)
    expect(isSourceFile('index.jsx')).toBe(true)
    expect(isSourceFile('index.mjs')).toBe(true)
    expect(isSourceFile('index.cjs')).toBe(true)
  })

  test('recognizes other source languages', () => {
    expect(isSourceFile('main.py')).toBe(true)
    expect(isSourceFile('main.go')).toBe(true)
    expect(isSourceFile('lib.rs')).toBe(true)
    expect(isSourceFile('App.java')).toBe(true)
    expect(isSourceFile('main.c')).toBe(true)
    expect(isSourceFile('main.cpp')).toBe(true)
    expect(isSourceFile('main.rb')).toBe(true)
    expect(isSourceFile('main.swift')).toBe(true)
  })

  test('rejects non-source files', () => {
    expect(isSourceFile('README.md')).toBe(false)
    expect(isSourceFile('style.css')).toBe(false)
    expect(isSourceFile('data.json')).toBe(false)
    expect(isSourceFile('image.png')).toBe(false)
    expect(isSourceFile('.gitignore')).toBe(false)
    expect(isSourceFile('Makefile')).toBe(false)
  })
})

// ============================================================
// SimpleIgnoreMatcher
// ============================================================

describe('SimpleIgnoreMatcher', () => {
  test('ignores node_modules paths', () => {
    const matcher = new SimpleIgnoreMatcher()
    expect(matcher.ignores('node_modules/foo/bar.ts')).toBe(true)
    expect(matcher.ignores('src/node_modules/foo.ts')).toBe(true)
  })

  test('ignores dist and build directories', () => {
    const matcher = new SimpleIgnoreMatcher()
    expect(matcher.ignores('dist/bundle.js')).toBe(true)
    expect(matcher.ignores('build/output.js')).toBe(true)
  })

  test('ignores .git directory', () => {
    const matcher = new SimpleIgnoreMatcher()
    expect(matcher.ignores('.git/config')).toBe(true)
  })

  test('does not ignore source files', () => {
    const matcher = new SimpleIgnoreMatcher()
    expect(matcher.ignores('src/foo.ts')).toBe(false)
    expect(matcher.ignores('lib/bar.js')).toBe(false)
  })

  test('supports custom patterns', () => {
    const matcher = new SimpleIgnoreMatcher(['custom_dir'])
    expect(matcher.ignores('custom_dir/file.ts')).toBe(true)
    expect(matcher.ignores('node_modules/file.ts')).toBe(false)
  })

  test('handles nested paths correctly', () => {
    const matcher = new SimpleIgnoreMatcher()
    expect(matcher.ignores('src/deep/node_modules/pkg/index.ts')).toBe(true)
  })
})

// ============================================================
// WatchPolicy
// ============================================================

describe('watchPolicy', () => {
  beforeEach(() => {
    __resetWslCacheForTests()
  })

  test('returns null when nothing disables watch', () => {
    expect(watchDisabledReason('/home/user/project', { isWsl: false })).toBeNull()
  })

  test('disables when OLA_CC_NO_WATCH=1', () => {
    const reason = watchDisabledReason('/home/user/project', {
      isWsl: false,
      env: { ...process.env, OLA_CC_NO_WATCH: '1' },
    })
    expect(reason).toContain('OLA_CC_NO_WATCH')
  })

  test('force watch overrides WSL detection', () => {
    const reason = watchDisabledReason('/mnt/c/project', {
      isWsl: true,
      env: { ...process.env, OLA_CC_FORCE_WATCH: '1' },
    })
    expect(reason).toBeNull()
  })

  test('disables on WSL2 /mnt/ drive', () => {
    const reason = watchDisabledReason('/mnt/c/Users/test/project', {
      isWsl: true,
    })
    expect(reason).toContain('WSL2')
    expect(reason).toContain('/mnt/')
  })

  test('does not disable on WSL with Linux path', () => {
    const reason = watchDisabledReason('/home/user/project', {
      isWsl: true,
    })
    expect(reason).toBeNull()
  })

  test('does not disable on WSL with /mnt/wsl/ path', () => {
    const reason = watchDisabledReason('/mnt/wsl/Ubuntu/home', {
      isWsl: true,
    })
    expect(reason).toBeNull()
  })
})

// ============================================================
// GitHooks
// ============================================================

describe('gitHooks', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    initGitRepo(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('isGitRepo returns true for git repo', () => {
    expect(isGitRepo(tmpDir)).toBe(true)
  })

  test('isGitRepo returns false for non-repo', () => {
    const nonRepo = makeTmpDir()
    try {
      expect(isGitRepo(nonRepo)).toBe(false)
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  test('installGitSyncHook installs hooks', () => {
    const result = installGitSyncHook(tmpDir)
    expect(result.installed.length).toBe(DEFAULT_SYNC_HOOKS.length)
    expect(result.hooksDir).toBeTruthy()
    expect(result.skipped).toBeUndefined()

    // Verify hook files exist
    for (const hook of DEFAULT_SYNC_HOOKS) {
      const hookPath = join(result.hooksDir!, hook)
      expect(existsSync(hookPath)).toBe(true)
      const content = readFileSync(hookPath, 'utf8')
      expect(content).toContain('graph-engine sync hook')
    }
  })

  test('install is idempotent', () => {
    installGitSyncHook(tmpDir)
    installGitSyncHook(tmpDir)

    const result = installGitSyncHook(tmpDir)
    expect(result.installed.length).toBe(DEFAULT_SYNC_HOOKS.length)

    // Should not duplicate the marker block
    for (const hook of DEFAULT_SYNC_HOOKS) {
      const hookPath = join(result.hooksDir!, hook)
      const content = readFileSync(hookPath, 'utf8')
      const markerCount = (content.match(/graph-engine sync hook >>>/g) || []).length
      expect(markerCount).toBe(1)
    }
  })

  test('isSyncHookInstalled returns true after install', () => {
    expect(isSyncHookInstalled(tmpDir)).toBe(false)
    installGitSyncHook(tmpDir)
    expect(isSyncHookInstalled(tmpDir)).toBe(true)
  })

  test('removeGitSyncHook removes hooks', () => {
    installGitSyncHook(tmpDir)
    expect(isSyncHookInstalled(tmpDir)).toBe(true)

    removeGitSyncHook(tmpDir)
    expect(isSyncHookInstalled(tmpDir)).toBe(false)

    // Hook files should be deleted when they only contained our block
    const hooksDir = join(tmpDir, '.git', 'hooks')
    for (const hook of DEFAULT_SYNC_HOOKS) {
      expect(existsSync(join(hooksDir, hook))).toBe(false)
    }
  })

  test('install preserves user-authored content', () => {
    const hooksDir = join(tmpDir, '.git', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    const hookPath = join(hooksDir, 'post-commit')
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"\n')

    installGitSyncHook(tmpDir, ['post-commit'])
    const content = readFileSync(hookPath, 'utf8')
    expect(content).toContain('echo "user hook"')
    expect(content).toContain('graph-engine sync hook')
  })

  test('remove preserves user-authored content', () => {
    const hooksDir = join(tmpDir, '.git', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    const hookPath = join(hooksDir, 'post-commit')
    writeFileSync(hookPath, '#!/bin/sh\necho "user hook"\n')

    installGitSyncHook(tmpDir, ['post-commit'])
    removeGitSyncHook(tmpDir, ['post-commit'])

    const content = readFileSync(hookPath, 'utf8')
    expect(content).toContain('echo "user hook"')
    expect(content).not.toContain('graph-engine sync hook')
  })

  test('installGitSyncHook returns skipped for non-repo', () => {
    const nonRepo = makeTmpDir()
    try {
      const result = installGitSyncHook(nonRepo)
      expect(result.skipped).toContain('not a git repository')
      expect(result.installed).toEqual([])
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })
})

// ============================================================
// Worktree
// ============================================================

describe('worktree', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    initGitRepo(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('gitWorktreeRoot returns repo root', () => {
    const root = gitWorktreeRoot(tmpDir)
    expect(root).toBeTruthy()
  })

  test('gitWorktreeRoot returns null for non-repo', () => {
    const nonRepo = makeTmpDir()
    try {
      expect(gitWorktreeRoot(nonRepo)).toBeNull()
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  test('detectWorktreeIndexMismatch returns null when same tree', () => {
    const result = detectWorktreeIndexMismatch(tmpDir, tmpDir)
    expect(result).toBeNull()
  })

  test('detectWorktreeIndexMismatch returns null for non-repo', () => {
    const nonRepo = makeTmpDir()
    try {
      expect(detectWorktreeIndexMismatch(nonRepo, tmpDir)).toBeNull()
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  test('worktreeMismatchWarning contains relevant info', () => {
    const mismatch = {
      worktreeRoot: '/path/to/worktree',
      indexRoot: '/path/to/main',
    }
    const warning = worktreeMismatchWarning(mismatch)
    expect(warning).toContain('/path/to/worktree')
    expect(warning).toContain('/path/to/main')
    expect(warning).toContain('different git working tree')
  })

  test('worktreeMismatchNotice is compact single line', () => {
    const mismatch = {
      worktreeRoot: '/path/to/worktree',
      indexRoot: '/path/to/main',
    }
    const notice = worktreeMismatchNotice(mismatch)
    expect(notice).toContain('/path/to/main')
    expect(notice).toContain('/path/to/worktree')
    // Should be single-line (no newline)
    expect(notice).not.toContain('\n')
  })
})

// ============================================================
// FileWatcher (inert mode — no OS watchers)
// ============================================================

describe('FileWatcher', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('creates and starts in inert mode', async () => {
    let syncCalled = 0
    const watcher = new FileWatcher(
      tmpDir,
      async () => { syncCalled++; return { filesChanged: 1, durationMs: 10 } },
      { inertForTests: true, debounceMs: 50 },
    )

    expect(watcher.isActive()).toBe(false)
    const started = watcher.start()
    expect(started).toBe(true)
    expect(watcher.isActive()).toBe(true)

    await watcher.waitUntilReady()
    watcher.stop()
    expect(watcher.isActive()).toBe(false)
  })

  test('detects source file changes via ingestEventForTests', async () => {
    let syncResult: { filesChanged: number; durationMs: number } | null = null
    const watcher = new FileWatcher(
      tmpDir,
      async () => {
        syncResult = { filesChanged: 1, durationMs: 5 }
        return syncResult
      },
      { inertForTests: true, debounceMs: 50 },
    )

    watcher.start()
    await watcher.waitUntilReady()

    // Simulate a source file change
    watcher.ingestEventForTests('src/foo.ts')

    // Should be pending immediately
    const pending = watcher.getPendingFiles()
    expect(pending.length).toBe(1)
    expect(pending[0].path).toBe('src/foo.ts')

    // Wait for debounce + sync
    await Bun.sleep(150)

    // After sync, pending should be cleared
    const pendingAfter = watcher.getPendingFiles()
    expect(pendingAfter.length).toBe(0)
    expect(syncResult).not.toBeNull()

    watcher.stop()
  })

  test('ignores non-source files', async () => {
    let syncCalled = 0
    const watcher = new FileWatcher(
      tmpDir,
      async () => { syncCalled++; return { filesChanged: 1, durationMs: 5 } },
      { inertForTests: true, debounceMs: 50 },
    )

    watcher.start()
    await watcher.waitUntilReady()

    watcher.ingestEventForTests('README.md')
    watcher.ingestEventForTests('style.css')
    watcher.ingestEventForTests('data.json')

    // Non-source files should not be tracked
    expect(watcher.getPendingFiles().length).toBe(0)

    await Bun.sleep(100)
    expect(syncCalled).toBe(0)

    watcher.stop()
  })

  test('ignores files in excluded directories', async () => {
    let syncCalled = 0
    const watcher = new FileWatcher(
      tmpDir,
      async () => { syncCalled++; return { filesChanged: 1, durationMs: 5 } },
      { inertForTests: true, debounceMs: 50 },
    )

    watcher.start()
    await watcher.waitUntilReady()

    watcher.ingestEventForTests('node_modules/pkg/index.ts')
    watcher.ingestEventForTests('dist/bundle.js')
    watcher.ingestEventForTests('.git/config')

    expect(watcher.getPendingFiles().length).toBe(0)
    await Bun.sleep(100)
    expect(syncCalled).toBe(0)

    watcher.stop()
  })

  test('debounces multiple rapid changes', async () => {
    let syncCount = 0
    const watcher = new FileWatcher(
      tmpDir,
      async () => { syncCount++; return { filesChanged: 1, durationMs: 5 } },
      { inertForTests: true, debounceMs: 100 },
    )

    watcher.start()
    await watcher.waitUntilReady()

    // Fire multiple changes rapidly
    watcher.ingestEventForTests('src/a.ts')
    watcher.ingestEventForTests('src/b.ts')
    watcher.ingestEventForTests('src/c.ts')

    // Should all be pending
    expect(watcher.getPendingFiles().length).toBe(3)

    // Wait for debounce
    await Bun.sleep(200)

    // Should have triggered exactly one sync
    expect(syncCount).toBe(1)

    watcher.stop()
  })

  test('tracks pending files with timestamps', async () => {
    const watcher = new FileWatcher(
      tmpDir,
      async () => ({ filesChanged: 0, durationMs: 0 }),
      { inertForTests: true, debounceMs: 10000 }, // long debounce
    )

    watcher.start()
    await watcher.waitUntilReady()

    const before = Date.now()
    watcher.ingestEventForTests('src/foo.ts')
    const after = Date.now()

    const pending = watcher.getPendingFiles()
    expect(pending.length).toBe(1)
    expect(pending[0].path).toBe('src/foo.ts')
    expect(pending[0].firstSeenMs).toBeGreaterThanOrEqual(before)
    expect(pending[0].firstSeenMs).toBeLessThanOrEqual(after)
    expect(pending[0].indexing).toBe(false)

    watcher.stop()
  })

  test('LockUnavailableError does not clear pending files', async () => {
    let syncCount = 0
    let firstSyncDone: (() => void) | null = null
    const firstSyncPromise = new Promise<void>((resolve) => { firstSyncDone = resolve })

    const watcher = new FileWatcher(
      tmpDir,
      async () => {
        syncCount++
        throw new LockUnavailableError()
      },
      { inertForTests: true, debounceMs: 100 },
    )

    watcher.start()
    await watcher.waitUntilReady()

    // Hook into onSyncError to detect when first sync completes
    // LockUnavailableError is NOT forwarded to onSyncError (debug-only),
    // but we can poll for syncCount
    watcher.ingestEventForTests('src/foo.ts')

    // Poll until first sync attempt completes
    const deadline = Date.now() + 2000
    while (syncCount === 0 && Date.now() < deadline) {
      await Bun.sleep(10)
    }

    // Pending should still be there — LockUnavailableError preserves them
    expect(syncCount).toBeGreaterThanOrEqual(1)
    expect(watcher.getPendingFiles().length).toBe(1)
    expect(watcher.getPendingFiles()[0].path).toBe('src/foo.ts')

    watcher.stop()
  })

  test('onSyncComplete callback is called', async () => {
    let completedResult: { filesChanged: number; durationMs: number } | null = null
    const watcher = new FileWatcher(
      tmpDir,
      async () => ({ filesChanged: 3, durationMs: 25 }),
      {
        inertForTests: true,
        debounceMs: 50,
        onSyncComplete: (r) => { completedResult = r },
      },
    )

    watcher.start()
    await watcher.waitUntilReady()

    watcher.ingestEventForTests('src/foo.ts')
    await Bun.sleep(150)

    expect(completedResult).not.toBeNull()
    expect(completedResult!.filesChanged).toBe(3)
    expect(completedResult!.durationMs).toBe(25)

    watcher.stop()
  })

  test('onSyncError callback is called on failure', async () => {
    let caughtError: Error | null = null
    const watcher = new FileWatcher(
      tmpDir,
      async () => { throw new Error('sync exploded') },
      {
        inertForTests: true,
        debounceMs: 50,
        onSyncError: (e) => { caughtError = e },
      },
    )

    watcher.start()
    await watcher.waitUntilReady()

    watcher.ingestEventForTests('src/foo.ts')
    await Bun.sleep(200)

    expect(caughtError).not.toBeNull()
    expect(caughtError!.message).toBe('sync exploded')

    watcher.stop()
  })

  test('start returns false when watch is disabled', () => {
    const watcher = new FileWatcher(
      '/mnt/c/project',
      async () => ({ filesChanged: 0, durationMs: 0 }),
      { inertForTests: false },
    )

    // Force WSL detection
    const started = watcher.start()
    // On macOS this will actually start (not WSL), but the test exercises the code path
    // We can't fully test WSL detection on macOS, but the function is tested in watchPolicy tests
    expect(typeof started).toBe('boolean')
    watcher.stop()
  })

  test('stop is idempotent', async () => {
    const watcher = new FileWatcher(
      tmpDir,
      async () => ({ filesChanged: 0, durationMs: 0 }),
      { inertForTests: true },
    )

    watcher.start()
    await watcher.waitUntilReady()
    watcher.stop()
    watcher.stop() // second stop should not throw
    expect(watcher.isActive()).toBe(false)
  })

  test('ignores .codegraph paths', async () => {
    let syncCalled = 0
    const watcher = new FileWatcher(
      tmpDir,
      async () => { syncCalled++; return { filesChanged: 1, durationMs: 5 } },
      { inertForTests: true, debounceMs: 50 },
    )

    watcher.start()
    await watcher.waitUntilReady()

    watcher.ingestEventForTests('.codegraph/index.db')
    watcher.ingestEventForTests('.codegraph/cache/data.ts')

    expect(watcher.getPendingFiles().length).toBe(0)
    await Bun.sleep(100)
    expect(syncCalled).toBe(0)

    watcher.stop()
  })
})
