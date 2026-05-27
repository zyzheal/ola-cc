/**
 * Singularity Storage — ExecutionRecord 持久化
 *
 * Phase 4 Task 1: JSONL 文件持久化
 * - 按 skill 分文件存储
 * - 追加写入（append-only）
 * - 支持按时间范围和数量裁剪
 * - 原子写入防损坏
 *
 * Anti-contamination Layer 2: workspace whitelist
 * 进化过程只能写入白名单路径，防止污染主项目文件
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const STORAGE_DIR = path.join(os.homedir(), '.ola-cc', 'singularity', 'execution-history')

// ============================================
// 防污染 Layer 2: workspace 白名单
// ============================================

/**
 * 进化引擎允许写入的路径白名单
 *
 * ASAEF 设计约束：进化过程中只允许修改白名单路径内的文件，
 * 任何试图写入白名单外路径的操作都被拒绝。
 * 这防止进化引擎意外修改主项目代码或配置。
 */
const WORKSPACE_WHITELIST: string[] = [
  // singularity 数据目录（评分、遥测、注册表）
  path.join(os.homedir(), '.ola-cc', 'singularity'),
  // skill 定义目录（SKILL.md 及 references/）
  path.join(os.homedir(), '.ola-cc', 'skills'),
  // 进化 workspace 目录（P0 创建的隔离环境）
  path.join(os.homedir(), '.ola-cc', 'singularity', 'evolve-workspaces'),
  // config 文件
  path.join(os.homedir(), '.ola-cc', 'singularity', 'config.json'),
]

/**
 * 检查路径是否在白名单内
 *
 * @param filePath - 要写入的文件路径
 * @returns 是否允许写入
 */
export function isWhitelistedPath(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  return WORKSPACE_WHITELIST.some(whitelistDir => {
    // 检查路径是否在白名单目录下（包括子目录）
    return resolved.startsWith(whitelistDir + path.sep) || resolved === whitelistDir
  })
}

/**
 * 验证写入路径并抛出错误（用于强制校验）
 *
 * @param filePath - 要写入的文件路径
 * @throws 如果路径不在白名单内
 */
export function validateWhitelistedPath(filePath: string): void {
  if (!isWhitelistedPath(filePath)) {
    throw new Error(
      `Anti-contamination violation: path "${filePath}" is outside workspace whitelist. ` +
      `Evolution engine can only write to: ${WORKSPACE_WHITELIST.join(', ')}`
    )
  }
}

/**
 * 获取当前白名单配置（用于展示和调试）
 */
export function getWhitelist(): string[] {
  return [...WORKSPACE_WHITELIST]
}

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
