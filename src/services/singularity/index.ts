/**
 * Singularity Service — 自进化技能引擎
 *
 * 基于 singularity-claude v0.1.0 适配：
 * - 路径: ~/.claude → ~/.ola-cc
 * - 脚本: Bash → TypeScript (Windows 兼容)
 * - 数据格式: 兼容 singularity-score-v1 / singularity-telemetry-v1 schema
 *
 * 核心功能：
 * 1. ScoreManager — 评分记录、趋势分析、成熟度计算
 * 2. TelemetryWriter — 结构化执行日志
 * 3. RegistryManager — 技能注册表
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================
// 常量与路径
// ============================================

const SINGULARITY_DATA = path.join(os.homedir(), '.ola-cc', 'singularity')
const SCORES_DIR = path.join(SINGULARITY_DATA, 'scores')
const TELEMETRY_DIR = path.join(SINGULARITY_DATA, 'telemetry')
const REGISTRY_PATH = path.join(SINGULARITY_DATA, 'registry.json')
const CONFIG_PATH = path.join(SINGULARITY_DATA, 'config.json')

export function ensureDataDirs(): void {
  fs.mkdirSync(SCORES_DIR, { recursive: true })
  fs.mkdirSync(TELEMETRY_DIR, { recursive: true })

  if (!fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(
      REGISTRY_PATH,
      JSON.stringify(
        {
          $schema: 'singularity-registry-v1',
          skills: {},
        },
        null,
        2,
      ),
    )
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          autoRepairThreshold: 50,
          crystallizationThreshold: 90,
          crystallizationMinExecutions: 5,
          hardeningMinExecutions: 3,
          telemetryEnabled: true,
          scoringMode: 'auto',
          skillOutputDir: '~/.ola-cc/skills',
          gitTagPrefix: 'singularity/',
        },
        null,
        2,
      ),
    )
  }
}

// ============================================
// 类型定义
// ============================================

export interface ScoreEntry {
  timestamp: string
  score: number
  context?: string
  strengths?: string[]
  weaknesses?: string[]
  edgeCasesEncountered?: string[]
}

export interface ScoreVersion {
  version: string
  gitTag: string
  scores: ScoreEntry[]
  averageScore: number
  executionCount: number
  maturity: 'draft' | 'tested' | 'hardened' | 'crystallized'
}

export interface ScoreFile {
  $schema: string
  skillName: string
  versions: ScoreVersion[]
  currentVersion: string
  createdAt: string
  lastScoredAt: string | null
}

export interface TelemetryEntry {
  $schema: string
  skillName: string
  version: string
  timestamp: string
  trigger: string
  inputs: Record<string, unknown>
  outputs: {
    filesCreated: string[]
    filesModified: string[]
    summary: string
  }
  duration_ms: number
  score: number | null
  errors: string[]
  edgeCases: string[]
  repairTriggered: boolean
  /** Step-level execution trace (ASAEF Axiom 3: 可观测即诊断力) */
  steps?: TraceStep[]
}

/**
 * Step-level trace record (Meta-Harness trace.jsonl format)
 *
 * Each step records: tool call, inputs, outputs, timing, and outcome.
 * Enables failure indexing, correlation, and replay (Axiom 3 requirements).
 */
export interface TraceStep {
  /** Step number in the skill workflow */
  step: number
  /** Step name from SKILL.md workflow */
  stepName: string
  /** Tool name called (e.g., 'singularity', 'Read', 'Edit') */
  tool: string
  /** Tool call input parameters */
  toolInput: Record<string, unknown>
  /** Tool call output (truncated to 500 chars for storage efficiency) */
  toolOutput: string
  /** Step start time (ISO-8601) */
  startedAt: string
  /** Step end time (ISO-8601) */
  endedAt: string
  /** Step duration in ms */
  duration_ms: number
  /** Step outcome: success, failure, or skipped */
  outcome: 'success' | 'failure' | 'skipped'
  /** Error message if outcome is failure */
  error?: string
}

export interface RegistryEntry {
  location: string
  createdBy: string
  createdAt: string
  currentVersion: string
  maturity: string
  tags: string[]
  lastExecuted: string | null
  executionCount: number
  averageScore: number
}

export interface Registry {
  $schema: string
  skills: Record<string, RegistryEntry>
}

export interface SingularityConfig {
  autoRepairThreshold: number
  crystallizationThreshold: number
  crystallizationMinExecutions: number
  hardeningMinExecutions: number
  telemetryEnabled: boolean
  scoringMode: 'auto' | 'manual' | 'hybrid'
  skillOutputDir: string
  gitTagPrefix: string
}

// ============================================
// ScoreManager
// ============================================

export class ScoreManager {
  /**
   * 初始化技能评分文件
   */
  static init(skillName: string): ScoreFile {
    ensureDataDirs()
    const file = path.join(SCORES_DIR, `${skillName}.json`)
    if (fs.existsSync(file)) {
      throw new Error(`Score file already exists for '${skillName}'`)
    }

    const now = new Date().toISOString()
    const scoreFile: ScoreFile = {
      $schema: 'singularity-score-v1',
      skillName,
      versions: [
        {
          version: 'v1.0.0',
          gitTag: `singularity/${skillName}/v1.0.0`,
          scores: [],
          averageScore: 0,
          executionCount: 0,
          maturity: 'draft',
        },
      ],
      currentVersion: 'v1.0.0',
      createdAt: now,
      lastScoredAt: null,
    }

    ScoreManager.atomicWrite(file, scoreFile)
    return scoreFile
  }

  /**
   * 添加评分
   */
  static addScore(
    skillName: string,
    score: number,
    options: {
      version?: string
      context?: string
      strengths?: string[]
      weaknesses?: string[]
      edgeCases?: string[]
    } = {},
  ): ScoreFile {
    if (score < 0 || score > 100 || !Number.isInteger(score)) {
      throw new Error('Score must be 0-100')
    }

    const file = ScoreManager.getScoreFile(skillName)
    const version = options.version ?? file.currentVersion
    const verEntry = file.versions.find(v => v.version === version)
    if (!verEntry) {
      throw new Error(`Version ${version} not found for ${skillName}`)
    }

    const now = new Date().toISOString()
    verEntry.scores.push({
      timestamp: now,
      score,
      context: options.context,
      strengths: options.strengths,
      weaknesses: options.weaknesses,
      edgeCasesEncountered: options.edgeCases,
    })

    verEntry.executionCount = verEntry.scores.length
    verEntry.averageScore = Math.floor(
      verEntry.scores.reduce((s, e) => s + e.score, 0) / verEntry.scores.length,
    )
    file.lastScoredAt = now

    // 自动更新成熟度
    ScoreManager.updateMaturity(verEntry)

    ScoreManager.atomicWrite(path.join(SCORES_DIR, `${skillName}.json`), file)
    return file
  }

  /**
   * 获取评分文件
   */
  static get(skillName: string): ScoreFile | null {
    const file = path.join(SCORES_DIR, `${skillName}.json`)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  }

  /**
   * 获取平均分
   */
  static getAverage(skillName: string, version?: string): number {
    const file = ScoreManager.get(skillName)
    if (!file) return 0
    if (version) {
      const v = file.versions.find(v => v.version === version)
      return v?.averageScore ?? 0
    }
    return file.versions[file.versions.length - 1]?.averageScore ?? 0
  }

  /**
   * 获取趋势（最近两次评分对比）
   */
  static getTrend(skillName: string): {
    versions: { version: string; avg: number; count: number; maturity: string }[]
  } {
    const file = ScoreManager.get(skillName)
    if (!file) return { versions: [] }
    return {
      versions: file.versions.map(v => ({
        version: v.version,
        avg: v.averageScore,
        count: v.executionCount,
        maturity: v.maturity,
      })),
    }
  }

  /**
   * 获取成熟度
   */
  static getMaturity(skillName: string): string {
    const file = ScoreManager.get(skillName)
    if (!file) return 'unknown'
    return file.versions[file.versions.length - 1]?.maturity ?? 'unknown'
  }

  // ============================================
  // 内部方法
  // ============================================

  private static getScoreFile(skillName: string): ScoreFile {
    const file = path.join(SCORES_DIR, `${skillName}.json`)
    if (!fs.existsSync(file)) {
      throw new Error(`No score file for '${skillName}'. Run init first.`)
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  }

  private static updateMaturity(ver: ScoreVersion): void {
    if (ver.maturity === 'crystallized') return
    const edgeCasesCount = ver.scores
      .flatMap(s => s.edgeCasesEncountered ?? [])
      .length

    if (
      ver.executionCount >= 5 &&
      ver.averageScore >= 80 &&
      edgeCasesCount > 0
    ) {
      ver.maturity = 'hardened'
    } else if (ver.executionCount >= 3 && ver.averageScore >= 60) {
      ver.maturity = 'tested'
    } else {
      ver.maturity = 'draft'
    }
  }

  private static atomicWrite(file: string, data: unknown): void {
    const tmp = `${file}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  }
}

// ============================================
// TelemetryWriter
// ============================================

export class TelemetryWriter {
  /**
   * 记录遥测条目
   */
  static log(
    skillName: string,
    options: {
      trigger?: string
      version?: string
      summary?: string
      score?: number
      error?: string
      edgeCase?: string
      filesCreated?: string[]
      filesModified?: string[]
      duration_ms?: number
      steps?: TraceStep[]
    } = {},
  ): string {
    ensureDataDirs()
    const config = TelemetryWriter.getConfig()
    const version = options.version ?? TelemetryWriter.getVersionFromRegistry(skillName)
    const now = new Date().toISOString()
    const shortId = Math.random().toString(36).substring(2, 10)
    const datePart = now.replace(/[:.]/g, '-').substring(0, 19)
    const skillDir = path.join(TELEMETRY_DIR, skillName)
    fs.mkdirSync(skillDir, { recursive: true })

    const filepath = path.join(skillDir, `${datePart}-${shortId}.json`)
    const entry: TelemetryEntry = {
      $schema: 'singularity-telemetry-v1',
      skillName,
      version,
      timestamp: now,
      trigger: options.trigger ?? 'user-invoked',
      inputs: {},
      outputs: {
        filesCreated: options.filesCreated ?? [],
        filesModified: options.filesModified ?? [],
        summary: options.summary ?? '',
      },
      duration_ms: options.duration_ms ?? 0,
      score: options.score ?? null,
      errors: options.error ? [options.error] : [],
      edgeCases: options.edgeCase ? [options.edgeCase] : [],
      repairTriggered: false,
      steps: options.steps ?? undefined,
    }

    fs.writeFileSync(filepath, JSON.stringify(entry, null, 2))
    return filepath
  }

  /**
   * 获取最近 N 条遥测
   */
  static list(skillName: string, last = 10): TelemetryEntry[] {
    const skillDir = path.join(TELEMETRY_DIR, skillName)
    if (!fs.existsSync(skillDir)) return []

    const files = fs
      .readdirSync(skillDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, last)

    return files.map(f =>
      JSON.parse(fs.readFileSync(path.join(skillDir, f), 'utf-8')),
    )
  }

  /**
   * 清理过期遥测
   */
  static prune(days = 90): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    let count = 0

    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return
      for (const f of fs.readdirSync(dir)) {
        const filepath = path.join(dir, f)
        const stat = fs.statSync(filepath)
        if (stat.isDirectory()) {
          walk(filepath)
        } else if (f.endsWith('.json') && stat.mtimeMs < cutoff) {
          fs.unlinkSync(filepath)
          count++
        }
      }
    }

    walk(TELEMETRY_DIR)
    return count
  }

  private static getConfig(): SingularityConfig {
    if (!fs.existsSync(CONFIG_PATH)) {
      return {
        autoRepairThreshold: 50,
        crystallizationThreshold: 90,
        crystallizationMinExecutions: 5,
        hardeningMinExecutions: 3,
        telemetryEnabled: true,
        scoringMode: 'auto',
        skillOutputDir: '~/.ola-cc/skills',
        gitTagPrefix: 'singularity/',
      }
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  }

  private static getVersionFromRegistry(skillName: string): string {
    if (!fs.existsSync(REGISTRY_PATH)) return 'v1.0.0'
    try {
      const registry: Registry = JSON.parse(
        fs.readFileSync(REGISTRY_PATH, 'utf-8'),
      )
      return registry.skills[skillName]?.currentVersion ?? 'v1.0.0'
    } catch {
      return 'v1.0.0'
    }
  }
}

// ============================================
// RegistryManager
// ============================================

export class RegistryManager {
  static get(): Registry {
    if (!fs.existsSync(REGISTRY_PATH)) {
      return { $schema: 'singularity-registry-v1', skills: {} }
    }
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'))
  }

  static register(
    skillName: string,
    entry: Omit<RegistryEntry, 'lastExecuted' | 'executionCount' | 'averageScore'>,
  ): void {
    const registry = RegistryManager.get()
    registry.skills[skillName] = {
      ...entry,
      lastExecuted: null,
      executionCount: 0,
      averageScore: 0,
    }
    RegistryManager.save(registry)
  }

  static update(skillName: string, updates: Partial<RegistryEntry>): void {
    const registry = RegistryManager.get()
    if (!registry.skills[skillName]) {
      throw new Error(`Skill '${skillName}' not found in registry`)
    }
    registry.skills[skillName] = {
      ...registry.skills[skillName],
      ...updates,
    }
    RegistryManager.save(registry)
  }

  static bumpExecution(skillName: string, score?: number): void {
    const registry = RegistryManager.get()
    const entry = registry.skills[skillName]
    if (!entry) return
    entry.lastExecuted = new Date().toISOString()
    entry.executionCount++
    if (score !== undefined) {
      // 移动平均
      entry.averageScore =
        (entry.averageScore * (entry.executionCount - 1) + score) /
        entry.executionCount
    }
    RegistryManager.save(registry)
  }

  private static save(registry: Registry): void {
    ensureDataDirs()
    const tmp = `${REGISTRY_PATH}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2))
    fs.renameSync(tmp, REGISTRY_PATH)
  }
}
