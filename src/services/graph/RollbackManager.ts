/**
 * RollbackManager — 图快照回滚管理器
 *
 * 提供 knowledge-graph.json 的备份、列表、回滚功能。
 * 备份存储在 .understand-anything/backups/ 目录。
 *
 * F-114: Rollback Strategy
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, copyFileSync } from 'fs'
import { resolve, join } from 'path'
import { logForDebugging } from '../../utils/debug.js'

// ============================================================
// Types
// ============================================================

export interface RollbackPoint {
  tag: string
  timestamp: number
  description: string
  nodeCount: number
  edgeCount: number
}

// ============================================================
// RollbackManager
// ============================================================

export class RollbackManager {
  private uaDir: string
  private backupsDir: string
  private kgPath: string

  constructor(private projectRoot: string) {
    this.uaDir = resolve(projectRoot, '.understand-anything')
    this.backupsDir = join(this.uaDir, 'backups')
    this.kgPath = join(this.uaDir, 'knowledge-graph.json')
  }

  /**
   * 创建回滚点（备份当前 knowledge-graph.json）
   */
  createRollback(description: string): RollbackPoint {
    if (!existsSync(this.kgPath)) {
      throw new Error(`knowledge-graph.json not found at ${this.kgPath}`)
    }

    // 确保 backups 目录存在
    if (!existsSync(this.backupsDir)) {
      mkdirSync(this.backupsDir, { recursive: true })
    }

    // 读取当前图数据统计
    const content = readFileSync(this.kgPath, 'utf-8')
    const graph = JSON.parse(content)
    const nodeCount = Array.isArray(graph.nodes) ? graph.nodes.length : 0
    const edgeCount = Array.isArray(graph.edges) ? graph.edges.length : 0

    // 生成 tag: timestamp + 短哈希
    const timestamp = Date.now()
    const tag = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`

    // 复制到 backups 目录
    const backupPath = join(this.backupsDir, `knowledge-graph.${tag}.json`)
    writeFileSync(backupPath, content, 'utf-8')

    // 保存元数据
    const meta: RollbackPoint = {
      tag,
      timestamp,
      description,
      nodeCount,
      edgeCount,
    }
    const metaPath = join(this.backupsDir, `knowledge-graph.${tag}.meta.json`)
    writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')

    logForDebugging(`RollbackManager: created rollback point "${tag}" (${description})`)
    return meta
  }

  /**
   * 列出所有可用的回滚点
   */
  listRollbacks(): RollbackPoint[] {
    if (!existsSync(this.backupsDir)) {
      return []
    }

    const files = readdirSync(this.backupsDir)
    const metaFiles = files.filter(f => f.endsWith('.meta.json'))
    const rollbacks: RollbackPoint[] = []

    for (const metaFile of metaFiles) {
      try {
        const metaPath = join(this.backupsDir, metaFile)
        const content = readFileSync(metaPath, 'utf-8')
        const meta = JSON.parse(content) as RollbackPoint

        // 验证对应的备份文件存在
        const backupPath = join(this.backupsDir, `knowledge-graph.${meta.tag}.json`)
        if (existsSync(backupPath)) {
          rollbacks.push(meta)
        }
      } catch {
        // 跳过损坏的元数据文件
      }
    }

    // 按时间戳降序排列（最新的在前）
    rollbacks.sort((a, b) => b.timestamp - a.timestamp)
    return rollbacks
  }

  /**
   * 回滚到指定的回滚点
   * @returns true 回滚成功, false 回滚点不存在
   */
  rollback(tag: string): boolean {
    const backupPath = join(this.backupsDir, `knowledge-graph.${tag}.json`)

    if (!existsSync(backupPath)) {
      logForDebugging(`RollbackManager: rollback point "${tag}" not found`)
      return false
    }

    // 确保目标目录存在
    if (!existsSync(this.uaDir)) {
      mkdirSync(this.uaDir, { recursive: true })
    }

    // 先备份当前状态（安全网）
    if (existsSync(this.kgPath)) {
      const safetyTag = `pre-rollback-${Date.now()}`
      const safetyPath = join(this.backupsDir, `knowledge-graph.${safetyTag}.json`)
      if (!existsSync(this.backupsDir)) {
        mkdirSync(this.backupsDir, { recursive: true })
      }
      copyFileSync(this.kgPath, safetyPath)

      // 写入元数据以便 listRollbacks 能发现
      const safetyContent = readFileSync(this.kgPath, 'utf-8')
      const safetyGraph = JSON.parse(safetyContent)
      const safetyMeta: RollbackPoint = {
        tag: safetyTag,
        timestamp: Date.now(),
        description: 'Auto-safety backup before rollback',
        nodeCount: Array.isArray(safetyGraph.nodes) ? safetyGraph.nodes.length : 0,
        edgeCount: Array.isArray(safetyGraph.edges) ? safetyGraph.edges.length : 0,
      }
      const safetyMetaPath = join(this.backupsDir, `knowledge-graph.${safetyTag}.meta.json`)
      writeFileSync(safetyMetaPath, JSON.stringify(safetyMeta, null, 2), 'utf-8')
    }

    // 执行回滚
    copyFileSync(backupPath, this.kgPath)

    logForDebugging(`RollbackManager: rolled back to "${tag}"`)
    return true
  }

  /**
   * 删除指定回滚点
   */
  deleteRollback(tag: string): boolean {
    const backupPath = join(this.backupsDir, `knowledge-graph.${tag}.json`)
    const metaPath = join(this.backupsDir, `knowledge-graph.${tag}.meta.json`)

    if (!existsSync(backupPath)) {
      return false
    }

    unlinkSync(backupPath)
    if (existsSync(metaPath)) {
      unlinkSync(metaPath)
    }

    logForDebugging(`RollbackManager: deleted rollback point "${tag}"`)
    return true
  }

  /**
   * 清理旧回滚点，保留最近 N 个
   */
  prune(maxKeep = 10): number {
    const rollbacks = this.listRollbacks()
    if (rollbacks.length <= maxKeep) {
      return 0
    }

    const toDelete = rollbacks.slice(maxKeep)
    for (const rb of toDelete) {
      this.deleteRollback(rb.tag)
    }

    logForDebugging(`RollbackManager: pruned ${toDelete.length} old rollback points`)
    return toDelete.length
  }
}
