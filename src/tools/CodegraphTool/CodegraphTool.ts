/**
 * CodegraphTool — 原生集成 CodeGraph 代码知识图谱
 *
 * 自动下载 codegraph CLI（首次使用），自动初始化项目索引。
 * 无需用户手动安装，无需 MCP 配置。
 */

import { z } from 'zod/v4';
import { buildTool } from '../../Tool.js';
import { getCwd } from '../../utils/cwd.js';
import { logForDebugging } from '../../utils/debug.js';
import * as CodegraphManager from './CodegraphManager.js';

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
]);

const inputSchema = z.object({
  operation: operationEnum.describe('CodeGraph 操作类型'),
  query: z.string().max(10000).optional().describe('查询内容（任务描述 / 符号名）'),
  symbol: z.string().max(1000).optional().describe('符号名称（用于 callers/callees/impact/trace）'),
  maxNodes: z.number().min(1).max(100).optional().describe('最大返回节点数（默认 20）'),
  format: z.enum(['markdown', 'json']).optional().describe('输出格式（默认 markdown）'),
  depth: z.number().min(1).max(10).optional().describe('影响分析深度（默认 2）'),
});

type Input = z.infer<typeof inputSchema>;

// ============================================================
// Tool
// ============================================================

export const codegraphTool = buildTool({
  name: 'codegraph',
  searchHint: 'code graph AST callers callees impact trace',
  maxResultSizeChars: 50_000,
  inputSchema,
  renderToolUseMessage() { return null },

  async description() {
    return (
      'CodeGraph 代码知识图谱 — 语义查询、调用链追踪、影响分析。自动下载、自动索引当前项目。' +
      '用 codegraph_context 理解代码全貌，codegraph_trace 追踪调用路径，' +
      'codegraph_impact 分析修改影响范围。首次使用自动下载（~45MB）。'
    )
  },

  async call(input: Input, _context, _canUseTool, _parentMessage, _onProgress) {
    const projectRoot = getCwd();

    try {
      // 自动初始化：如果项目未初始化，自动下载 + init
      if (!CodegraphManager.isCodegraphInitialized(projectRoot)) {
        if (input.operation === 'codegraph_init') {
          // 显式 init → 前台执行，返回进度
          const initResult = await CodegraphManager.initProject(projectRoot);
          if (!initResult.ok) {
            return { data: { error: true, message: `初始化失败: ${initResult.stderr || initResult.stdout}` } };
          }
          return { data: { ok: true, operation: input.operation, result: { message: 'CodeGraph 索引已创建', initialized: true } } };
        }
        // 非 init 操作 → 后台静默初始化
        await CodegraphManager.ensureReady(projectRoot);
      }

      let result: unknown;

      switch (input.operation) {
        case 'codegraph_context': {
          if (!input.query) return { data: { error: true, message: 'codegraph_context 需要 query 参数' } };
          const r = await CodegraphManager.getContext(projectRoot, input.query, {
            maxNodes: input.maxNodes ?? 20,
            format: input.format ?? 'json',
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_search': {
          if (!input.query) return { data: { error: true, message: 'codegraph_search 需要 query 参数' } };
          const r = await CodegraphManager.searchNodes(projectRoot, input.query, {
            limit: input.maxNodes ?? 20,
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_callers': {
          if (!input.symbol) return { data: { error: true, message: 'codegraph_callers 需要 symbol 参数' } };
          const r = await CodegraphManager.getCallers(projectRoot, input.symbol, {
            limit: input.maxNodes ?? 20,
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_callees': {
          if (!input.symbol) return { data: { error: true, message: 'codegraph_callees 需要 symbol 参数' } };
          const r = await CodegraphManager.getCallees(projectRoot, input.symbol, {
            limit: input.maxNodes ?? 20,
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_impact': {
          if (!input.symbol) return { data: { error: true, message: 'codegraph_impact 需要 symbol 参数' } };
          const r = await CodegraphManager.getImpact(projectRoot, input.symbol, input.depth ?? 2);
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_trace': {
          if (!input.query) return { data: { error: true, message: 'codegraph_trace 需要 query 参数（格式: "从X到Y"）' } };
          const parts = input.query.split(/\b(?:到|to|→|->)\b/).map(s => s.trim()).filter(Boolean);
          if (parts.length < 2) {
            result = { error: '需要 "X 到 Y" 格式', example: 'AuthService.login 到 Database.query' };
          } else {
            // 先找到 from 和 to 符号
            const fromNodes = await CodegraphManager.searchNodes(projectRoot, parts[0], { limit: 1 });
            const toNodes = await CodegraphManager.searchNodes(projectRoot, parts[1], { limit: 1 });
            const fromParsed = parseJsonOrError(fromNodes);
            const toParsed = parseJsonOrError(toNodes);
            if (Array.isArray(fromParsed) && fromParsed.length > 0 && Array.isArray(toParsed) && toParsed.length > 0) {
              // 用 impact 做双向分析，找出从 from 到 to 的路径
              const [fromImpact, toImpact] = await Promise.all([
                CodegraphManager.getImpact(projectRoot, fromParsed[0].name, input.depth ?? 3),
                CodegraphManager.getImpact(projectRoot, toParsed[0].name, input.depth ?? 3),
              ]);
              const fromGraph = parseJsonOrError(fromImpact);
              const toGraph = parseJsonOrError(toImpact);
              // 找交集：同时出现在 from 的下游和 to 的上游的节点
              const fromSet = new Set(
                Array.isArray(fromGraph) ? fromGraph.map((n: Record<string, unknown>) => n.name) : []
              );
              const pathNodes = Array.isArray(toGraph)
                ? toGraph.filter((n: Record<string, unknown>) => fromSet.has(n.name))
                : [];
              result = {
                from: fromParsed[0].name,
                to: toParsed[0].name,
                connectingNodes: pathNodes.slice(0, 10),
                message: pathNodes.length > 0
                  ? `找到 ${pathNodes.length} 个连接节点`
                  : '未找到直接连接路径，可能需要增加 depth 参数',
              };
            } else {
              const missingSymbol = !Array.isArray(fromParsed) || fromParsed.length === 0 ? parts[0] : parts[1];
              result = { error: `未找到符号: ${missingSymbol}` };
            }
          }
          break;
        }

        case 'codegraph_explore': {
          if (!input.query) return { data: { error: true, message: 'codegraph_explore 需要 query 参数' } };
          const r = await CodegraphManager.searchNodes(projectRoot, input.query, {
            limit: input.maxNodes ?? 20,
          });
          const nodes = parseJsonOrError(r);
          // 对每个节点获取上下文
          if (Array.isArray(nodes) && nodes.length > 0) {
            result = nodes.slice(0, 5).map((n: Record<string, unknown>) => ({
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
            const r = await CodegraphManager.initProject(projectRoot);
            if (!r.ok) return { data: { error: true, message: r.stderr || '初始化失败' } };
            result = { message: 'CodeGraph 索引已创建', initialized: true };
          }
          break;
        }

        case 'codegraph_sync': {
          const r = await CodegraphManager.sync(projectRoot);
          if (!r.ok) return { data: { error: true, message: r.stderr || '同步失败' } };
          result = parseJsonOrError(r);
          break;
        }

        default:
          return { data: { error: true, message: `未知操作: ${input.operation}` } };
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
    return op !== 'codegraph_init' && op !== 'codegraph_sync';
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
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: text,
    };
  },
});

// ============================================================
// Helpers
// ============================================================

function parseJsonOrError(r: { ok: boolean; stdout: string; stderr: string }): unknown {
  if (!r.ok) {
    return { error: r.stderr || 'command failed' };
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    return r.stdout.trim().slice(0, 2000);
  }
}
