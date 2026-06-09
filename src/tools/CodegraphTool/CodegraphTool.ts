/**
 * CodegraphTool — 原生集成 CodeGraph 代码知识图谱
 *
 * 自动下载 codegraph CLI（首次使用），自动初始化项目索引。
 * 无需用户手动安装，无需 MCP 配置。
 */

import React from 'react';
import { z } from 'zod/v4';
import { buildTool } from '../../Tool.js';
import { Box, Text } from '../../ink.js';
import { ProgressBar } from '../../components/design-system/ProgressBar.js';
import { getCwd } from '../../utils/cwd.js';
import { logForDebugging } from '../../utils/debug.js';
import type { ProgressMessage, ToolProgressData } from '../../types/tools.js';
import * as CodegraphManager from './CodegraphManager.js';
import { GraphContextService } from '../../services/graph/GraphContextService.js'
import { GraphUsageTracker } from '../../services/graph/GraphUsageTracker.js'
import { sanitizeQuery, sanitizeSymbolName } from '../../services/graph/SecurityUtil.js';
import {
  type HandlerContext,
  ValidationError,
  handleContext,
  handleSearch,
  handleCallers,
  handleCallees,
  handleImpact,
  handleTrace,
  handleStatus,
  handleFiles,
  handleInit,
  handleSync,
  handleScc,
  handleToposort,
  handleDelta,
  handlePagerank,
  handleRoles,
  handleSlice,
  handleCoupling,
  handleCommunity,
  handleCentrality,
  handleTemporal,
  handleUnresolved,
  handleKindMap,
} from './CodegraphHandlers.js';

// ============================================================
// Rate Limiter & Circuit Breaker for graph-heavy operations
// ============================================================

const GRAPH_OPS = new Set([
  'codegraph_scc', 'codegraph_toposort', 'codegraph_pagerank',
  'codegraph_roles', 'codegraph_community', 'codegraph_centrality',
  'codegraph_slice', 'codegraph_coupling', 'codegraph_temporal',
])

let lastGraphOpTime = 0
let circuitBreakerFailures = 0
let circuitBreakerDisabledUntil = 0

// ============================================================
// Schema
// ============================================================

const operationEnum = z.enum([
  'codegraph_context',
  'codegraph_search',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_trace',
  'codegraph_status',
  'codegraph_init',
  'codegraph_files',
  'codegraph_sync',
  // Graph algorithm operations
  'codegraph_scc',
  'codegraph_toposort',
  'codegraph_delta',
  'codegraph_pagerank',
  'codegraph_roles',
  'codegraph_slice',
  'codegraph_coupling',
  'codegraph_community',
  'codegraph_centrality',
  'codegraph_temporal',
  // Phase Z4 operations
  'codegraph_unresolved',
  // Phase 6a diagnostic
  'codegraph_kind_map',
]);

const inputSchema = z.object({
  operation: operationEnum.describe('CodeGraph 操作类型'),
  query: z.string().max(10000).optional().describe('查询内容（任务描述 / 符号名）'),
  symbol: z.string().max(1000).optional().describe('符号名称（用于 callers/callees/impact/trace）'),
  maxNodes: z.number().min(1).max(100).optional().describe('最大返回节点数（默认 20）'),
  format: z.enum(['markdown', 'json']).optional().describe('输出格式（默认 markdown）'),
  depth: z.number().min(1).max(10).optional().describe('影响分析深度（默认 2）'),
  // Graph algorithm parameters
  damping: z.number().min(0).max(1).optional().describe('PageRank 阻尼系数（默认 0.85）'),
  resolution: z.number().min(0.1).max(10).optional().describe('社区检测分辨率（默认 1.0）'),
  method: z.enum(['katz', 'betweenness', 'both']).optional().describe('中心性计算方法'),
  sampleSize: z.number().min(10).max(1000).optional().describe('采样大小（用于 betweenness 等）'),
  since: z.string().optional().describe('时间窗口起点（如 "30d", "2024-01-01"）'),
  oldSnapshot: z.string().optional().describe('旧快照标识（用于 delta 对比）'),
  newSnapshot: z.string().optional().describe('新快照标识（用于 delta 对比）'),
});

type Input = z.infer<typeof inputSchema>;

type CodegraphProgressData = ToolProgressData & {
  stage?: string;
  message?: string;
  elapsed?: number;
  progress?: number; // 0-100 百分比
};

/**
 * 解析 CodeGraph CLI 的 stderr 输出，提取阶段名和百分比
 * CodeGraph 输出格式（含 ANSI 转义码和 \r）：
 *   ✶ Parsing code  ████████░░░░░░░░░░░░░░░░░  33%
 *   ◆ Parsing code — done
 *   ✢ Resolving refs  ░░░░░░░░░░░░░░░░░░░░░░░░░  0%
 */
function parseCodegraphStderr(line: string): { stage: string; progress: number | null } | null {
  // 去除所有 ANSI 转义码（SGR、光标移动、DEC 私有模式、波浪号终止序列等）
  const clean = line.replace(/\x1b(?:[@-Z\\-_]|\[[0-9;?]*[a-zA-Z~])/g, '').replace(/\r/g, '').trim();
  if (!clean) return null;

  // 匹配 "— done" 结束标记
  const doneMatch = clean.match(/([\w\s]+?)\s*[—–-]\s*done/i);
  if (doneMatch) {
    return { stage: doneMatch[1].trim(), progress: 100 };
  }

  // 匹配带百分比的进度行: "Phase name  ████░░░  42%"
  const progressMatch = clean.match(/([\w\s]+?)\s+[\█░▢▣░]+.*?(\d+)%/);
  if (progressMatch) {
    return { stage: progressMatch[1].trim(), progress: parseInt(progressMatch[2], 10) };
  }

  // 匹配纯文本阶段: "Scanning files..."
  const stageMatch = clean.match(/^([\w\s]+?)(?:\.{3}|\s*$)/);
  if (stageMatch && stageMatch[1].length > 2) {
    return { stage: stageMatch[1].trim(), progress: null };
  }

  return null;
}

// ============================================================
// Tool
// ============================================================

export const codegraphTool = buildTool({
  name: 'codegraph',
  searchHint: 'code graph dependency call impact structure',
  maxResultSizeChars: 50_000,
  inputSchema,
  renderToolUseMessage(input: Record<string, unknown>) {
    const op = input?.operation as string
    const labels: Record<string, string> = {
      codegraph_context: '查询上下文',
      codegraph_search: '搜索符号',
      codegraph_callers: '查找调用者',
      codegraph_callees: '查找被调用者',
      codegraph_impact: '影响分析',
      codegraph_trace: '调用链追踪',
      codegraph_status: '查看状态',
      codegraph_init: '初始化索引',
      codegraph_files: '列出文件',
      codegraph_sync: '同步索引',
      codegraph_scc: 'SCC 分析',
      codegraph_toposort: '拓扑排序',
      codegraph_delta: '差分图',
      codegraph_pagerank: 'PageRank',
      codegraph_roles: '角色分类',
      codegraph_slice: '数据切片',
      codegraph_coupling: '耦合度量',
      codegraph_community: '社区检测',
      codegraph_centrality: '中心性分析',
      codegraph_temporal: '时间耦合',
      codegraph_unresolved: '未解析引用',
      codegraph_kind_map: '类型映射诊断',
    }
    const label = labels[op] || op
    const detail = input?.query || input?.symbol || ''
    return detail ? `${label}: ${String(detail).slice(0, 40)}` : label
  },
  renderToolUseProgressMessage(
    progressMessages: ProgressMessage<CodegraphProgressData>[],
    options?: { verbose?: boolean },
  ) {
    const last = progressMessages.at(-1);
    if (!last?.data) {
      return React.createElement(Text, { dimColor: true }, 'CodeGraph…');
    }
    const { stage, message, elapsed, progress } = last.data;
    const elapsedStr = elapsed != null && elapsed > 1000 ? ` (${Math.round(elapsed / 1000)}s)` : '';
    const verbose = options?.verbose ?? false;

    // 完成状态 — 不渲染，由 AssistantToolUseMessage 的 isResolved 处理
    if (stage === 'done') {
      return null;
    }

    const stageLabel = stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : 'CodeGraph';

    // 有百分比时显示进度条（init/sync 的 indexing 阶段）
    if (progress != null && progress >= 0) {
      const ratio = Math.min(progress / 100, 1);

      // Verbose 模式：显示所有进度历史
      if (verbose && progressMessages.length > 1) {
        const steps = progressMessages
          .filter(m => m.data?.stage && m.data?.progress != null)
          .map(m => {
            const s = m.data!;
            const pct = s.progress ?? 0;
            const marker = pct >= 100 ? '✓' : pct > 0 ? '▸' : '○';
            return `${marker} ${s.stage} ${pct}%`;
          });

        return React.createElement(Box, { flexDirection: 'column' },
          React.createElement(Box, { flexDirection: 'row', gap: 1 },
            React.createElement(Text, { dimColor: true }, `CodeGraph · ${stageLabel}`),
            React.createElement(ProgressBar, { ratio, width: 16, fillColor: 'professionalBlue', emptyColor: 'subtle' }),
            React.createElement(Text, { color: 'professionalBlue' }, `${progress}%${elapsedStr}`),
          ),
          ...steps.map(line =>
            React.createElement(Text, { dimColor: true, key: line }, `  ${line}`)
          ),
        );
      }

      return React.createElement(Box, { flexDirection: 'row', gap: 1 },
        React.createElement(Text, { dimColor: true }, `CodeGraph · ${stageLabel}`),
        React.createElement(ProgressBar, { ratio, width: 16, fillColor: 'professionalBlue', emptyColor: 'subtle' }),
        React.createElement(Text, { color: 'professionalBlue' }, `${progress}%${elapsedStr}`),
      );
    }

    // 有额外 message 时双行显示
    const header = `CodeGraph · ${stageLabel}${elapsedStr}`;
    if (message && message !== stage) {
      return React.createElement(Box, { flexDirection: 'column' },
        React.createElement(Text, { dimColor: true }, header),
        React.createElement(Text, { dimColor: true }, `  ${message}`),
      );
    }
    return React.createElement(Text, { dimColor: true }, header);
  },

  async description() {
    return (
      'CodeGraph 代码知识图谱 — 语义查询、调用链追踪、影响分析。自动下载、自动索引当前项目。' +
      '用 codegraph_context 理解代码全貌，codegraph_trace 追踪调用路径，' +
      'codegraph_impact 分析修改影响范围。首次使用自动下载（~45MB）。'
    )
  },

  async call(input: Input, _context, _canUseTool, _parentMessage, _onProgress) {
    const projectRoot = getCwd();
    const opStart = Date.now();
    const sendProgress = (stage: string, message?: string, progress?: number) => {
      _onProgress?.({ toolUseID: '', data: { type: 'codegraph_progress', stage, message, elapsed: Date.now() - opStart, progress } })
    }
    /** 解析 CodeGraph stderr 并转发为结构化进度 */
    const onStderrProgress = (line: string) => {
      const parsed = parseCodegraphStderr(line);
      if (parsed) {
        sendProgress(parsed.stage, undefined, parsed.progress ?? undefined);
      }
    }
    /** 转发 ExtractionOrchestrator 索引进度 */
    const onIndexProgress = (progress: { phase: string; current: number; total: number; currentFile?: string }) => {
      const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : undefined
      const detail = progress.currentFile ? ` ${progress.currentFile}` : ''
      sendProgress(progress.phase, `${progress.phase}${detail}`, pct)
    }

    // Rate limiting: 5s cooldown between graph-heavy ops
    if (GRAPH_OPS.has(input.operation)) {
      const now = Date.now()
      // Circuit breaker: 3 failures → 60s disable
      if (now < circuitBreakerDisabledUntil) {
        return { data: { error: true, message: 'Graph operations temporarily disabled due to repeated failures. Try again in a minute.' } }
      }
      if (now - lastGraphOpTime < 5000) {
        return { data: { error: true, message: 'Graph operation rate limited, please wait a few seconds before retrying.' } }
      }
      lastGraphOpTime = now
    }

    try {
      // 自动初始化：如果项目未初始化，自动下载 + init
      if (!CodegraphManager.isCodegraphInitialized(projectRoot)) {
        if (input.operation === 'codegraph_init') {
          sendProgress('init', 'Initializing CodeGraph index…')
          // Yield so React can render the initial progress message
          await new Promise(resolve => setTimeout(resolve, 0))
          const initResult = await CodegraphManager.initProject(projectRoot, onIndexProgress);
          if (!initResult.ok) {
            return { data: { error: true, message: `初始化失败: ${initResult.stderr || initResult.stdout}` } };
          }
          return { data: { ok: true, operation: input.operation, result: { message: 'CodeGraph 索引已创建', initialized: true } } };
        }
        if (input.operation === 'codegraph_status') {
          return { data: { ok: true, operation: input.operation, result: { initialized: false, message: 'CodeGraph 索引未初始化' } } };
        }
        sendProgress('init', 'Auto-initializing CodeGraph…')
        // Yield so React can render the initial progress message
        await new Promise(resolve => setTimeout(resolve, 0))
        await CodegraphManager.ensureReady(projectRoot, onIndexProgress);
      }

      // PreToolUse: inject graph context
      const graphContext = GraphContextService.getInstance(projectRoot).getPreToolContext('codegraph', input as Record<string, unknown>)

      // Sanitize inputs to prevent prompt injection
      if (input.query) input.query = sanitizeQuery(input.query)
      if (input.symbol) input.symbol = sanitizeSymbolName(input.symbol)

      const handlerCtx: HandlerContext = { projectRoot, sendProgress, onStderrProgress, yieldToUI: () => new Promise<void>(resolve => setTimeout(resolve, 0)) };
      let result: unknown;

      switch (input.operation) {
        case 'codegraph_context': result = await handleContext(handlerCtx, input); break;
        case 'codegraph_search': result = await handleSearch(handlerCtx, input); break;
        case 'codegraph_callers': result = await handleCallers(handlerCtx, input); break;
        case 'codegraph_callees': result = await handleCallees(handlerCtx, input); break;
        case 'codegraph_impact': result = await handleImpact(handlerCtx, input); break;
        case 'codegraph_trace': result = await handleTrace(handlerCtx, input); break;
        case 'codegraph_status': result = await handleStatus(handlerCtx, input); break;
        case 'codegraph_files': result = await handleFiles(handlerCtx, input); break;
        case 'codegraph_init': result = await handleInit(handlerCtx, input, onStderrProgress); break;
        case 'codegraph_sync': result = await handleSync(handlerCtx, input); break;
        case 'codegraph_scc': result = await handleScc(handlerCtx, input); break;
        case 'codegraph_toposort': result = await handleToposort(handlerCtx, input); break;
        case 'codegraph_delta': result = await handleDelta(handlerCtx, input); break;
        case 'codegraph_pagerank': result = await handlePagerank(handlerCtx, input); break;
        case 'codegraph_roles': result = await handleRoles(handlerCtx, input); break;
        case 'codegraph_slice': result = await handleSlice(handlerCtx, input); break;
        case 'codegraph_coupling': result = await handleCoupling(handlerCtx, input); break;
        case 'codegraph_community': result = await handleCommunity(handlerCtx, input); break;
        case 'codegraph_centrality': result = await handleCentrality(handlerCtx, input); break;
        case 'codegraph_temporal': result = await handleTemporal(handlerCtx, input); break;
        case 'codegraph_unresolved': result = await handleUnresolved(handlerCtx, input); break;
        case 'codegraph_kind_map': result = await handleKindMap(handlerCtx, input); break;
        default:
          return { data: { error: true, message: `未知操作: ${input.operation}` } };
      }

      // Reset circuit breaker on successful graph op
      if (GRAPH_OPS.has(input.operation)) {
        circuitBreakerFailures = 0
      }

      // 所有操作完成时发送完成进度
      sendProgress('done')
      // Yield to event loop so React can render the final progress
      // before the tool result arrives and marks the tool as resolved.
      await new Promise(resolve => setTimeout(resolve, 0))

      // PostToolUse: record usage
      GraphUsageTracker.getInstance(projectRoot).recordUsage({
        toolName: 'codegraph',
        operation: input.operation,
        timestamp: Date.now(),
        success: true,
        duration: Date.now() - opStart,
        query: (input.query || input.symbol) as string | undefined,
      })

      // 查询操作追加新鲜度提示
      const isQueryOp = ['codegraph_context', 'codegraph_search', 'codegraph_callers',
        'codegraph_callees', 'codegraph_impact', 'codegraph_trace',
        'codegraph_scc', 'codegraph_toposort', 'codegraph_pagerank',
        'codegraph_roles', 'codegraph_slice', 'codegraph_coupling', 'codegraph_community',
        'codegraph_centrality', 'codegraph_temporal', 'codegraph_unresolved'].includes(input.operation);
      if (isQueryOp) {
        const age = CodegraphManager.getLastSyncAge(projectRoot);
        if (age != null && age > CodegraphManager.FRESH_THRESHOLD_MS) {
          const ageMin = Math.round(age / 60_000);
          return {
            data: {
              ok: true, operation: input.operation, result,
              _freshnessNote: `索引已 ${ageMin} 分钟未更新，可能缺少最新变更。执行 codegraph_sync 可刷新。`,
            },
          };
        }
      }

      return { data: { ok: true, operation: input.operation, result, _graphContext: graphContext } };
    } catch (e) {
      // ValidationError → parameter errors, no logging or failure recording
      if (e instanceof ValidationError) {
        return { data: { error: true, message: e.message } };
      }
      logForDebugging(`[codegraph] error: ${e}`);
      // Circuit breaker: track failures for graph-heavy ops
      if (GRAPH_OPS.has(input.operation)) {
        circuitBreakerFailures++
        if (circuitBreakerFailures >= 3) {
          circuitBreakerDisabledUntil = Date.now() + 60000
          circuitBreakerFailures = 0
        }
      }
      // PostToolUse: record failed usage
      GraphUsageTracker.getInstance(projectRoot).recordUsage({
        toolName: 'codegraph',
        operation: input.operation,
        timestamp: Date.now(),
        success: false,
        duration: Date.now() - opStart,
        query: (input.query || input.symbol) as string | undefined,
      })
      return {
        data: {
          error: true,
          operation: input.operation,
          message: e instanceof Error ? e.message : String(e),
        },
      };
    }
  },

  async prompt() {
    return 'CodeGraph 代码知识图谱工具 — 语义查询、调用链追踪、影响分析'
  },

  isConcurrencySafe(input) {
    const op = input?.operation
    return op !== 'codegraph_init' && op !== 'codegraph_sync' && op !== 'codegraph_delta';
  },
  isEnabled() {
    return true
  },
  isReadOnly(input) {
    const op = input?.operation
    return op !== 'codegraph_init' && op !== 'codegraph_sync';
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const text = JSON.stringify(output, null, 2);
    const isError = (output as Record<string, unknown>)?.data &&
      ((output as Record<string, unknown>).data as Record<string, unknown>)?.error === true;
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: text,
      ...(isError && { is_error: true }),
    };
  },
});

// ============================================================
// Three-Layer Description System
// ============================================================

/**
 * Operation tier classification for progressive disclosure.
 * - Core (5): Always visible, short descriptions
 * - Analysis (4): Visible after core, medium descriptions
 * - Advanced (11): Deferred via ToolSearch, detailed descriptions
 */
export const OPERATION_TIERS = {
  core: [
    'codegraph_search',
    'codegraph_status',
    'codegraph_callers',
    'codegraph_callees',
  ],
  analysis: [
    'codegraph_impact',
    'codegraph_trace',
    'codegraph_context',
  ],
  advanced: [
    // CPU-intensive graph algorithms — deferred to prevent frequent invocation
    'codegraph_pagerank',
    'codegraph_community',
    'codegraph_roles',
    'codegraph_centrality',
    'codegraph_scc',
    'codegraph_toposort',
    // Infrequent operations
    'codegraph_init',
    'codegraph_files',
    'codegraph_sync',
    'codegraph_delta',
    'codegraph_slice',
    'codegraph_coupling',
    'codegraph_temporal',
    'codegraph_unresolved',
    'codegraph_kind_map',
  ],
} as const;

/** Advanced operations that should be deferred via ToolSearch */
export const DEFERRED_OPERATIONS: readonly string[] = OPERATION_TIERS.advanced;

/** Per-operation descriptions at three detail levels */
const OPERATION_DESCRIPTIONS: Record<string, { core: string; analysis: string; advanced: string }> = {
  codegraph_scc: {
    core: 'Strongly connected components — find circular dependencies',
    analysis: 'Tarjan SCC algorithm to detect circular dependency clusters in the call graph',
    advanced: 'Tarjan SCC: identifies strongly connected components (cycles) in the code graph. Returns trivial and non-trivial components. Use to find circular dependency clusters that need refactoring.',
  },
  codegraph_toposort: {
    core: 'Topological sort — determine build/init order',
    analysis: 'Topological ordering of the dependency graph with cycle detection',
    advanced: 'Topological sort of the dependency DAG. Returns ordered node list and detected cycles. Use to determine correct initialization order, build order, or migration sequence.',
  },
  codegraph_pagerank: {
    core: 'PageRank — find most important nodes',
    analysis: 'PageRank centrality to identify architecturally significant files',
    advanced: 'PageRank algorithm with configurable damping factor. Scores nodes by architectural importance (incoming references weighted by source importance). Use to find the most critical files that need careful maintenance.',
  },
  codegraph_search: {
    core: 'Search symbols by name/pattern',
    analysis: 'Fuzzy symbol search with file and kind metadata',
    advanced: 'Search for symbols by name or pattern across the indexed codebase. Returns name, kind, file, line for each match. Supports partial matches and wildcards.',
  },
  codegraph_status: {
    core: 'Index status and freshness',
    analysis: 'Check CodeGraph index status, node/edge counts, and sync age',
    advanced: 'Check CodeGraph initialization status, index freshness (minutes since last sync), node and edge counts. Use before other operations to verify the index is ready and up-to-date.',
  },
  codegraph_community: {
    core: 'Community detection — find module boundaries',
    analysis: 'Louvain community detection — find natural module boundaries',
    advanced: 'Louvain modularity-based community detection with configurable resolution. Identifies natural clusters/modules in the code graph. Use to understand codebase structure and find refactoring boundaries.',
  },
  codegraph_roles: {
    core: 'Node role classification',
    analysis: 'Node role classification (hub/bridge/leaf/utility)',
    advanced: 'Classify nodes by structural role: hub (many connections), bridge (connects communities), leaf (terminal), utility (used by many). Use to understand architectural patterns and identify key files.',
  },
  codegraph_impact: {
    core: 'Impact analysis — what breaks if X changes',
    analysis: 'Impact analysis — what breaks if X changes',
    advanced: 'Forward and backward impact analysis. depth<=2: CLI-based direct callers/callees. depth>2: GraphEngine BFS + backward reachability + role classification. Use to assess change risk before modifying a symbol.',
  },
  codegraph_centrality: {
    core: 'Centrality — find bridge nodes',
    analysis: 'Katz/betweenness centrality — find bridge nodes',
    advanced: 'Katz and/or betweenness centrality analysis. Katz measures global influence via path sums. Betweenness identifies nodes that bridge different parts of the graph. Use to find critical integration points.',
  },
  codegraph_context: {
    core: 'Query code context by task',
    analysis: 'Query code context by task description. Returns relevant symbols, files, and relationships.',
    advanced: 'Query code context by task description. Returns relevant symbols, files, and relationships for a given task or question.',
  },
  codegraph_callers: {
    core: 'Find callers of a symbol',
    analysis: 'Find all callers of a symbol (who uses this function/class).',
    advanced: 'Find all callers of a symbol (who uses this function/class). Returns calling symbols with file and line metadata.',
  },
  codegraph_callees: {
    core: 'Find callees of a symbol',
    analysis: 'Find all callees of a symbol (what does this function call).',
    advanced: 'Find all callees of a symbol (what does this function call). Returns called symbols with file and line metadata.',
  },
  codegraph_trace: {
    core: 'Trace call path between symbols',
    analysis: 'Trace call path between two symbols. Format: "X to Y".',
    advanced: 'Trace call path between two symbols. Format: "X to Y". Uses bidirectional impact analysis to find connecting nodes.',
  },
  codegraph_init: {
    core: 'Initialize CodeGraph index',
    analysis: 'Initialize CodeGraph index for the current project.',
    advanced: 'Initialize CodeGraph index for the current project. Downloads CLI (~45MB) on first use and creates the symbol database.',
  },
  codegraph_files: {
    core: 'List indexed files',
    analysis: 'List indexed files with directory structure.',
    advanced: 'List indexed files with directory structure. Returns file tree up to specified depth.',
  },
  codegraph_sync: {
    core: 'Sync CodeGraph index',
    analysis: 'Sync CodeGraph index with current source code.',
    advanced: 'Sync CodeGraph index with current source code. Re-indexes changed files since last sync.',
  },
  codegraph_delta: {
    core: 'Compute graph delta',
    analysis: 'Compute graph delta between two snapshots.',
    advanced: 'Compute graph delta between two snapshots. Returns added/removed nodes and edges with summary.',
  },
  codegraph_slice: {
    core: 'Backward data slice',
    analysis: 'Backward data slice for a symbol.',
    advanced: 'Backward data slice for a symbol. Identifies all symbols that influence the target symbol\'s value through data flow analysis.',
  },
  codegraph_coupling: {
    core: 'Coupling metrics',
    analysis: 'Coupling metrics: high-coupling pairs and LCOM scores.',
    advanced: 'Coupling metrics: high-coupling pairs and LCOM (Lack of Cohesion of Methods) scores. Use to identify code that should be refactored.',
  },
  codegraph_temporal: {
    core: 'Temporal coupling analysis',
    analysis: 'Temporal coupling via git log analysis.',
    advanced: 'Temporal coupling via git log analysis. Finds files that are frequently changed together. Use to discover hidden dependencies not visible in the call graph.',
  },
  codegraph_unresolved: {
    core: 'Scan for unresolved references',
    analysis: 'Scan for unresolved references — dangling imports, calls, and type uses.',
    advanced: 'Scan for unresolved references — dangling imports, calls, and type uses that point to symbols not in the graph. Use to find missing dependencies or indexing gaps.',
  },
  codegraph_kind_map: {
    core: 'Kind mapping diagnostics',
    analysis: 'Diagnostic: returns edge kind mapping and node kind normalization.',
    advanced: 'Diagnostic: returns edge kind mapping (codegraph→canonical), node kind normalization table, and current graph statistics by kind/type.',
  },
};

/**
 * Get description for an operation at a specific tier level.
 * Falls back to the most detailed available description.
 */
export function getOperationDescription(operation: string, tier: 'core' | 'analysis' | 'advanced' = 'advanced'): string {
  const desc = OPERATION_DESCRIPTIONS[operation];
  if (!desc) return operation;
  return desc[tier] ?? desc.advanced ?? desc.analysis ?? desc.core ?? operation;
}

// Attach tier metadata to the tool for runtime access
(codegraphTool as any).operationTiers = OPERATION_TIERS;
(codegraphTool as any).deferredOperations = DEFERRED_OPERATIONS;
(codegraphTool as any).getOperationDescription = getOperationDescription;
