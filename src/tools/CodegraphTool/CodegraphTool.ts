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
import { execSync } from 'child_process';

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
  'codegraph_explore',
  'codegraph_status',
  'codegraph_init',
  'codegraph_files',
  'codegraph_sync',
  // Graph algorithm operations
  'codegraph_scc',
  'codegraph_toposort',
  'codegraph_delta',
  'codegraph_pagerank',
  'codegraph_impact_deep',
  'codegraph_roles',
  'codegraph_slice',
  'codegraph_coupling',
  'codegraph_community',
  'codegraph_centrality',
  'codegraph_temporal',
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
      codegraph_explore: '探索代码',
      codegraph_status: '查看状态',
      codegraph_init: '初始化索引',
      codegraph_files: '列出文件',
      codegraph_sync: '同步索引',
      codegraph_scc: 'SCC 分析',
      codegraph_toposort: '拓扑排序',
      codegraph_delta: '差分图',
      codegraph_pagerank: 'PageRank',
      codegraph_impact_deep: '深度影响分析',
      codegraph_roles: '角色分类',
      codegraph_slice: '数据切片',
      codegraph_coupling: '耦合度量',
      codegraph_community: '社区检测',
      codegraph_centrality: '中心性分析',
      codegraph_temporal: '时间耦合',
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
          const r = await CodegraphManager.searchNodes(projectRoot, input.query, {
            limit: input.maxNodes ?? 20,
          });
          result = parseJsonOrError(r);
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
          sendProgress('impact', `Analyzing impact of ${input.symbol}…`)
          const r = await CodegraphManager.getImpact(projectRoot, input.symbol, input.depth ?? 2);
          result = parseJsonOrError(r);
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

        case 'codegraph_explore': {
          if (!input.query) return { data: { error: true, message: 'codegraph_explore 需要 query 参数' } };
          sendProgress('explore', `Exploring: ${input.query.slice(0, 60)}…`)
          const r = await CodegraphManager.searchNodes(projectRoot, input.query, {
            limit: input.maxNodes ?? 5,
          });
          const nodes = parseJsonOrError(r);
          // 对每个节点获取上下文
          const exploreLimit = Math.min(input.maxNodes ?? 5, 20);
          if (Array.isArray(nodes) && nodes.length > 0) {
            result = nodes.slice(0, exploreLimit).map((n: Record<string, unknown>) => ({
              name: n.name,
              kind: n.kind,
              file: n.file,
              line: n.line,
            }));
          } else {
            result = nodes;
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
          const r = await CodegraphManager.getFiles(projectRoot, {
            maxDepth: input.depth ?? 3,
            format: 'json',
          });
          result = parseJsonOrError(r);
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

        case 'codegraph_impact_deep': {
          if (!input.symbol) return { data: { error: true, message: 'codegraph_impact_deep 需要 symbol 参数' } };
          sendProgress('impact_deep', `Deep impact analysis of ${input.symbol}…`)
          const store = GraphStore.getInstance(projectRoot);
          await store.load();
          const engine = new GraphEngine(store);
          // Combine BFS traversal + backward reachability + role classification
          const forward = engine.bfs(input.symbol, input.depth ?? 3);
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

        default:
          return { data: { error: true, message: `未知操作: ${input.operation}` } };
      }

      // 所有操作完成时发送完成进度
      sendProgress('done')

      // 查询操作追加新鲜度提示
      const isQueryOp = ['codegraph_context', 'codegraph_search', 'codegraph_callers',
        'codegraph_callees', 'codegraph_impact', 'codegraph_trace', 'codegraph_explore',
        'codegraph_scc', 'codegraph_toposort', 'codegraph_pagerank', 'codegraph_impact_deep',
        'codegraph_roles', 'codegraph_slice', 'codegraph_coupling', 'codegraph_community',
        'codegraph_centrality', 'codegraph_temporal'].includes(input.operation);
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
