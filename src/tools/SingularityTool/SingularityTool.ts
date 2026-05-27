/**
 * SingularityTool — 将 TS singularity API 包装为 Tool
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
 *
 * Audit 修复记录:
 * - C1: LearningSystem 传入 enablePersistence=true，确保 JSONL 持久化
 * - V1: skill-required 操作前置校验，避免 input.skill! runtime crash
 * - V2: telemetry_prune/storage_prune 从 readOnly 移除（实际删除数据）
 * - Dead ops: 删除 rubric_failed_dims 和 rubric_gate_to_score（返回固定错误文本）
 * - C2: registry_update 使用 maturity 参数而非 context 字段
 */

import { z } from 'zod/v4'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import { buildTool, type ToolDef } from '../../Tool'
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

// ============================================
// 操作枚举 & Zod Schema
// ============================================

const operationEnum = z.enum([
  // Score 操作
  'score_init',
  'score_add',
  'score_get',
  'score_avg',
  'score_trend',
  'score_maturity',
  // Telemetry 操作
  'telemetry_log',
  'telemetry_list',
  'telemetry_prune',
  // Registry 操作
  'registry_get',
  'registry_register',
  'registry_update',
  'registry_bump',
  // Rubric 操作
  'rubric_eval',
  'rubric_score_v',
  // Maturity 操作
  'maturity_calc',
  'maturity_hint',
  // Learning 操作
  'learning_log',
  'learning_contrast',
  'learning_stats',
  'learning_history',
  // Audit 操作
  'audit_run',
  // Evolution 操作
  'evolve_status',
  'evolve_run_once',
  'evolve_run_to_completion',
  'evolve_diverse_strategies',
  'evolve_surgical_check',
  // Storage 操作
  'storage_split',
  'storage_stats',
  'storage_prune',
  // Whitelist 操作
  'whitelist_check',
  'whitelist_list',
  // Evals 操作 (GT契约)
  'evals_check',
  'evals_validate',
  // Adaptive Trigger 操作 (智能增强1: 自适应进化触发)
  'trigger_check',
  'trigger_analysis',
  // Reflect 操作 (智能增强4: 自我反思闭环)
  'reflect_execute',
  'reflect_apply',
  'reflect_history',
  // Knowledge Transfer 操作 (智能增强2: 跨skill迁移)
  'knowledge_extract',
  'knowledge_query',
  'knowledge_transfer',
  // Predictive Evolution 操作 (智能增强3: 预测性进化)
  'predict_trend',
  'proactive_optimize',
])

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
])

export const singularityToolDef: ToolDef = {
  name: 'singularity',
  description:
    'Singularity 自进化引擎 API — 评分/遥测/注册表/门控/成熟度/对比分析/审计/进化状态机/持久化/白名单/DiverseStrategies/GT契约/自适应触发/反思/知识迁移/预测进化 (44 operations)',
  inputSchema: z.object({
    operation: operationEnum.describe('操作类型'),
    skill: z.string().optional().describe('技能名称 (如 orion-scoring)'),
    score: z.number().min(0).max(100).optional().describe('评分 (0-100)'),
    context: z.string().optional().describe('评分上下文描述'),
    strengths: z.array(z.string()).optional().describe('评分优点列表'),
    weaknesses: z.array(z.string()).optional().describe('评分缺点列表'),
    edgeCases: z.array(z.string()).optional().describe('遇到的边缘情况'),
    version: z.string().optional().describe('版本号 (如 v1.0.0)'),
    maturity: z.enum(['draft', 'tested', 'hardened', 'crystallized']).optional().describe('成熟度等级'),
    // Quality input (rubric)
    quality: z.object({
      tokenBudget: z.number().nullable().optional(),
      tokensUsed: z.number().optional(),
      baselineTokens: z.number().optional(),
      passRateDelta: z.number().optional(),
      triggerAccuracy: z.number().optional(),
      testResults: z.array(z.object({
        passed: z.boolean(),
        name: z.string(),
        regression: z.boolean(),
      })).optional(),
    }).optional().describe('5维门控质量输入'),
    // Maturity
    executionCount: z.number().optional().describe('执行次数'),
    avgScore: z.number().optional().describe('平均分'),
    edgeCasesHandled: z.number().optional().describe('已处理的边缘情况数'),
    // Learning
    outcome: z.enum(['success', 'failure']).optional().describe('执行结果'),
    signalType: z.string().optional().describe('反思类型'),
    signalInsight: z.string().optional().describe('反思洞察'),
    windowSize: z.number().optional().describe('对比分析窗口大小'),
    // Audit
    code: z.string().optional().describe('要审计的代码'),
    fileType: z.enum(['ts', 'tsx', 'js', 'jsx']).optional().describe('文件类型'),
    // Evolution
    evolveSkill: z.string().optional().describe('进化引擎技能'),
    maxIterations: z.number().optional().describe('最大迭代次数'),
    // DiverseStrategies
    weakDimensions: z.array(z.string()).optional().describe('低分维度列表'),
    currentLayer: z.enum(['1', '2', '3']).optional().describe('当前变异层级'),
    totalLines: z.number().optional().describe('SKILL.md总行数(用于SurgicalPatch检查)'),
    maxChangeRatio: z.number().optional().describe('SurgicalPatch最大改动比例(默认0.15)'),
    maxAbsoluteLines: z.number().optional().describe('SurgicalPatch最大改动行数(默认30)'),
    // Telemetry
    trigger: z.string().optional().describe('遥测触发方式'),
    summary: z.string().optional().describe('遥测摘要'),
    duration_ms: z.number().optional().describe('执行时长(ms)'),
    filesCreated: z.array(z.string()).optional().describe('创建的文件'),
    filesModified: z.array(z.string()).optional().describe('修改的文件'),
    // Trace steps (Meta-Harness step-level trace)
    steps: z.array(z.object({
      step: z.number(),
      stepName: z.string(),
      tool: z.string(),
      toolInput: z.record(z.unknown()),
      toolOutput: z.string(),
      startedAt: z.string(),
      endedAt: z.string(),
      duration_ms: z.number(),
      outcome: z.enum(['success', 'failure', 'skipped']),
      error: z.string().optional(),
    })).optional().describe('Step-level execution trace (Meta-Harness)'),
    // Registry
    location: z.string().optional().describe('技能路径'),
    createdBy: z.string().optional().describe('创建者'),
    tags: z.array(z.string()).optional().describe('技能标签'),
    // Storage
    testRatio: z.number().optional().describe('测试集比例 (0-1)'),
    maxRecords: z.number().optional().describe('最大保留条数'),
    lastN: z.number().optional().describe('最近N条'),
  }),

  async call(input: z.infer<typeof singularityToolDef.inputSchema>, _context, _canUseTool) {
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
    }
    return descriptions[op] ?? `Singularity ${op}`
  },

  async prompt() {
    return 'Singularity 自进化引擎 API — 评分/遥测/注册表/5维门控/成熟度/对比分析/代码审计/进化状态机/持久化/白名单/DiverseStrategies/GT契约/自适应触发/反思/知识迁移/预测进化 (44 operations)'
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
  isReadOnly: (input) => {
    const op = typeof input === 'object' && input !== null && 'operation' in input
      ? (input as { operation?: string }).operation ?? ''
      : ''
    return READ_ONLY_OPS.has(op)
  },
}

export const singularityTool = buildTool(singularityToolDef)