/**
 * GrokTool — Understand-Anything 知识图谱集成
 *
 * 离线知识图谱生成 + Dashboard 可视化 + 业务域分析 + 引导式学习。
 * 与 CodeGraph 互补：CodeGraph 做实时查询，Grok 做深度语义分析。
 */

import React from 'react'
import { z } from 'zod/v4'
import { buildTool } from '../../Tool.js'
import { Box, Text } from '../../ink.js'
import { ProgressBar } from '../../components/design-system/ProgressBar.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ProgressMessage, ToolProgressData } from '../../types/tools.js'
import { grokManager, GrokError, ERROR_SUGGESTIONS } from './GrokManager.js'
import { GraphContextService } from '../../services/graph/GraphContextService.js'
import { GraphUsageTracker } from '../../services/graph/GraphUsageTracker.js'

import { sanitizeQuery, sanitizeSymbolName } from '../../services/graph/SecurityUtil.js'

// ============================================================
// Schema
// ============================================================

const operationEnum = z.enum([
  'grok_generate',
  'grok_chat',
  'grok_explain',
  'grok_domain',
  'grok_tour',
  'grok_diff',
  'grok_status',
  'grok_dashboard',
  'grok_architecture',
  'grok_hotspots',
])

const inputSchema = z.object({
  operation: operationEnum.describe('Grok 操作类型'),
  question: z.string().max(5000).optional().describe('问题（用于 grok_chat）'),
  target: z.string().max(1000).optional().describe('目标文件/函数（用于 grok_explain）'),
  topic: z.string().max(1000).optional().describe('主题（用于 grok_tour）'),
  files: z.array(z.string().max(500)).max(100).optional().describe('变更文件列表（用于 grok_diff）'),
  path: z.string().max(1000).optional().describe('扫描路径（用于 grok_generate）'),
  language: z.string().max(50).optional().describe('输出语言（用于 grok_generate）'),
  scope: z.string().max(500).optional().describe('子目录范围（用于 grok_generate）'),
  incremental: z.boolean().optional().describe('增量更新（用于 grok_generate）'),
  port: z.number().min(1024).max(65535).optional().describe('端口号（用于 grok_dashboard）'),
  // Graph algorithm parameters
  damping: z.number().min(0).max(1).optional().describe('PageRank 阻尼系数（默认 0.85，用于 grok_hotspots）'),
  resolution: z.number().min(0.1).max(10).optional().describe('社区检测分辨率（默认 1.0，用于 grok_architecture）'),
  since: z.string().optional().describe('时间窗口起点（如 "30 days"，用于 grok_hotspots）'),
  maxNodes: z.number().min(1).max(100).optional().describe('最大返回节点数（默认 20）'),
})

type Input = z.infer<typeof inputSchema>

type GrokProgressData = ToolProgressData & {
  stage?: string;
  progress?: number;
  startTime?: number;
};

// 阶段中文标签
const STAGE_LABELS: Record<string, string> = {
  prepare: '准备中',
  generate: '生成中',
  scanner: '扫描文件',
  analyzer: '分析代码',
  architecture: '架构分析',
  tour: '学习路径',
  review: '质量审查',
  assemble: '组装图谱',
  done: '完成',
};

// ============================================================
// Tool
// ============================================================

export const grokTool = buildTool({
  name: 'grok',
  searchHint: 'knowledge graph code understanding semantic analysis architecture community hotspots',
  maxResultSizeChars: 50_000,
  inputSchema,
  renderToolUseMessage(input: Record<string, unknown>) {
    const op = input?.operation as string
    const labels: Record<string, string> = {
      grok_generate: '生成知识图谱',
      grok_chat: '问答查询',
      grok_explain: '解释代码',
      grok_domain: '业务域分析',
      grok_tour: '学习路径',
      grok_diff: '变更影响',
      grok_status: '查看状态',
      grok_dashboard: '启动面板',
      grok_architecture: '架构分析',
      grok_hotspots: '热点检测',
    }
    const label = labels[op] || op
    const detail = input?.question || input?.target || input?.topic || ''
    return detail ? `${label}: ${String(detail).slice(0, 40)}` : label
  },
  renderToolUseProgressMessage(
    progressMessages: ProgressMessage<GrokProgressData>[],
    options?: { verbose?: boolean },
  ) {
    const last = progressMessages.at(-1);
    if (!last?.data) {
      return React.createElement(Text, { dimColor: true }, 'Grok…');
    }
    const { stage, progress, startTime } = last.data;
    const verbose = options?.verbose ?? false;

    // 完成状态
    if (stage === 'done') {
      return React.createElement(Text, { dimColor: true }, 'Grok · Done');
    }

    const stageLabel = STAGE_LABELS[stage || ''] || (stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : 'Grok');

    // 有百分比时显示进度条（generate 操作）
    if (progress != null && progress > 0) {
      const ratio = Math.min(progress / 100, 1);

      // Verbose 模式：显示步骤历史
      if (verbose && progressMessages.length > 1) {
        const steps = new Map<string, number>();
        for (const msg of progressMessages) {
          if (msg.data?.stage && msg.data?.progress != null) {
            steps.set(msg.data.stage, msg.data.progress);
          }
        }
        const stepLines = Object.entries(STAGE_LABELS)
          .filter(([key]) => steps.has(key))
          .map(([key, label]) => {
            const pct = steps.get(key) || 0;
            const marker = pct >= 100 ? '✓' : pct > 0 ? '▸' : '○';
            return `${marker} ${label} ${pct}%`;
          });

        return React.createElement(Box, { flexDirection: 'column' },
          React.createElement(Box, { flexDirection: 'row', gap: 1 },
            React.createElement(Text, { dimColor: true }, `Grok · ${stageLabel}`),
            React.createElement(ProgressBar, { ratio, width: 16 }),
            React.createElement(Text, { dimColor: true }, `${progress}%`),
          ),
          ...stepLines.map(line =>
            React.createElement(Text, { dimColor: true, key: line }, `  ${line}`)
          ),
        );
      }

      return React.createElement(Box, { flexDirection: 'row', gap: 1 },
        React.createElement(Text, { dimColor: true }, `Grok · ${stageLabel}`),
        React.createElement(ProgressBar, { ratio, width: 16 }),
        React.createElement(Text, { dimColor: true }, `${progress}%`),
      );
    }
    return React.createElement(Text, { dimColor: true }, `Grok · ${stageLabel}…`);
  },

  async description() {
    return (
      'Grok 代码理解 — 知识图谱生成、自然语言问答、业务域分析、引导式学习。' +
      '首次使用需要生成知识图谱（约 3-5 分钟），之后查询秒级响应。'
    )
  },

  async call(input: Input, _context, _canUseTool, _parentMessage, _onProgress) {
    const opStart = Date.now();
    const sendProgress = (stage: string) => {
      _onProgress?.({ toolUseID: '', data: { type: 'grok_progress', stage } })
    }

    try {
      sendProgress('prepare')
      await grokManager.ensureGrokSource()

      // PreToolUse: inject graph context
      const projectRoot = getCwd()
      const graphContext = GraphContextService.getInstance(projectRoot).getPreToolContext('grok', input as Record<string, unknown>)

      let result: unknown

      switch (input.operation) {
        case 'grok_generate': {
          sendProgress('generate')
          const genResult = await grokManager.runAgentPipeline({
            path: input.path || getCwd(),
            language: input.language,
            scope: input.scope,
            incremental: input.incremental ?? true,
            onProgress: (stage, progress) => {
              _onProgress?.({ toolUseID: '', data: { type: 'grok_progress', stage, progress } })
            },
          })
          result = genResult
          break
        }

        case 'grok_chat': {
          if (!input.question) {
            return { data: { error: true, message: 'grok_chat 需要 question 参数' } }
          }
          sendProgress('chat')
          const safeQuestion = sanitizeQuery(input.question)
          const chatResult = await grokManager.queryGraph(safeQuestion)
          result = chatResult
          break
        }

        case 'grok_explain': {
          if (!input.target) {
            return { data: { error: true, message: 'grok_explain 需要 target 参数' } }
          }
          sendProgress('explain')
          const safeTarget = sanitizeSymbolName(input.target)
          const explainResult = await grokManager.queryGraph(
            `Explain ${safeTarget}: what it does, its relationships, which layer and domain it belongs to`
          )
          result = {
            summary: explainResult.answer,
            relationships: explainResult.sources,
          }
          break
        }

        case 'grok_domain': {
          sendProgress('domain')
          const domainResult = await grokManager.queryGraph(
            'Analyze the business domains in this codebase. List each domain with its flows and files.'
          )
          result = { domains: domainResult.answer }
          break
        }

        case 'grok_tour': {
          sendProgress('tour')
          const tourResult = await grokManager.queryGraph(
            input.topic
              ? `Create a guided learning tour for: ${input.topic}`
              : 'Create guided learning tours for this codebase'
          )
          result = { tours: tourResult.answer }
          break
        }

        case 'grok_diff': {
          if (!input.files || input.files.length === 0) {
            return { data: { error: true, message: 'grok_diff 需要 files 参数' } }
          }
          sendProgress('diff')
          const diffResult = await grokManager.queryGraph(
            `Analyze the impact of changes to these files: ${input.files.join(', ')}`
          )
          result = { impacted: diffResult.answer }
          break
        }

        case 'grok_status': {
          sendProgress('status')
          const status = await grokManager.getGraphStatus()
          result = status
          break
        }

        case 'grok_dashboard': {
          sendProgress('dashboard')
          const dashResult = await grokManager.startDashboard(input.port)
          result = dashResult
          break
        }

        case 'grok_architecture': {
          sendProgress('architecture')
          result = await grokManager.analyzeArchitecture({
            resolution: input.resolution,
            maxNodes: input.maxNodes,
          })
          break
        }

        case 'grok_hotspots': {
          sendProgress('hotspots')
          result = await grokManager.detectHotspots({
            damping: input.damping,
            since: input.since,
            maxNodes: input.maxNodes,
          })
          break
        }

        default:
          return { data: { error: true, message: `未知操作: ${input.operation}` } }
      }

      // 所有操作完成时发送完成进度
      sendProgress('done')

      // 查询操作追加过期提示
      const isQueryOp = ['grok_chat', 'grok_explain', 'grok_domain', 'grok_tour', 'grok_diff'].includes(input.operation)
      if (isQueryOp) {
        const status = await grokManager.getGraphStatus()
        if (status.stale) {
          const days = status.lastUpdated
            ? Math.round((Date.now() - new Date(status.lastUpdated).getTime()) / (24 * 60 * 60 * 1000))
            : '?'
          return {
            data: {
              ok: true, operation: input.operation, result,
              _freshnessNote: `知识图谱已 ${days} 天未更新，结果可能过时。执行 grok_generate 可刷新。`,
            },
          }
        }
      }

      // PostToolUse: record usage
      GraphUsageTracker.getInstance(projectRoot).recordUsage({
        toolName: 'grok',
        operation: input.operation,
        timestamp: Date.now(),
        success: true,
        duration: Date.now() - opStart,
        query: (input.question || input.target || input.topic) as string | undefined,
      })

      return { data: { ok: true, operation: input.operation, result, _graphContext: graphContext } }
    } catch (error) {
      logForDebugging(`[grok] error: ${error}`)
      const isGrokError = error instanceof GrokError
      const code = isGrokError ? error.code : 'UNKNOWN'
      const suggestion = isGrokError
        ? error.suggestion
        : ERROR_SUGGESTIONS[code]
      // PostToolUse: record failed usage
      GraphUsageTracker.getInstance(getCwd()).recordUsage({
        toolName: 'grok',
        operation: input.operation,
        timestamp: Date.now(),
        success: false,
        duration: Date.now() - opStart,
      })
      return {
        data: {
          error: true,
          operation: input.operation,
          code,
          message: error instanceof Error ? error.message : String(error),
          recoverable: isGrokError ? error.recoverable : false,
          ...(suggestion ? { suggestion } : {}),
        },
      }
    }
  },

  async prompt() {
    return 'Grok 代码理解工具 — 知识图谱生成、自然语言问答、业务域分析'
  },

  isConcurrencySafe(input) {
    const op = input?.operation
    return op !== 'grok_generate' && op !== 'grok_dashboard'
  },
  isEnabled() {
    return true
  },
  isReadOnly(input) {
    const op = input?.operation
    return op !== 'grok_generate' && op !== 'grok_dashboard'
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const text = JSON.stringify(output, null, 2)
    const isError = (output as Record<string, unknown>)?.data &&
      ((output as Record<string, unknown>).data as Record<string, unknown>)?.error === true
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: text,
      ...(isError && { is_error: true }),
    }
  },
})
