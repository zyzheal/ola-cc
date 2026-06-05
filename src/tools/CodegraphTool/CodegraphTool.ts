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
import { GraphStore } from '../../services/graph/GraphStore.js';
import { GraphEngine } from '../../services/graph/GraphEngine.js';
import type { GraphSnapshot } from '../../services/graph/GraphEngine.js';
import { FtsSearch } from '../../services/graph/FtsSearch.js';
import { RrfSearch } from '../../services/graph/RrfSearch.js';
import { UnresolvedRefManager } from '../../services/graph/UnresolvedRefManager.js';
import { normalizeKind, isValidKind, VALID_KINDS, getKindAliases } from '../../services/graph/NodeKindNormalizer.js';
import { execSync } from 'child_process';
import { resolve } from 'path';

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
  searchHint: 'code graph AST callers callees impact trace scc toposort pagerank roles coupling community centrality temporal slice delta',
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

    // 完成状态
    if (stage === 'done') {
      return React.createElement(Text, { dimColor: true }, `CodeGraph · Done${elapsedStr}`);
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
            React.createElement(ProgressBar, { ratio, width: 16 }),
            React.createElement(Text, { dimColor: true }, `${progress}%${elapsedStr}`),
          ),
          ...steps.map(line =>
            React.createElement(Text, { dimColor: true, key: line }, `  ${line}`)
          ),
        );
      }

      return React.createElement(Box, { flexDirection: 'row', gap: 1 },
        React.createElement(Text, { dimColor: true }, `CodeGraph · ${stageLabel}`),
        React.createElement(ProgressBar, { ratio, width: 16 }),
        React.createElement(Text, { dimColor: true }, `${progress}%${elapsedStr}`),
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

    try {
      // 自动初始化：如果项目未初始化，自动下载 + init
      if (!CodegraphManager.isCodegraphInitialized(projectRoot)) {
        if (input.operation === 'codegraph_init') {
          // 显式 init → 前台执行，返回进度
          sendProgress('init', 'Initializing CodeGraph index…')
          const initResult = await CodegraphManager.initProject(projectRoot, onStderrProgress);
          if (!initResult.ok) {
            return { data: { error: true, message: `初始化失败: ${initResult.stderr || initResult.stdout}` } };
          }
          return { data: { ok: true, operation: input.operation, result: { message: 'CodeGraph 索引已创建', initialized: true } } };
        }
        if (input.operation === 'codegraph_status') {
          // status 不触发自动初始化，直接返回未初始化状态
          return { data: { ok: true, operation: input.operation, result: { initialized: false, message: 'CodeGraph 索引未初始化' } } };
        }
        // 非 init 操作 → 后台静默初始化
        sendProgress('init', 'Auto-initializing CodeGraph…')
        await CodegraphManager.ensureReady(projectRoot, onStderrProgress);
      }

      let result: unknown;

      switch (input.operation) {
        case 'codegraph_context': {
          if (!input.query) return { data: { error: true, message: 'codegraph_context 需要 query 参数' } };
          sendProgress('context', `Querying: ${input.query.slice(0, 60)}…`)
          const r = await CodegraphManager.getContext(projectRoot, input.query, {
            maxNodes: input.maxNodes ?? 20,
            format: input.format ?? 'json',
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_search': {
          if (!input.query) return { data: { error: true, message: 'codegraph_search 需要 query 参数' } };
          sendProgress('search', `Searching: ${input.query.slice(0, 60)}…`)
          try {
            // F-63: Use FTS5 + RRF fusion for search
            const store = GraphStore.getInstance(projectRoot);
            await store.load();
            const ftsDbPath = resolve(projectRoot, '.codegraph', 'fts-search.db');
            const fts = new FtsSearch(ftsDbPath);
            try {
              // Index nodes if FTS table is empty
              fts.createIndex();
              fts.indexNodes(store);
              const rrf = new RrfSearch(fts, store);
              const results = rrf.search(input.query, input.maxNodes ?? 20);
              result = { results, total: results.length };
            } finally {
              fts.close();
            }
          } catch {
            // Fallback to CLI if FTS5 fails
            const r = await CodegraphManager.searchNodes(projectRoot, input.query, {
              limit: input.maxNodes ?? 20,
            });
            result = parseJsonOrError(r);
          }
          break;
        }

        case 'codegraph_callers': {
          if (!input.symbol) return { data: { error: true, message: 'codegraph_callers 需要 symbol 参数' } };
          sendProgress('callers', `Finding callers of ${input.symbol}…`)
          const r = await CodegraphManager.getCallers(projectRoot, input.symbol, {
            limit: input.maxNodes ?? 20,
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_callees': {
          if (!input.symbol) return { data: { error: true, message: 'codegraph_callees 需要 symbol 参数' } };
          sendProgress('callees', `Finding callees of ${input.symbol}…`)
          const r = await CodegraphManager.getCallees(projectRoot, input.symbol, {
            limit: input.maxNodes ?? 20,
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_impact': {
          if (!input.symbol) return { data: { error: true, message: 'codegraph_impact 需要 symbol 参数' } };
          const impactDepth = input.depth ?? 2;
          if (impactDepth > 2) {
            // Deep impact analysis using GraphEngine (BFS + backward reachability + role classification)
            sendProgress('impact', `Deep impact analysis of ${input.symbol}…`)
            const store = GraphStore.getInstance(projectRoot);
            await store.load();
            const engine = new GraphEngine(store);
            const forward = engine.bfs(input.symbol, impactDepth);
            const backward = engine.backwardReachability(input.symbol);
            const roles = engine.classifyRoles();
            const impacted = forward.nodes.map(n => ({
              node: n,
              depth: forward.depth.get(n) ?? 0,
              role: roles.get(n) ?? 'utility',
              meta: store.getNode(n),
            }));
            const dependents = backward.reachable.map(n => ({
              node: n,
              role: roles.get(n) ?? 'utility',
              meta: store.getNode(n),
            }));
            result = {
              symbol: input.symbol,
              forwardImpact: impacted.slice(0, input.maxNodes ?? 30),
              backwardDependents: dependents.slice(0, input.maxNodes ?? 30),
              forwardCount: forward.nodes.length,
              backwardCount: backward.reachable.length,
            };
          } else {
            // Basic impact analysis using CLI
            sendProgress('impact', `Analyzing impact of ${input.symbol}…`)
            const r = await CodegraphManager.getImpact(projectRoot, input.symbol, impactDepth);
            result = parseJsonOrError(r);
          }
          break;
        }

        case 'codegraph_trace': {
          if (!input.query) return { data: { error: true, message: 'codegraph_trace 需要 query 参数（格式: "从X到Y"）' } };
          sendProgress('trace', `Tracing: ${input.query.slice(0, 60)}…`)
          const parts = input.query.split(/\s*(?:到|to|→|->)\s*/).filter(Boolean);
          if (parts.length < 2) {
            return { data: { error: true, message: '需要 "X 到 Y" 格式', example: 'AuthService.login 到 Database.query' } };
          } else if (parts.length > 2) {
            return { data: { error: true, message: '只支持两个符号之间的追踪，请使用 "X 到 Y" 格式' } };
          } else {
            // 先找到 from 和 to 符号
            sendProgress('trace', `Searching symbols…`)
            const fromNodes = await CodegraphManager.searchNodes(projectRoot, parts[0], { limit: 1 });
            const toNodes = await CodegraphManager.searchNodes(projectRoot, parts[1], { limit: 1 });
            let fromParsed: unknown, toParsed: unknown;
            try {
              fromParsed = parseJsonOrError(fromNodes);
            } catch (e) {
              throw new Error(`Symbol lookup failed for "${parts[0]}": ${e instanceof Error ? e.message : String(e)}`);
            }
            try {
              toParsed = parseJsonOrError(toNodes);
            } catch (e) {
              throw new Error(`Symbol lookup failed for "${parts[1]}": ${e instanceof Error ? e.message : String(e)}`);
            }
            if (!Array.isArray(fromParsed)) {
              throw new Error(`Symbol search for "${parts[0]}" returned unexpected format (${typeof fromParsed})`);
            }
            if (!Array.isArray(toParsed)) {
              throw new Error(`Symbol search for "${parts[1]}" returned unexpected format (${typeof toParsed})`);
            }
            const fromName = fromParsed.length > 0 ? (fromParsed[0].name || fromParsed[0].symbol) : null;
            const toName = toParsed.length > 0 ? (toParsed[0].name || toParsed[0].symbol) : null;
            if (fromName && toName) {
              // 用 impact 做双向分析，找出从 from 到 to 的路径
              const [fromImpact, toImpact] = await Promise.all([
                CodegraphManager.getImpact(projectRoot, fromName, input.depth ?? 3),
                CodegraphManager.getImpact(projectRoot, toName, input.depth ?? 3),
              ]);
              let fromGraph: unknown, toGraph: unknown;
              try {
                fromGraph = parseJsonOrError(fromImpact);
              } catch (e) {
                throw new Error(`Impact query failed for "${fromName}": ${e instanceof Error ? e.message : String(e)}`);
              }
              try {
                toGraph = parseJsonOrError(toImpact);
              } catch (e) {
                throw new Error(`Impact query failed for "${toName}": ${e instanceof Error ? e.message : String(e)}`);
              }
              // Validate both results are arrays
              if (!Array.isArray(fromGraph)) {
                throw new Error(`Impact result for "${fromName}" is not structured data (got ${typeof fromGraph})`);
              }
              if (!Array.isArray(toGraph)) {
                throw new Error(`Impact result for "${toName}" is not structured data (got ${typeof toGraph})`);
              }
              // 找交集：同时出现在 from 的下游和 to 的上游的节点
              const fromSet = new Set(fromGraph.map((n: Record<string, unknown>) => n.name));
              const pathNodes = toGraph.filter((n: Record<string, unknown>) => fromSet.has(n.name));
              result = {
                from: fromName,
                to: toName,
                connectingNodes: pathNodes.slice(0, 10),
                message: pathNodes.length > 0
                  ? `找到 ${pathNodes.length} 个连接节点`
                  : '未找到直接连接路径，可能需要增加 depth 参数',
              };
            } else {
              const missingSymbol = !fromName ? parts[0] : parts[1];
              return { data: { error: true, message: `未找到符号: ${missingSymbol}` } };
            }
          }
          break;
        }

        case 'codegraph_status': {
          const r = await CodegraphManager.getStatus(projectRoot);
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_files': {
          sendProgress('files', 'Listing indexed files…')
          // F-64: Use FileRecord from GraphStore
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const files = [...store.fileRecords.values()];
          result = { files, total: files.length };
          break;
        }

        case 'codegraph_init': {
          if (CodegraphManager.isCodegraphInitialized(projectRoot)) {
            result = { message: 'CodeGraph 索引已存在，无需重复初始化', initialized: true };
          } else {
            sendProgress('init', 'Creating CodeGraph index…')
            const r = await CodegraphManager.initProject(projectRoot, onStderrProgress);
            if (!r.ok) return { data: { error: true, message: r.stderr || '初始化失败' } };
            result = { message: 'CodeGraph 索引已创建', initialized: true };
          }
          break;
        }

        case 'codegraph_sync': {
          sendProgress('sync', 'Syncing CodeGraph index…')
          const r = await CodegraphManager.sync(projectRoot, onStderrProgress);
          if (!r.ok) return { data: { error: true, message: r.stderr || '同步失败' } };
          result = parseJsonOrError(r);
          break;
        }

        // ── Graph algorithm operations ──

        case 'codegraph_scc': {
          sendProgress('scc', 'Computing strongly connected components…')
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          const sccs = engine.tarjanSCC();
          const nonTrivial = sccs.filter(s => !s.isTrivial);
          result = {
            totalComponents: sccs.length,
            nonTrivialComponents: nonTrivial.length,
            components: sccs.slice(0, input.maxNodes ?? 20),
          };
          break;
        }

        case 'codegraph_toposort': {
          sendProgress('toposort', 'Computing topological order…')
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          const topo = engine.topologicalSort();
          result = {
            order: topo.order.slice(0, input.maxNodes ?? 50),
            totalNodes: topo.order.length,
            hasCycles: !!topo.cycles && topo.cycles.length > 0,
            cycles: topo.cycles?.slice(0, 10),
          };
          break;
        }

        case 'codegraph_delta': {
          sendProgress('delta', 'Computing graph delta…')
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          // Build current snapshot
          const curr: GraphSnapshot = {
            adjacency: new Map(store.adjacency),
            nodeMeta: new Map(store.nodeMeta),
            timestamp: Date.now(),
          };
          // For old snapshot: reload from disk (represents previous state)
          // In practice, oldSnapshot/newSnapshot could be commit hashes or timestamps
          // For now, compare current store against a fresh reload
          const oldStore = GraphStore.getInstance(projectRoot);
          await oldStore.reload();
          const old: GraphSnapshot = {
            adjacency: new Map(oldStore.adjacency),
            nodeMeta: new Map(oldStore.nodeMeta),
            timestamp: Date.now() - 1000,
          };
          const delta = engine.deltaGraph(old, curr);
          result = {
            added: delta.added.slice(0, input.maxNodes ?? 50),
            removed: delta.removed.slice(0, input.maxNodes ?? 50),
            edgeAdded: delta.edgeAdded.slice(0, input.maxNodes ?? 50),
            edgeRemoved: delta.edgeRemoved.slice(0, input.maxNodes ?? 50),
            summary: delta.summary,
          };
          break;
        }

        case 'codegraph_pagerank': {
          sendProgress('pagerank', 'Computing PageRank scores…')
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          const pr = engine.pageRank(input.damping ?? 0.85);
          const topN = input.maxNodes ?? 20;
          result = {
            topNodes: pr.scores.slice(0, topN).map(s => ({
              node: s.node,
              score: Math.round(s.score * 10000) / 10000,
              meta: store.getNode(s.node),
            })),
            totalScored: pr.scores.length,
          };
          break;
        }

        case 'codegraph_roles': {
          sendProgress('roles', 'Classifying node roles…')
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          const roles = engine.classifyRoles();
          // Group by role
          const grouped: Record<string, Array<{ node: string; meta?: unknown }>> = {};
          for (const [node, role] of roles) {
            if (!grouped[role]) grouped[role] = [];
            grouped[role].push({ node, meta: store.getNode(node) });
          }
          // Limit per group
          const limit = input.maxNodes ?? 20;
          for (const role of Object.keys(grouped)) {
            grouped[role] = grouped[role].slice(0, limit);
          }
          result = {
            distribution: Object.fromEntries(
              Object.entries(grouped).map(([r, nodes]) => [r, { count: nodes.length, sample: nodes.slice(0, 5) }])
            ),
            totalNodes: roles.size,
          };
          break;
        }

        case 'codegraph_slice': {
          if (!input.symbol) return { data: { error: true, message: 'codegraph_slice 需要 symbol 参数' } };
          sendProgress('slice', `Computing data slice for ${input.symbol}…`)
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          const slice = engine.backwardDataSlice(input.symbol);
          result = {
            symbol: input.symbol,
            symbols: slice.symbols.slice(0, input.maxNodes ?? 30),
            dataFlows: slice.dataFlows.slice(0, input.maxNodes ?? 30),
            totalSymbols: slice.symbols.length,
          };
          break;
        }

        case 'codegraph_coupling': {
          sendProgress('coupling', 'Computing coupling metrics…')
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          const metrics = engine.couplingMetrics();
          result = {
            highCoupling: metrics.highCoupling.slice(0, input.maxNodes ?? 20),
            lcom: metrics.lcom.slice(0, input.maxNodes ?? 20),
            totalHighCoupling: metrics.highCoupling.length,
            totalClasses: metrics.lcom.length,
          };
          break;
        }

        case 'codegraph_community': {
          sendProgress('community', 'Running Louvain community detection…')
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          const community = engine.louvainCommunity({ resolution: input.resolution ?? 1.0 });
          const limit = input.maxNodes ?? 20;
          result = {
            communities: community.communities
              .sort((a, b) => b.size - a.size)
              .slice(0, limit)
              .map(c => ({
                id: c.id,
                size: c.size,
                sample: c.nodes.slice(0, 5),
              })),
            modularity: community.modularity,
            resolution: community.resolution,
            totalCommunities: community.communities.length,
          };
          break;
        }

        case 'codegraph_centrality': {
          const method = input.method ?? 'both';
          sendProgress('centrality', `Computing ${method} centrality…`)
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          const topN = input.maxNodes ?? 20;
          const resultObj: Record<string, unknown> = {};
          if (method === 'katz' || method === 'both') {
            const katz = engine.katzCentrality();
            resultObj.katz = katz.scores.slice(0, topN).map(s => ({
              node: s.node,
              score: Math.round(s.score * 10000) / 10000,
              meta: store.getNode(s.node),
            }));
          }
          if (method === 'betweenness' || method === 'both') {
            const bc = engine.betweennessCentrality(input.sampleSize ?? 200);
            resultObj.betweenness = bc.scores.slice(0, topN).map(s => ({
              node: s.node,
              score: Math.round(s.score * 10000) / 10000,
              meta: store.getNode(s.node),
            }));
          }
          result = resultObj;
          break;
        }

        case 'codegraph_temporal': {
          sendProgress('temporal', 'Analyzing temporal coupling via git log…')
          const sinceArg = input.since ? `--since="${input.since}"` : '--since="30 days"';
          try {
            // Get git log with file lists
            const gitLog = execSync(
              `git log --name-only --pretty=format:"COMMIT:%H" ${sinceArg}`,
              { cwd: projectRoot, encoding: 'utf-8', timeout: 30000 }
            );
            // Parse commits and their changed files
            const commits = gitLog.split(/^COMMIT:/m).filter(Boolean);
            const coChangeMap = new Map<string, number>();
            for (const commit of commits) {
              const lines = commit.trim().split('\n').filter(l => l && !l.startsWith('COMMIT:'));
              // Count co-changes for every pair
              for (let i = 0; i < lines.length; i++) {
                for (let j = i + 1; j < lines.length; j++) {
                  const key = [lines[i], lines[j]].sort().join('↔');
                  coChangeMap.set(key, (coChangeMap.get(key) ?? 0) + 1);
                }
              }
            }
            // Sort by co-change count
            const pairs = [...coChangeMap.entries()]
              .map(([key, count]) => {
                const [a, b] = key.split('↔');
                return { a, b, score: count, coChanges: count };
              })
              .sort((a, b) => b.coChanges - a.coChanges)
              .slice(0, input.maxNodes ?? 30);
            result = {
              pairs,
              totalCommits: commits.length,
              window: { since: input.since ?? '30d', until: 'now' },
            };
          } catch (e) {
            return { data: { error: true, message: `Git log failed: ${e instanceof Error ? e.message : String(e)}` } };
          }
          break;
        }

        // ── Phase Z4 operations ──

        case 'codegraph_unresolved': {
          sendProgress('unresolved', 'Scanning for unresolved references…')
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const manager = new UnresolvedRefManager(store);
          manager.loadFromEdges();
          const unresolved = manager.getUnresolved();
          const resolvedCount = manager.resolve();
          result = {
            unresolved: unresolved.slice(0, input.maxNodes ?? 30),
            total: unresolved.length,
            resolved: resolvedCount,
          };
          break;
        }

        case 'codegraph_kind_map': {
          sendProgress('kind_map', 'Building kind/edge mapping diagnostics…')
          // Edge kind mapping: codegraph → canonical EdgeType
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const edgeMap: Record<string, string> = {
            calls: 'calls', imports: 'imports', contains: 'contains',
            references: 'data', extends: 'inherits', implements: 'implements',
            exports: 'exports', type_of: 'type_of', returns: 'returns',
            instantiates: 'instantiates', overrides: 'overrides', decorates: 'decorates',
            subscribes: 'subscribes', publishes: 'publishes', middleware: 'middleware',
            flow_step: 'flow_step', cross_domain: 'cross_domain',
            reads: 'reads', writes: 'writes', tests: 'tests',
            configures: 'configures', deploys: 'deploys', monitors: 'monitors',
            validates: 'validates', transforms: 'transforms', caches: 'caches',
            queues: 'queues', notifies: 'notifies',
            serializes: 'serializes', deserializes: 'deserializes',
            encrypts: 'encrypts', decrypts: 'decrypts', compresses: 'compresses',
            logs: 'logs', metrics: 'metrics', traces_edge: 'traces',
            authenticates: 'authenticates', authorizes: 'authorizes',
            rate_limits: 'rate_limits',
          }
          // Count edge types in graph
          const edgeTypeCounts: Record<string, number> = {}
          for (const outMap of store.adjacency.values()) {
            for (const edges of outMap.values()) {
              for (const edge of edges) {
                edgeTypeCounts[edge.type] = (edgeTypeCounts[edge.type] ?? 0) + 1
              }
            }
          }
          // Count node kinds in graph
          const nodeKindCounts: Record<string, number> = {}
          for (const node of store.nodeMeta.values()) {
            nodeKindCounts[node.kind] = (nodeKindCounts[node.kind] ?? 0) + 1
          }
          result = {
            edgeKindMapping: edgeMap,
            nodeKindAliases: getKindAliases(),
            validNodeKinds: [...VALID_KINDS],
            graphStats: {
              nodeKinds: nodeKindCounts,
              edgeTypes: edgeTypeCounts,
              totalNodes: store.nodeMeta.size,
            },
            normalizeKindExamples: {
              fn: normalizeKind('fn'),
              cls: normalizeKind('cls'),
              struct: normalizeKind('struct'),
              trait: normalizeKind('trait'),
              proc: normalizeKind('proc'),
              iface: normalizeKind('iface'),
            },
          }
          break
        }

        default:
          return { data: { error: true, message: `未知操作: ${input.operation}` } };
      }

      // 所有操作完成时发送完成进度
      sendProgress('done')

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

      return { data: { ok: true, operation: input.operation, result } };
    } catch (e) {
      logForDebugging(`[codegraph] error: ${e}`);
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
    'codegraph_scc',
    'codegraph_toposort',
    'codegraph_pagerank',
    'codegraph_search',
    'codegraph_status',
  ],
  analysis: [
    'codegraph_community',
    'codegraph_roles',
    'codegraph_impact',
    'codegraph_centrality',
  ],
  advanced: [
    'codegraph_context',
    'codegraph_callers',
    'codegraph_callees',
    'codegraph_trace',
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
    analysis: 'Louvain community detection — find natural module boundaries',
    advanced: 'Louvain modularity-based community detection with configurable resolution. Identifies natural clusters/modules in the code graph. Use to understand codebase structure and find refactoring boundaries.',
  },
  codegraph_roles: {
    analysis: 'Node role classification (hub/bridge/leaf/utility)',
    advanced: 'Classify nodes by structural role: hub (many connections), bridge (connects communities), leaf (terminal), utility (used by many). Use to understand architectural patterns and identify key files.',
  },
  codegraph_impact: {
    analysis: 'Impact analysis — what breaks if X changes',
    advanced: 'Forward and backward impact analysis. depth<=2: CLI-based direct callers/callees. depth>2: GraphEngine BFS + backward reachability + role classification. Use to assess change risk before modifying a symbol.',
  },
  codegraph_centrality: {
    analysis: 'Katz/betweenness centrality — find bridge nodes',
    advanced: 'Katz and/or betweenness centrality analysis. Katz measures global influence via path sums. Betweenness identifies nodes that bridge different parts of the graph. Use to find critical integration points.',
  },
  codegraph_context: {
    advanced: 'Query code context by task description. Returns relevant symbols, files, and relationships for a given task or question.',
  },
  codegraph_callers: {
    advanced: 'Find all callers of a symbol (who uses this function/class). Returns calling symbols with file and line metadata.',
  },
  codegraph_callees: {
    advanced: 'Find all callees of a symbol (what does this function call). Returns called symbols with file and line metadata.',
  },
  codegraph_trace: {
    advanced: 'Trace call path between two symbols. Format: "X to Y". Uses bidirectional impact analysis to find connecting nodes.',
  },
  codegraph_init: {
    advanced: 'Initialize CodeGraph index for the current project. Downloads CLI (~45MB) on first use and creates the symbol database.',
  },
  codegraph_files: {
    advanced: 'List indexed files with directory structure. Returns file tree up to specified depth.',
  },
  codegraph_sync: {
    advanced: 'Sync CodeGraph index with current source code. Re-indexes changed files since last sync.',
  },
  codegraph_delta: {
    advanced: 'Compute graph delta between two snapshots. Returns added/removed nodes and edges with summary.',
  },
  codegraph_slice: {
    advanced: 'Backward data slice for a symbol. Identifies all symbols that influence the target symbol\'s value through data flow analysis.',
  },
  codegraph_coupling: {
    advanced: 'Coupling metrics: high-coupling pairs and LCOM (Lack of Cohesion of Methods) scores. Use to identify code that should be refactored.',
  },
  codegraph_temporal: {
    advanced: 'Temporal coupling via git log analysis. Finds files that are frequently changed together. Use to discover hidden dependencies not visible in the call graph.',
  },
  codegraph_unresolved: {
    advanced: 'Scan for unresolved references — dangling imports, calls, and type uses that point to symbols not in the graph. Use to find missing dependencies or indexing gaps.',
  },
  codegraph_kind_map: {
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

// ============================================================
// Helpers
// ============================================================

function parseJsonOrError(r: { ok: boolean; stdout: string; stderr: string }): unknown {
  if (!r.ok) {
    throw new Error(r.stderr || 'command failed');
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    // Non-JSON output from CLI — return as string but log warning for debugging
    const trimmed = r.stdout.trim().slice(0, 2000);
    if (trimmed.length > 0) {
      return trimmed;
    }
    throw new Error('CodeGraph CLI returned empty output');
  }
}
