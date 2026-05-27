/**
 * Singularity Storage — ExecutionRecord 持久化
 *
 * Phase 4 Task 1: JSONL 文件持久化
 * - 按 skill 分文件存储
 * - 追加写入（append-only）
 * - 支持按时间范围和数量裁剪
 * - 原子写入防损坏
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const STORAGE_DIR = path.join(os.homedir(), '.ola-cc', 'singularity', 'execution-history')

/**
 * 确保存储目录存在
 */
function ensureDir(): void {
  fs.mkdirSync(STORAGE_DIR, { recursive: true })
}

/**
 * 获取某 skill 的 JSONL 文件路径
 */
function getFilePath(skill: string): string {
  //  sanitize skill name for filename
  const safe = skill.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(STORAGE_DIR, `${safe}.jsonl`)
}

/**
 * 保存一条执行记录（追加到 JSONL）
 *
 * @param skill - 技能名称
 * @param record - 执行记录（不含 id，由调用方生成）
 * @returns 写入的 JSON 字符串
 */
export function saveExecutionRecord(
  skill: string,
  record: Record<string, unknown>,
): string {
  ensureDir()
  const filepath = getFilePath(skill)
  const line = JSON.stringify(record) + '\n'
  // 原子写入：先写临时文件再 rename（避免并发写入行交错）
  // 但对 JSONL 来说 append 是安全的，行交错只影响读取不损坏数据
  fs.appendFileSync(filepath, line, 'utf-8')
  return line.trim()
}

/**
 * 批量保存执行记录（初始化时恢复）
 */
export function saveExecutionRecords(
  skill: string,
  records: Record<string, unknown>[],
): void {
  ensureDir()
  const filepath = getFilePath(skill)
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n'
  // 原子写入：先写 tmp 再 rename，保证完整写入
  const tmp = filepath + '.tmp.' + process.pid
  fs.writeFileSync(tmp, lines, 'utf-8')
  fs.renameSync(tmp, filepath)
}

/**
 * 加载某 skill 的全部执行历史
 *
 * @param skill - 技能名称
 * @returns 解析后的记录数组
 */
export function loadExecutionHistory(
  skill: string,
): Record<string, unknown>[] {
  const filepath = getFilePath(skill)
  if (!fs.existsSync(filepath)) return []

  const content = fs.readFileSync(filepath, 'utf-8')
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
}

/**
 * 裁剪某 skill 的历史记录（防污染）
 *
 * 保留最新的 maxRecords 条，删除更早的
 *
 * @param skill - 技能名称
 * @param maxRecords - 最大保留条数（默认 500）
 * @returns 删除的条数
 */
export function pruneExecutionHistory(
  skill: string,
  maxRecords = 500,
): number {
  const filepath = getFilePath(skill)
  if (!fs.existsSync(filepath)) return 0

  const content = fs.readFileSync(filepath, 'utf-8')
  const lines = content
    .split('\n')
    .filter(line => line.trim().length > 0)

  if (lines.length <= maxRecords) return 0

  const pruned = lines.length - maxRecords
  // 只保留最新的 maxRecords 条
  const kept = lines.slice(lines.length - maxRecords)

  // 原子重写
  const tmp = filepath + '.tmp.' + process.pid
  fs.writeFileSync(tmp, kept.join('\n') + '\n', 'utf-8')
  fs.renameSync(tmp, filepath)

  return pruned
}

/**
 * 获取存储统计
 */
export function getStorageStats(): {
  skills: string[]
  totalRecords: number
  storagePath: string
} {
  ensureDir()
  const files = fs.readdirSync(STORAGE_DIR).filter(f => f.endsWith('.jsonl'))
  const skills = files.map(f => f.replace(/\.jsonl$/, '').replace(/_/g, '-'))
  let totalRecords = 0
  for (const f of files) {
    const content = fs.readFileSync(path.join(STORAGE_DIR, f), 'utf-8')
    totalRecords += content.split('\n').filter(l => l.trim().length > 0).length
  }
  return { skills, totalRecords, storagePath: STORAGE_DIR }
}

/**
 * 防污染：按时间分割训练/测试集
 *
 * 返回 { train, test }，test 为最新的 testRatio 比例
 *
 * @param records - 执行记录数组（已按时间排序）
 * @param testRatio - 测试集比例（默认 0.2 = 20%）
 */
export function trainTestSplit<T>(
  records: T[],
  testRatio = 0.2,
): { train: T[]; test: T[] } {
  const splitIndex = Math.floor(records.length * (1 - testRatio))
  return {
    train: records.slice(0, splitIndex),
    test: records.slice(splitIndex),
  }
}
