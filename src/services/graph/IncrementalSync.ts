/**
 * IncrementalSync — 三级变更检测
 *
 * 检测图数据是否需要刷新:
 *   Level 1: git diff（最快，检查 tracked 文件变更）
 *   Level 2: mtime（检查 .codegraph/codegraph.db 修改时间）
 *   Level 3: hash（最慢，比较 db 内容哈希）
 *
 * 设计文档: docs/superpowers/specs/2026-06-05-codegraph-grok-enhancement-design.md
 */

import { execFileSync } from 'child_process'
import { statSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { resolve } from 'path'
import type { GraphStore } from './GraphStore.js'

export type SyncReason = 'none' | 'git-diff' | 'mtime' | 'hash'

export interface DetectResult {
  dirty: boolean
  changedFiles: string[]
  reason: SyncReason
}

export class IncrementalSync {
  private lastMtime: number | null = null
  private lastHash: string | null = null

  constructor(
    private store: GraphStore,
    private projectRoot: string = process.cwd(),
  ) {}

  /**
   * 三级变更检测
   *
   * Level 1 (git diff): 最快 — 检查 codegraph 源文件是否有 tracked 变更
   * Level 2 (mtime): 中等 — 检查 .codegraph/codegraph.db 修改时间是否变化
   * Level 3 (hash): 最慢 — 计算 db 文件内容 SHA-256 哈希
   */
  detect(): DetectResult {
    const dbPath = resolve(this.projectRoot, '.codegraph', 'codegraph.db')

    // Level 1: git diff — 检查自上次以来是否有源文件变更
    const gitResult = this.detectGitDiff()
    if (gitResult.dirty) {
      return gitResult
    }

    // Level 2: mtime — 检查 db 文件修改时间
    const mtimeResult = this.detectMtime(dbPath)
    if (mtimeResult.dirty) {
      return mtimeResult
    }

    // Level 3: hash — 比较 db 文件内容哈希
    const hashResult = this.detectHash(dbPath)
    if (hashResult.dirty) {
      return hashResult
    }

    return { dirty: false, changedFiles: [], reason: 'none' }
  }

  /**
   * 同步: 标记脏 + 重新加载
   */
  async sync(): Promise<void> {
    this.store.markDirty()
    await this.store.load()

    // 更新缓存的 mtime 和 hash
    const dbPath = resolve(this.projectRoot, '.codegraph', 'codegraph.db')
    try {
      const stat = statSync(dbPath)
      this.lastMtime = stat.mtimeMs
      this.lastHash = this.computeHash(dbPath)
    } catch {
      // db 文件可能不存在，忽略
    }
  }

  /**
   * Mark files as clean after CLI sync.
   * Updates the cached hash/mtime so the next detect() doesn't re-trigger for these files.
   */
  markClean(_files?: string[]): void {
    const dbPath = resolve(this.projectRoot, '.codegraph', 'codegraph.db')
    try {
      const stat = statSync(dbPath)
      this.lastMtime = stat.mtimeMs
      this.lastHash = this.computeHash(dbPath)
    } catch {
      // db file may not exist
    }
  }

  // ── Private detection methods ──

  private detectGitDiff(): DetectResult {
    try {
      const output = execFileSync(
        'git', ['diff', '--name-only', 'HEAD', '--', '*.ts', '*.tsx', '*.js', '*.jsx'],
        { cwd: this.projectRoot, encoding: 'utf-8', timeout: 5000 },
      ).trim()

      if (output.length === 0) {
        return { dirty: false, changedFiles: [], reason: 'none' }
      }

      const changedFiles = output.split('\n').filter(f => f.length > 0)
      return { dirty: true, changedFiles, reason: 'git-diff' }
    } catch {
      // git 不可用或不在 git 仓库中，降级到下一级
      return { dirty: false, changedFiles: [], reason: 'none' }
    }
  }

  private detectMtime(dbPath: string): DetectResult {
    try {
      const stat = statSync(dbPath)
      const currentMtime = stat.mtimeMs

      if (this.lastMtime !== null && currentMtime !== this.lastMtime) {
        this.lastMtime = currentMtime
        return { dirty: true, changedFiles: [], reason: 'mtime' }
      }

      // 首次运行: 记录 mtime 但不报告 dirty
      if (this.lastMtime === null) {
        this.lastMtime = currentMtime
      }

      return { dirty: false, changedFiles: [], reason: 'none' }
    } catch {
      return { dirty: false, changedFiles: [], reason: 'none' }
    }
  }

  private detectHash(dbPath: string): DetectResult {
    try {
      const currentHash = this.computeHash(dbPath)

      if (this.lastHash !== null && currentHash !== this.lastHash) {
        this.lastHash = currentHash
        return { dirty: true, changedFiles: [], reason: 'hash' }
      }

      // 首次运行: 记录 hash 但不报告 dirty
      if (this.lastHash === null) {
        this.lastHash = currentHash
      }

      return { dirty: false, changedFiles: [], reason: 'none' }
    } catch {
      return { dirty: false, changedFiles: [], reason: 'none' }
    }
  }

  private computeHash(filePath: string): string {
    const content = readFileSync(filePath)
    return createHash('sha256').update(content).digest('hex')
  }
}
