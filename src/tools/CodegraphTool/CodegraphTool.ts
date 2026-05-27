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
]);

const inputSchema = z.object({
  operation: operationEnum.describe('CodeGraph 操作类型'),
  query: z.string().optional().describe('查询内容（任务描述 / 符号名）'),
  symbol: z.string().optional().describe('符号名称（用于 callers/callees/impact/trace）'),
  maxNodes: z.number().optional().describe('最大返回节点数（默认 20）'),
  includeCode: z.boolean().optional().describe('是否包含源码（默认 true）'),
  format: z.enum(['markdown', 'json']).optional().describe('输出格式（默认 markdown）'),
  depth: z.number().optional().describe('影响分析深度（默认 2）'),
});

// ============================================================
// Tool
// ============================================================

export const codegraphTool = buildTool({
  name: 'codegraph',
  description:
    'CodeGraph 代码知识图谱 — 语义查询、调用链追踪、影响分析。自动下载、自动索引当前项目。' +
    '用 codegraph_context 理解代码全貌，codegraph_trace 追踪调用路径，' +
    'codegraph_impact 分析修改影响范围。首次使用自动下载（~45MB）。',

  inputSchema,

  async call(input: z.infer<typeof inputSchema>) {
    const projectRoot = getCwd();

    try {
      // 自动初始化：如果项目未初始化，自动下载 + init
      if (!CodegraphManager.isCodegraphInitialized(projectRoot)) {
        if (input.operation === 'codegraph_init') {
          // 显式 init → 前台执行，返回进度
          const result = await CodegraphManager.initProject(projectRoot);
          return successResult(input.operation, { message: 'CodeGraph 索引已创建', initialized: true });
        }
        // 非 init 操作 → 后台静默初始化
        await CodegraphManager.ensureReady(projectRoot);
      }

      let result: unknown;

      switch (input.operation) {
        case 'codegraph_context': {
          if (!input.query) return errorResult('codegraph_context 需要 query 参数');
          const r = await CodegraphManager.getContext(projectRoot, input.query, {
            maxNodes: input.maxNodes ?? 20,
            format: input.format ?? 'json',
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_search': {
          if (!input.query) return errorResult('codegraph_search 需要 query 参数');
          const r = await CodegraphManager.searchNodes(projectRoot, input.query, {
            limit: input.maxNodes ?? 20,
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_callers': {
          if (!input.symbol) return errorResult('codegraph_callers 需要 symbol 参数');
          const r = await CodegraphManager.getCallers(projectRoot, input.symbol, {
            limit: input.maxNodes ?? 20,
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_callees': {
          if (!input.symbol) return errorResult('codegraph_callees 需要 symbol 参数');
          const r = await CodegraphManager.getCallees(projectRoot, input.symbol, {
            limit: input.maxNodes ?? 20,
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_impact': {
          if (!input.symbol) return errorResult('codegraph_impact 需要 symbol 参数');
          const r = await CodegraphManager.getImpact(projectRoot, input.symbol, input.depth ?? 2);
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_trace': {
          if (!input.query) return errorResult('codegraph_trace 需要 query 参数（格式: "从X到Y"）');
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
              // 用 callers 遍历找路径（简化版 trace）
              const callers = await CodegraphManager.getCallers(projectRoot, toParsed[0].name, { limit: 50 });
              result = parseJsonOrError(callers);
            } else {
              result = { error: `未找到符号: ${fromParsed.length === 0 ? parts[0] : parts[1]}` };
            }
          }
          break;
        }

        case 'codegraph_explore': {
          if (!input.query) return errorResult('codegraph_explore 需要 query 参数');
          const r = await CodegraphManager.searchNodes(projectRoot, input.query, {
            limit: input.maxNodes ?? 20,
          });
          const nodes = parseJsonOrError(r);
          // 对每个节点获取上下文
          if (Array.isArray(nodes) && nodes.length > 0) {
            result = nodes.slice(0, 5).map((n: any) => ({
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
            maxDepth: input.maxNodes ?? 3,
            format: 'json',
          });
          result = parseJsonOrError(r);
          break;
        }

        case 'codegraph_init': {
          const r = await CodegraphManager.initProject(projectRoot);
          if (!r.ok) return errorResult(r.stderr || '初始化失败');
          result = { message: 'CodeGraph 索引已创建', initialized: true };
          break;
        }

        default:
          return errorResult(`未知操作: ${input.operation}`);
      }

      return successResult(input.operation, result);
    } catch (e) {
      logForDebugging(`[codegraph] error: ${e}`);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: true,
            operation: input.operation,
            message: e instanceof Error ? e.message : String(e),
          }, null, 2),
        }],
      };
    }
  },

  async prompt(input) {
    const op = input?.operation ?? '';
    const query = input?.query ?? '';
    const symbol = input?.symbol ?? '';
    switch (op) {
      case 'codegraph_context': return `构建 "${query}" 的代码上下文`;
      case 'codegraph_search': return `搜索符号 "${query}"`;
      case 'codegraph_callers': return `查找 "${symbol}" 的调用者`;
      case 'codegraph_callees': return `查找 "${symbol}" 调用的函数`;
      case 'codegraph_impact': return `分析 "${symbol}" 的影响范围`;
      case 'codegraph_trace': return `追踪调用路径: ${query}`;
      case 'codegraph_explore': return `探索代码区域: ${query}`;
      case 'codegraph_status': return '检查 CodeGraph 索引状态';
      case 'codegraph_init': return '初始化 CodeGraph 代码知识图谱';
      case 'codegraph_files': return '列出已索引的文件';
      default: return `CodeGraph ${op}`;
    }
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
  isReadOnly: (input) => {
    const op = typeof input === 'object' && input !== null && 'operation' in input
      ? (input as { operation?: string }).operation ?? ''
      : '';
    return op !== 'codegraph_init';
  },
});

// ============================================================
// Helpers
// ============================================================

function successResult(operation: string, data: unknown) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ok: true, operation, result: data }, null, 2),
    }],
  };
}

function errorResult(message: string) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: true, message }, null, 2),
    }],
  };
}

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
