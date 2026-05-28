/**
 * SingularityTool — 将 TS singularity API 包装为 Tool
 *
 * 使用 inputJSONSchema 替代 Zod schema，避免 bytecode 编译时的 Zod 实例冲突。
 *
 * 暴露 singularity 基础设施给 model/Skill，替代 shell scripts 调用：
 * - ScoreManager (评分/趋势/成熟度)
 * - TelemetryWriter (遥测记录)
 * - RegistryManager (注册表 CRUD)
 * - rubricEvaluator (5维AND门控 + 论文综合评分)
 * - maturityPolicy (成熟度判定/晋升提示)
 * - LearningSystem (对比分析/执行统计 — enablePersistence=true)
 * - codeAuditor (5项静态审计)
 * - EvolutionEngine (8阶段状态机 — 仅状态查询，无执行器注册时为空跑)
 * - storage (持久化/trainTestSplit)
 */

import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { buildTool, type ToolDef, type ToolInputJSONSchema } from '../../Tool'
import {
  ScoreManager,
  TelemetryWriter,
  RegistryManager,
} from '../../services/singularity/index'
import {
  evaluateQuality,
  calculateComprehensiveScore,
  type QualityInput,
} from '../AgentTool/rubricEvaluator'
import {
  getMaturity,
  getNextMaturityHint,
  type MaturityLevel,
} from '../AgentTool/maturityPolicy'
import {
  LearningSystem,
} from '../AgentTool/LearningSystem'
import {
  runAudit,
} from '../AgentTool/codeAuditor'
import {
  EvolutionEngine,
  EvolutionPhase,
  getPhaseDescription,
  LAYER_COST,
  generateDiverseStrategies,
  checkSurgicalPatchConstraint,
  StrategyType,
  DiverseStrategy,
} from '../../services/singularity/EvolutionEngine'
import {
  trainTestSplit,
  loadExecutionHistory,
  pruneExecutionHistory,
  getStorageStats,
  isWhitelistedPath,
  getWhitelist,
} from '../../services/singularity/storage'
import {
  AdaptiveTriggerEngine,
} from '../../services/singularity/AdaptiveTrigger'
import {
  ReflectEngine,
} from '../../services/singularity/ReflectEngine'

// ============================================
// 操作枚举 (纯字符串，无 Zod 依赖)
// ============================================

type Operation =
  | 'score_init' | 'score_add' | 'score_get' | 'score_avg' | 'score_trend' | 'score_maturity'
  | 'telemetry_log' | 'telemetry_list' | 'telemetry_prune'
  | 'registry_get' | 'registry_register' | 'registry_update' | 'registry_bump'
  | 'rubric_eval' | 'rubric_score_v'
  | 'maturity_calc' | 'maturity_hint'
  | 'learning_log' | 'learning_contrast' | 'learning_stats' | 'learning_history'
  | 'audit_run'
  | 'evolve_status' | 'evolve_run_once' | 'evolve_run_to_completion' | 'evolve_diverse_strategies' | 'evolve_surgical_check'
  | 'storage_split' | 'storage_stats' | 'storage_prune'
  | 'whitelist_check' | 'whitelist_list'
  | 'evals_check' | 'evals_validate'
  | 'trigger_check' | 'trigger_analysis'
  | 'reflect_execute' | 'reflect_apply' | 'reflect_history'
  | 'knowledge_extract' | 'knowledge_query' | 'knowledge_transfer'
  | 'predict_trend' | 'proactive_optimize'
  | 'harness_create_spec' | 'harness_review' | 'harness_package_evidence' | 'harness_validate_completion'

const ALL_OPERATIONS: Operation[] = [
  'score_init', 'score_add', 'score_get', 'score_avg', 'score_trend', 'score_maturity',
  'telemetry_log', 'telemetry_list', 'telemetry_prune',
  'registry_get', 'registry_register', 'registry_update', 'registry_bump',
  'rubric_eval', 'rubric_score_v',
  'maturity_calc', 'maturity_hint',
  'learning_log', 'learning_contrast', 'learning_stats', 'learning_history',
  'audit_run',
  'evolve_status', 'evolve_run_once', 'evolve_run_to_completion', 'evolve_diverse_strategies', 'evolve_surgical_check',
  'storage_split', 'storage_stats', 'storage_prune',
  'whitelist_check', 'whitelist_list',
  'evals_check', 'evals_validate',
  'trigger_check', 'trigger_analysis',
  'reflect_execute', 'reflect_apply', 'reflect_history',
  'knowledge_extract', 'knowledge_query', 'knowledge_transfer',
  'predict_trend', 'proactive_optimize',
  'harness_create_spec', 'harness_review', 'harness_package_evidence', 'harness_validate_completion',
]

// skill-required 操作集合
const SKILL_REQUIRED_OPS = new Set([
  'score_init', 'score_add', 'score_get', 'score_avg', 'score_trend', 'score_maturity',
  'telemetry_log', 'telemetry_list',
  'evals_check', 'evals_validate',
  'trigger_check', 'trigger_analysis',
  'reflect_execute', 'reflect_apply',
  'knowledge_extract', 'knowledge_transfer',
  'registry_register', 'registry_update', 'registry_bump',
  'learning_log', 'learning_contrast', 'learning_history',
  'evolve_run_once', 'evolve_run_to_completion',
  'storage_split', 'storage_prune',
  'whitelist_check', 'whitelist_list',
  'harness_create_spec', 'harness_review', 'harness_package_evidence', 'harness_validate_completion',
])

// readOnly 操作集合（不修改文件系统数据）
const READ_ONLY_OPS = new Set([
  'score_get', 'score_avg', 'score_trend', 'score_maturity',
  'telemetry_list',
  'registry_get',
  'rubric_eval', 'rubric_score_v',
  'maturity_calc', 'maturity_hint',
  'learning_contrast', 'learning_stats', 'learning_history',
  'audit_run',
  'evolve_status',
  'evolve_diverse_strategies', 'evolve_surgical_check',
  'trigger_check', 'trigger_analysis',
  'reflect_execute', 'reflect_apply', 'reflect_history',
  'knowledge_extract', 'knowledge_query', 'knowledge_transfer',
  'predict_trend', 'proactive_optimize',
  'storage_split', 'storage_stats',
  'whitelist_check', 'whitelist_list',
  'evals_check', 'evals_validate',
  'harness_validate_completion',
])

// ============================================
// JSON Schema 定义（替代 Zod）
// ============================================

const singularityInputSchema: ToolInputJSONSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: ALL_OPERATIONS,
      description: '操作类型',
    },
    skill: {
      type: 'string',
      description: '技能名称 (如 orion-scoring)',
    },
    score: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: '评分 (0-100)',
    },
    context: {
      type: 'string',
      description: '评分上下文描述',
    },
    strengths: {
      type: 'array',
      items: { type: 'string' },
      description: '评分优点列表',
    },
    weaknesses: {
      type: 'array',
      items: { type: 'string' },
      description: '评分缺点列表',
    },
    edgeCases: {
      type: 'array',
      items: { type: 'string' },
      description: '遇到的边缘情况',
    },
    version: {
      type: 'string',
      description: '版本号 (如 v1.0.0)',
    },
    maturity: {
      type: 'string',
      enum: ['draft', 'tested', 'hardened', 'crystallized'],
      description: '成熟度等级',
    },
    // Quality input (rubric)
    quality: {
      type: 'object',
      properties: {
        tokenBudget: { type: ['number', 'null'] },
        tokensUsed: { type: 'number' },
        baselineTokens: { type: 'number' },
        passRateDelta: { type: 'number' },
        triggerAccuracy: { type: 'number' },
        testResults: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              passed: { type: 'boolean' },
              name: { type: 'string' },
              regression: { type: 'boolean' },
            },
            required: ['passed', 'name', 'regression'],
          },
        },
      },
      description: '5维门控质量输入',
    },
    // Maturity
    executionCount: {
      type: 'number',
      description: '执行次数',
    },
    avgScore: {
      type: 'number',
      description: '平均分',
    },
    edgeCasesHandled: {
      type: 'number',
      description: '已处理的边缘情况数',
    },
    // Learning
    outcome: {
      type: 'string',
      enum: ['success', 'failure'],
      description: '执行结果',
    },
    signalType: {
      type: 'string',
      description: '反思类型',
    },
    signalInsight: {
      type: 'string',
      description: '反思洞察',
    },
    windowSize: {
      type: 'number',
      description: '对比分析窗口大小',
    },
    // Audit
    code: {
      type: 'string',
      description: '要审计的代码',
    },
    fileType: {
      type: 'string',
      enum: ['ts', 'tsx', 'js', 'jsx'],
      description: '文件类型',
    },
    // Evolution
    evolveSkill: {
      type: 'string',
      description: '进化引擎技能',
    },
    maxIterations: {
      type: 'number',
      description: '最大迭代次数',
    },
    // DiverseStrategies
    weakDimensions: {
      type: 'array',
      items: { type: 'string' },
      description: '低分维度列表',
    },
    currentLayer: {
      type: 'string',
      enum: ['1', '2', '3'],
      description: '当前变异层级',
    },
    totalLines: {
      type: 'number',
      description: 'SKILL.md总行数(用于SurgicalPatch检查)',
    },
    maxChangeRatio: {
      type: 'number',
      description: 'SurgicalPatch最大改动比例(默认0.15)',
    },
    maxAbsoluteLines: {
      type: 'number',
      description: 'SurgicalPatch最大改动行数(默认30)',
    },
    // Telemetry
    trigger: {
      type: 'string',
      description: '遥测触发方式',
    },
    summary: {
      type: 'string',
      description: '遥测摘要',
    },
    duration_ms: {
      type: 'number',
      description: '执行时长(ms)',
    },
    filesCreated: {
      type: 'array',
      items: { type: 'string' },
      description: '创建的文件',
    },
    filesModified: {
      type: 'array',
      items: { type: 'string' },
      description: '修改的文件',
    },
    // Trace steps (Meta-Harness step-level trace)
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'number' },
          stepName: { type: 'string' },
          tool: { type: 'string' },
          toolInput: { type: 'object' },
          toolOutput: { type: 'string' },
          startedAt: { type: 'string' },
          endedAt: { type: 'string' },
          duration_ms: { type: 'number' },
          outcome: { type: 'string', enum: ['success', 'failure', 'skipped'] },
          error: { type: 'string' },
        },
        required: ['step', 'stepName', 'tool', 'toolOutput', 'startedAt', 'endedAt', 'duration_ms', 'outcome'],
      },
      description: 'Step-level execution trace (Meta-Harness)',
    },
    // Registry
    location: {
      type: 'string',
      description: '技能路径',
    },
    createdBy: {
      type: 'string',
      description: '创建者',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '技能标签',
    },
    // Storage
    testRatio: {
      type: 'number',
      description: '测试集比例 (0-1)',
    },
    maxRecords: {
      type: 'number',
      description: '最大保留条数',
    },
    lastN: {
      type: 'number',
      description: '最近N条',
    },
    // Harness
    title: {
      type: 'string',
      description: '契约标题',
    },
    scope: {
      type: 'string',
      description: '契约范围',
    },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string' },
      description: '验收标准',
    },
    unknowns: {
      type: 'array',
      items: { type: 'string' },
      description: '未知项',
    },
    stopConditions: {
      type: 'array',
      items: { type: 'string' },
      description: '停止条件',
    },
    dependencies: {
      type: 'array',
      items: { type: 'string' },
      description: '依赖项',
    },
    taskId: {
      type: 'string',
      description: '任务ID',
    },
    testResults: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          passed: { type: 'boolean' },
          name: { type: 'string' },
          regression: { type: 'boolean' },
        },
        required: ['passed', 'name', 'regression'],
      },
      description: '测试结果',
    },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['diff', 'log', 'screenshot', 'metric'] },
          name: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['type', 'name', 'content'],
      },
      description: '证据制品',
    },
    scoreDelta: {
      type: 'number',
      description: '评分变化',
    },
    costRatio: {
      type: 'number',
      description: '成本比率',
    },
  },
  required: ['operation'],
  additionalProperties: false,
}

type SingularityInput = {
  operation: Operation
  skill?: string
  score?: number
  context?: string
  strengths?: string[]
  weaknesses?: string[]
  edgeCases?: string[]
  version?: string
  maturity?: 'draft' | 'tested' | 'hardened' | 'crystallized'
  quality?: {
    tokenBudget?: number | null
    tokensUsed?: number
    baselineTokens?: number
    passRateDelta?: number
    triggerAccuracy?: number
    testResults?: { passed: boolean; name: string; regression: boolean }[]
  }
  executionCount?: number
  avgScore?: number
  edgeCasesHandled?: number
  outcome?: 'success' | 'failure'
  signalType?: string
  signalInsight?: string
  windowSize?: number
  code?: string
  fileType?: 'ts' | 'tsx' | 'js' | 'jsx'
  evolveSkill?: string
  maxIterations?: number
  weakDimensions?: string[]
  currentLayer?: '1' | '2' | '3'
  totalLines?: number
  maxChangeRatio?: number
  maxAbsoluteLines?: number
  trigger?: string
  summary?: string
  duration_ms?: number
  filesCreated?: string[]
  filesModified?: string[]
  steps?: Array<{
    step: number
    stepName: string
    tool: string
    toolInput?: Record<string, unknown>
    toolOutput: string
    startedAt: string
    endedAt: string
    duration_ms: number
    outcome: 'success' | 'failure' | 'skipped'
    error?: string
  }>
  location?: string
  createdBy?: string
  tags?: string[]
  testRatio?: number
  maxRecords?: number
  lastN?: number
  // Harness
  title?: string
  scope?: string
  acceptanceCriteria?: string[]
  unknowns?: string[]
  stopConditions?: string[]
  dependencies?: string[]
  taskId?: string
  testResults?: { passed: boolean; name: string; regression: boolean }[]
  artifacts?: { type: 'diff' | 'log' | 'screenshot' | 'metric'; name: string; content: string }[]
  scoreDelta?: number
  costRatio?: number
}

// ============================================
// Tool 定义
// ============================================

export const singularityToolDef: ToolDef = {
  name: 'singularity',
  description:
    'Singularity 自进化引擎 API — 评分/遥测/注册表/5维门控/成熟度/对比分析/代码审计/进化状态机/持久化/白名单/DiverseStrategies/GT契约/自适应触发/反思/知识迁移/预测进化/Harness契约 (48 operations)',

  inputJSONSchema: singularityInputSchema,

  async call(input: SingularityInput, _context, _canUseTool) {
    const op = input.operation

    // 前置校验: skill-required 操作必须传入 skill
    if (SKILL_REQUIRED_OPS.has(op) && !input.skill) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: `操作 ${op} 需要提供 skill 参数` }, null, 2) }] }
    }

    let result: unknown

    try {
      switch (op) {
        // ---- Score ----
        case 'score_init':
          result = ScoreManager.init(input.skill)
          break
        case 'score_add':
          result = ScoreManager.addScore(input.skill, input.score ?? 0, {
            version: input.version,
            context: input.context,
            strengths: input.strengths,
            weaknesses: input.weaknesses,
            edgeCases: input.edgeCases,
          })
          break
        case 'score_get':
          result = ScoreManager.get(input.skill)
          break
        case 'score_avg':
          result = { avg: ScoreManager.getAverage(input.skill, input.version) }
          break
        case 'score_trend':
          result = ScoreManager.getTrend(input.skill)
          break
        case 'score_maturity':
          result = { maturity: ScoreManager.getMaturity(input.skill) }
          break

        // ---- Telemetry ----
        case 'telemetry_log':
          result = { path: TelemetryWriter.log(input.skill, {
            trigger: input.trigger,
            version: input.version,
            summary: input.summary,
            score: input.score,
            duration_ms: input.duration_ms,
            filesCreated: input.filesCreated,
            filesModified: input.filesModified,
            steps: input.steps as any,
          })}
          break
        case 'telemetry_list':
          result = TelemetryWriter.list(input.skill, input.lastN ?? 10)
          break
        case 'telemetry_prune':
          result = { pruned: TelemetryWriter.prune(input.maxRecords ?? 90) }
          break

        // ---- Registry ----
        case 'registry_get':
          result = RegistryManager.get()
          break
        case 'registry_register':
          if (!input.location) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'registry_register 需要 location 参数' }, null, 2) }] }
          }
          RegistryManager.register(input.skill, {
            location: input.location,
            createdBy: input.createdBy ?? 'singularity-tool',
            createdAt: new Date().toISOString(),
            currentVersion: input.version ?? 'v1.0.0',
            maturity: input.maturity ?? 'draft',
            tags: input.tags ?? [],
          })
          result = { registered: input.skill }
          break
        case 'registry_update':
          RegistryManager.update(input.skill, {
            currentVersion: input.version,
            maturity: input.maturity,
            averageScore: input.score,
          })
          result = { updated: input.skill }
          break
        case 'registry_bump':
          RegistryManager.bumpExecution(input.skill, input.score)
          result = { bumped: input.skill }
          break

        // ---- Rubric ----
        case 'rubric_eval':
          const q: QualityInput = {
            tokenBudget: input.quality?.tokenBudget ?? null,
            tokensUsed: input.quality?.tokensUsed ?? 0,
            baselineTokens: input.quality?.baselineTokens ?? 0,
            passRateDelta: input.quality?.passRateDelta,
            triggerAccuracy: input.quality?.triggerAccuracy,
            testResults: input.quality?.testResults,
          }
          result = evaluateQuality(q)
          break
        case 'rubric_score_v':
          result = { score: calculateComprehensiveScore(
            input.avgScore ?? 0,
            input.quality?.baselineTokens && input.quality?.tokensUsed
              ? input.quality.tokensUsed / input.quality.baselineTokens
              : 1,
            0,
          )}
          break

        // ---- Maturity ----
        case 'maturity_calc':
          result = {
            maturity: getMaturity(
              input.executionCount ?? 0,
              input.avgScore ?? 0,
              input.edgeCasesHandled ?? 0,
            ),
          }
          break
        case 'maturity_hint':
          result = {
            hint: getNextMaturityHint(
              input.maturity ?? 'draft',
              input.executionCount ?? 0,
              input.avgScore ?? 0,
              input.edgeCasesHandled ?? 0,
            ),
          }
          break

        // ---- Learning ----
        case 'learning_log':
          const ls = new LearningSystem({ enablePersistence: true })
          ls.loadFromDisk(input.skill)
          ls.logExecution({
            skill: input.skill,
            taskDescription: input.summary ?? '',
            outcome: input.outcome ?? 'success',
            score: input.score ?? 0,
            signal: input.signalType
              ? { signal_type: input.signalType, insight: input.signalInsight ?? '', details: '' }
              : null,
            edgeCases: input.edgeCases ?? [],
            timestamp: new Date(),
            duration_ms: input.duration_ms ?? 0,
          })
          result = { logged: input.skill, recordCount: ls.getRecordCount(input.skill) }
          break
        case 'learning_contrast':
          const ls2 = new LearningSystem({ enablePersistence: true })
          ls2.loadFromDisk(input.skill)
          result = ls2.contrastAnalysis(input.skill, input.windowSize ?? 20)
          break
        case 'learning_stats':
          const ls3 = new LearningSystem({ enablePersistence: true })
          ls3.loadFromDisk(input.skill)
          result = ls3.getExecutionStats(input.skill)
          break
        case 'learning_history':
          const ls4 = new LearningSystem({ enablePersistence: true })
          ls4.loadFromDisk(input.skill)
          result = ls4.getExecutionHistory(input.skill, input.lastN ?? 50)
          break

        // ---- Audit ----
        case 'audit_run':
          if (!input.code || !input.fileType) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'audit_run 需要 code 和 fileType 参数' }, null, 2) }] }
          }
          result = await runAudit(input.code, input.fileType)
          break

        // ---- Evolution ----
        case 'evolve_status':
          result = {
            phases: Object.values(EvolutionPhase).map(p => ({
              phase: p,
              description: getPhaseDescription(p),
            })),
            layerCost: LAYER_COST,
            note: 'evolve_run_once/run_to_completion 创建无执行器引擎，仅推进状态但不执行实际逻辑。执行器需要外部注册。',
          }
          break
        case 'evolve_run_once':
          const engine = new EvolutionEngine(input.evolveSkill ?? input.skill ?? 'default', {
            maxIterations: input.maxIterations ?? 10,
          })
          result = await engine.runOnce()
          break
        case 'evolve_run_to_completion':
          const engine2 = new EvolutionEngine(input.evolveSkill ?? input.skill ?? 'default', {
            maxIterations: input.maxIterations ?? 10,
          })
          result = await engine2.runToCompletion()
          break
        case 'evolve_diverse_strategies':
          if (!input.weakDimensions || input.weakDimensions.length === 0) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'evolve_diverse_strategies 需要 weakDimensions 参数' }, null, 2) }] }
          }
          const layer = (input.currentLayer ? parseInt(input.currentLayer) : 1) as 1 | 2 | 3
          result = generateDiverseStrategies(input.weakDimensions, layer)
          break
        case 'evolve_surgical_check':
          if (!input.weakDimensions || !input.totalLines) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'evolve_surgical_check 需要 weakDimensions 和 totalLines 参数' }, null, 2) }] }
          }
          const sLayer = (input.currentLayer ? parseInt(input.currentLayer) : 1) as 1 | 2 | 3
          const strategies = generateDiverseStrategies(input.weakDimensions, sLayer)
          const checks = strategies.map(s => ({
            strategy: s.name,
            ...checkSurgicalPatchConstraint(s, input.totalLines ?? 100, input.maxChangeRatio ?? 0.15, input.maxAbsoluteLines ?? 30),
          }))
          result = { strategies, surgicalChecks: checks }
          break

        // ---- Adaptive Trigger (智能增强1) ----
        case 'trigger_check':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'trigger_check 需要 skill 参数' }, null, 2) }] }
          }
          const signals = AdaptiveTriggerEngine.detectSignals(input.skill)
          result = { skill: input.skill, signals, signalCount: signals.length }
          break
        case 'trigger_analysis':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'trigger_analysis 需要 skill 参数' }, null, 2) }] }
          }
          const allSignals = AdaptiveTriggerEngine.detectSignals(input.skill)
          const decision = AdaptiveTriggerEngine.makeDecision(input.skill, allSignals)
          result = { skill: input.skill, decision, signals: allSignals }
          break

        // ---- Reflect (智能增强4: 自我反思闭环) ----
        case 'reflect_execute':
          if (!input.skill || input.score === undefined) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'reflect_execute 需要 skill 和 score 参数' }, null, 2) }] }
          }
          const reflectResult = ReflectEngine.diagnose(
            input.skill,
            input.score,
            input.summary ?? '',
            input.avgScore ?? input.score,
          )
          result = reflectResult
          break
        case 'reflect_apply':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'reflect_apply 需要 skill 参数' }, null, 2) }] }
          }
          const changes = ReflectEngine.mapToExecutableChanges({
            skill: input.skill,
            signalType: (input.signalType as any) ?? 'OPTIMIZATION',
            diagnosis: input.signalInsight ?? '',
            targetSegment: input.summary ?? '',
            suggestedFix: input.context ?? '',
            estimatedLines: 5,
            confidence: 0.7,
            improvementType: 'modify_step',
            recommendedLayer: 2,
          })
          result = { skill: input.skill, changes }
          break
        case 'reflect_history':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'reflect_history 需要 skill 参数' }, null, 2) }] }
          }
          const allReflects = ReflectEngine.reflectAll()
          const skillReflects = allReflects.filter(r => r.skill === input.skill)
          result = { skill: input.skill, reflects: skillReflects, totalCount: allReflects.length }
          break

        // ---- Knowledge Transfer (智能增强2: 跨skill迁移) ----
        case 'knowledge_extract':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'knowledge_extract 需要 skill 参数' }, null, 2) }] }
          }
          const ls5 = new LearningSystem({ enablePersistence: true })
          ls5.loadFromDisk(input.skill)
          const contrast = ls5.contrastAnalysis(input.skill, input.windowSize ?? 20)
          result = {
            skill: input.skill,
            winnerSignals: contrast.delta?.uniqueToWinners ?? [],
            loserSignals: contrast.delta?.uniqueToLosers ?? [],
            scoreDelta: contrast.delta?.scoreDelta ?? 0,
            insight: contrast.insight,
          }
          break
        case 'knowledge_query':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'knowledge_query 需要 skill 参数' }, null, 2) }] }
          }
          const ls6 = new LearningSystem({ enablePersistence: true })
          ls6.loadFromDisk(input.skill)
          const stats = ls6.getExecutionStats(input.skill)
          const history = ls6.getExecutionHistory(input.skill, input.lastN ?? 20)
          result = { skill: input.skill, stats, history: history.map(h => ({
            outcome: h.outcome, score: h.score, signal: h.signal?.signal_type, timestamp: h.timestamp,
          }))}
          break
        case 'knowledge_transfer':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'knowledge_transfer 需要 skill 参数（源技能）' }, null, 2) }] }
          }
          const sourceLs = new LearningSystem({ enablePersistence: true })
          sourceLs.loadFromDisk(input.skill)
          const sourceContrast = sourceLs.contrastAnalysis(input.skill, 20)
          const targetLs = new LearningSystem({ enablePersistence: true })
          if (input.context) {
            targetLs.loadFromDisk(input.context)
            const targetContrast = targetLs.contrastAnalysis(input.context, 20)
            result = {
              sourceSkill: input.skill,
              targetSkill: input.context,
              sourceWinnerSignals: sourceContrast.delta?.uniqueToWinners ?? [],
              transferableSignals: (sourceContrast.delta?.uniqueToWinners ?? []).filter(s =>
                !(targetContrast.delta?.uniqueToWinners ?? []).includes(s),
              ),
              insight: `从 ${input.skill} 迁移 ${(sourceContrast.delta?.uniqueToWinners ?? []).length} 个成功模式到 ${input.context}`,
            }
          } else {
            result = {
              sourceSkill: input.skill,
              winnerSignals: sourceContrast.delta?.uniqueToWinners ?? [],
              insight: '提供 context 参数指定目标技能以完成迁移',
            }
          }
          break

        // ---- Predictive Evolution (智能增强3: 预测性进化) ----
        case 'predict_trend':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'predict_trend 需要 skill 参数' }, null, 2) }] }
          }
          const trend = ScoreManager.getTrend(input.skill)
          const versions = trend.versions.slice(-5)
          const scores = versions.map(v => v.avg)
          // 简单线性趋势预测
          const avgDelta = scores.length >= 2
            ? (scores[scores.length - 1] - scores[0]) / (scores.length - 1)
            : 0
          const predictedNext = scores.length > 0 ? scores[scores.length - 1] + avgDelta : 0
          result = {
            skill: input.skill,
            historicalScores: versions.map((v, i) => ({ version: v.version, score: v.avg })),
            trend: avgDelta > 2 ? 'improving' : avgDelta < -2 ? 'degrading' : 'stable',
            predictedNextScore: Math.max(0, Math.min(100, Math.round(predictedNext))),
            confidence: scores.length >= 3 ? 0.8 : scores.length >= 2 ? 0.6 : 0.3,
          }
          break
        case 'proactive_optimize':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'proactive_optimize 需要 skill 参数' }, null, 2) }] }
          }
          const triggerDecision = AdaptiveTriggerEngine.makeDecision(
            input.skill,
            AdaptiveTriggerEngine.detectSignals(input.skill),
          )
          const reflectResult2 = ReflectEngine.diagnose(
            input.skill,
            ScoreManager.getAverage(input.skill),
            '',
            ScoreManager.getAverage(input.skill),
          )
          result = {
            skill: input.skill,
            triggerDecision,
            reflectDiagnosis: reflectResult2,
            recommendedActions: [
              triggerDecision.shouldEvolve ? '触发进化流程' : '暂无退化信号',
              reflectResult2.confidence >= 0.7 ? `执行${reflectResult2.signalType}修复` : '继续观察',
              `当前层级: L${triggerDecision.recommendedLayer}`,
            ],
          }
          break

        // ---- Harness ----
        case 'harness_create_spec': {
          if (!input.title || !input.scope || !input.acceptanceCriteria) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'harness_create_spec 需要 title, scope, acceptanceCriteria 参数' }, null, 2) }] }
          }
          const harnessEngine = new EvolutionEngine(input.skill ?? 'default', {
            maxIterations: input.maxIterations ?? 10,
          })
          const spec = harnessEngine.createSpecContract({
            title: input.title,
            scope: input.scope,
            acceptanceCriteria: input.acceptanceCriteria,
            unknowns: input.unknowns,
            stopConditions: input.stopConditions,
            dependencies: input.dependencies,
          })
          result = spec
          break
        }
        case 'harness_review': {
          if (!input.taskId || !input.testResults || input.score === undefined || !input.weakDimensions) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'harness_review 需要 taskId, testResults, score, weakDimensions 参数' }, null, 2) }] }
          }
          const reviewEngine = new EvolutionEngine(input.skill ?? 'default', {
            maxIterations: input.maxIterations ?? 10,
          })
          const review = await reviewEngine.executeIndependentReview({
            taskId: input.taskId,
            testResults: input.testResults,
            score: input.score,
            weakDimensions: input.weakDimensions,
          })
          result = review
          break
        }
        case 'harness_package_evidence': {
          if (!input.testResults || input.scoreDelta === undefined || input.costRatio === undefined) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'harness_package_evidence 需要 testResults, scoreDelta, costRatio 参数' }, null, 2) }] }
          }
          const evidenceEngine = new EvolutionEngine(input.skill ?? 'default', {
            maxIterations: input.maxIterations ?? 10,
          })
          const evidence = evidenceEngine.packageEvidence({
            testResults: {
              passed: input.testResults.filter(r => r.passed).length,
              failed: input.testResults.filter(r => !r.passed).length,
              total: input.testResults.length,
              details: input.testResults.map(r => ({
                name: r.name,
                passed: r.passed,
                duration: 0,
              })),
            },
            artifacts: input.artifacts,
            scoreDelta: input.scoreDelta,
            costRatio: input.costRatio,
          })
          result = evidence
          break
        }
        case 'harness_validate_completion': {
          if (!input.title || !input.scope || !input.acceptanceCriteria) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'harness_validate_completion 需要 title, scope, acceptanceCriteria 参数来创建契约后验证' }, null, 2) }] }
          }
          const validateEngine = new EvolutionEngine(input.skill ?? 'default', {
            maxIterations: input.maxIterations ?? 10,
          })
          validateEngine.createSpecContract({
            title: input.title,
            scope: input.scope,
            acceptanceCriteria: input.acceptanceCriteria,
            unknowns: input.unknowns,
            stopConditions: input.stopConditions,
            dependencies: input.dependencies,
          })
          const validation = validateEngine.validateContractCompletion()
          result = validation
          break
        }

        // ---- Storage ----
        case 'storage_split':
          const raw = loadExecutionHistory(input.skill)
          result = trainTestSplit(raw, input.testRatio ?? 0.2)
          break
        case 'storage_stats':
          result = getStorageStats()
          break
        case 'storage_prune':
          result = { pruned: pruneExecutionHistory(input.skill, input.maxRecords ?? 500) }
          break

        // ---- Whitelist ----
        case 'whitelist_check':
          if (!input.location) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'whitelist_check 需要 location 参数' }, null, 2) }] }
          }
          result = { path: input.location, whitelisted: isWhitelistedPath(input.location) }
          break
        case 'whitelist_list':
          result = { whitelist: getWhitelist() }
          break

        // ---- Evals (GT契约) ----
        case 'evals_check':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'evals_check 需要 skill 参数' }, null, 2) }] }
          }
          const evalsPath = path.join(os.homedir(), '.ola-cc', 'skills', `orion-${input.skill}`, 'evals', 'evals.json')
          const evalsExists = fs.existsSync(evalsPath)
          let evalsData: Record<string, unknown> | null = null
          if (evalsExists) {
            try {
              evalsData = JSON.parse(fs.readFileSync(evalsPath, 'utf-8'))
            } catch {
              evalsData = null
            }
          }
          result = {
            skill: input.skill,
            evalsPath,
            exists: evalsExists,
            valid: evalsData !== null,
            assertionCount: evalsData?.assertions ? (evalsData.assertions as unknown[]).length : 0,
            criticalCount: evalsData?.assertions
              ? (evalsData.assertions as any[]).filter((a: any) => a.critical === true).length
              : 0,
          }
          break
        case 'evals_validate':
          if (!input.skill) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: true, operation: op, message: 'evals_validate 需要 skill 参数' }, null, 2) }] }
          }
          const evPath = path.join(os.homedir(), '.ola-cc', 'skills', `orion-${input.skill}`, 'evals', 'evals.json')
          if (!fs.existsSync(evPath)) {
            result = { skill: input.skill, valid: false, message: 'evals.json not found — GT契约缺失' }
            break
          }
          try {
            const evData = JSON.parse(fs.readFileSync(evPath, 'utf-8'))
            const assertions = (evData.assertions || []) as any[]
            const errors: string[] = []
            // 验证结构
            if (!evData.skillName) errors.push('缺少 skillName')
            if (!evData.version) errors.push('缺少 version')
            if (!evData.createdAt) errors.push('缺少 createdAt')
            if (assertions.length < 2) errors.push('至少需要2个断言')
            // 验证断言
            const requiredTypes = ['regex', 'contains', 'json_schema', 'call_trace']
            const presentTypes = assertions.map((a: any) => a.type)
            const missingTypes = requiredTypes.filter(t => !presentTypes.includes(t))
            if (missingTypes.length > 2) errors.push(`缺少关键断言类型: ${missingTypes.join(', ')}`)
            const criticals = assertions.filter((a: any) => a.critical === true)
            if (criticals.length === 0) errors.push('至少需要1个critical断言')
            result = {
              skill: input.skill,
              valid: errors.length === 0,
              errors,
              assertionCount: assertions.length,
              criticalCount: criticals.length,
              assertionTypes: presentTypes,
            }
          } catch (e) {
            result = { skill: input.skill, valid: false, message: `evals.json JSON解析失败: ${e instanceof Error ? e.message : String(e)}` }
          }
          break

        default:
          throw new Error(`未知操作: ${op}`)
      }
    } catch (e) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: true,
            operation: op,
            message: e instanceof Error ? e.message : String(e),
          }, null, 2),
        }],
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          operation: op,
          skill: input.skill,
          result,
        }, null, 2),
      }],
    }
  },

  async describe(input) {
    const op = input.operation
    const skillLabel = input.skill ? ` for ${input.skill}` : ''
    const descriptions: Record<string, string> = {
      score_init: `初始化评分文件${skillLabel}`,
      score_add: `添加评分 ${input.score ?? ''}${skillLabel}`,
      score_get: `获取评分数据${skillLabel}`,
      score_avg: `获取平均分${skillLabel}`,
      score_trend: `获取评分趋势${skillLabel}`,
      score_maturity: `获取成熟度${skillLabel}`,
      telemetry_log: `记录遥测${skillLabel}`,
      telemetry_list: `列出遥测${skillLabel}`,
      telemetry_prune: '清理过期遥测',
      registry_get: '获取注册表',
      registry_register: `注册技能${skillLabel}`,
      registry_update: `更新注册表${skillLabel}`,
      registry_bump: `更新执行计数${skillLabel}`,
      rubric_eval: '5维AND门控评估',
      rubric_score_v: '论文综合评分 Score(v)',
      maturity_calc: '计算成熟度',
      maturity_hint: '获取成熟度晋升提示',
      learning_log: `记录执行${skillLabel}`,
      learning_contrast: `对比分析${skillLabel}`,
      learning_stats: `执行统计${skillLabel}`,
      learning_history: `执行历史${skillLabel}`,
      audit_run: '运行5项代码审计',
      evolve_status: '查看进化引擎状态和阶段说明',
      evolve_run_once: '运行一轮进化（空引擎推进状态，不执行实际逻辑）',
      evolve_run_to_completion: '运行至终止（空引擎推进状态）',
      evolve_diverse_strategies: '生成K=4多样化修复策略 (SkillEvolver)',
      evolve_surgical_check: '检查策略是否在SurgicalPatch约束内 (15%/30行)',
      storage_split: '训练/测试集分割',
      storage_stats: '查看存储统计',
      storage_prune: '裁剪历史记录',
      whitelist_check: '检查路径是否在workspace白名单内',
      whitelist_list: '列出workspace白名单路径',
      evals_check: '检查GT契约(evals.json)是否存在及基本结构',
      evals_validate: '验证GT契约(evals.json)的断言完整性和有效性',
      trigger_check: '检查自适应退化信号',
      trigger_analysis: '分析自适应进化触发决策',
      reflect_execute: '执行反思闭环诊断',
      reflect_apply: '应用反思结果修改 SKILL.md',
      reflect_history: '查看反思诊断历史',
      knowledge_extract: `提取成功/失败模式${skillLabel}`,
      knowledge_query: `查询已知模式${skillLabel}`,
      knowledge_transfer: `迁移模式到目标技能`,
      predict_trend: `预测评分趋势${skillLabel}`,
      proactive_optimize: `主动优化建议${skillLabel}`,
      harness_create_spec: `创建spec.md契约${skillLabel}`,
      harness_review: '执行独立评审（评审者≠实现者）',
      harness_package_evidence: '打包结构化验证证据',
      harness_validate_completion: '验证契约完成度',
    }
    return descriptions[op] ?? `Singularity ${op}`
  },

  async prompt() {
    return 'Singularity 自进化引擎 API — 评分/遥测/注册表/5维门控/成熟度/对比分析/代码审计/进化状态机/持久化/白名单/DiverseStrategies/GT契约/自适应触发/反思/知识迁移/预测进化/Harness契约 (48 operations)'
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
  isReadOnly: (input) => {
    const op = input?.operation ?? ''
    return READ_ONLY_OPS.has(op)
  },
}

export const singularityTool = buildTool(singularityToolDef)
