#!/usr/bin/env bun
/**
 * CodegraphTool TUI Demo — 展示所有渲染器的实际终端输出效果
 * 用法: bun run scripts/demo-codegraph-tui.tsx
 */
import React from 'react';
import { Box, Text, renderToString } from 'ink';
import { ProgressBar } from '../src/components/design-system/ProgressBar.js';

// ============================================================
// Mock data for each renderer
// ============================================================

const DEMOS: Array<{ title: string; element: React.ReactNode }> = [];

// ── 1. Search result (context/search/callers/callees) ──
DEMOS.push({
  title: 'codegraph_search — 符号搜索',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold>符号搜索 (8)</Text>
      <Box height={1} />
      {[
        { kind: 'function', name: 'GraphEngine.pageRank', file: 'src/services/graph/GraphEngine.ts', line: 120 },
        { kind: 'class', name: 'GraphEngine', file: 'src/services/graph/GraphEngine.ts', line: 30 },
        { kind: 'method', name: 'GraphStore.load', file: 'src/services/graph/GraphStore.ts', line: 85 },
        { kind: 'function', name: 'tarjanSCC', file: 'src/services/graph/GraphEngine.ts', line: 200 },
        { kind: 'interface', name: 'GraphSnapshot', file: 'src/services/graph/GraphEngine.ts', line: 12 },
      ].map((r, i) => (
        <Box flexDirection="row" key={`${r.name}-${i}`}>
          <Text dimColor>{`  ${r.kind.padEnd(12)}`}</Text>
          <Text>{r.name}</Text>
          <Text dimColor>{`  ${r.file}:${r.line}`}</Text>
        </Box>
      ))}
      <Text dimColor marginTop={1}>... 还有 3 个结果</Text>
    </Box>
  ),
});

// ── 2. Impact analysis ──
DEMOS.push({
  title: 'codegraph_impact — 影响分析',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
      <Text bold>影响分析: GraphEngine.pageRank</Text>
      <Text dimColor>前向影响: 12 节点  |  反向依赖: 5 节点</Text>
      <Box height={1} />
      <Box flexDirection="column">
        <Text bold dimColor>前向影响链:</Text>
        {['CodegraphTool.call', 'renderPagerankResult', 'query.ts handleToolCall'].map((name, i) => (
          <Text dimColor key={`fwd-${i}`}>{`  • ${name}`}</Text>
        ))}
      </Box>
    </Box>
  ),
});

// ── 3. Deep impact analysis (dominator tree + data slice) ──
DEMOS.push({
  title: 'codegraph_impact_deep — 深度影响分析',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
      <Text bold>深度影响分析: GraphEngine.pageRank</Text>
      <Text dimColor>深度影响分析: GraphEngine.pageRank — 47 个支配节点, 23 个数据依赖符号</Text>
      <Text dimColor>function @ src/services/graph/GraphEngine.ts:120  |  共 58 个符号受影响</Text>
      <Box height={1} />
      <Box flexDirection="column">
        <Text bold dimColor>支配树 (控制流):</Text>
        {[
          'GraphStore.load → 支配者: GraphEngine.constructor (GraphStore)',
          'tarjanSCC → 支配者: GraphEngine (GraphEngine)',
          'pageRank → 支配者: GraphEngine (GraphEngine)',
        ].map((d, i) => <Text dimColor key={`dom-${i}`}>{`  • ${d}`}</Text>)}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>数据切片 (数据流):</Text>
        {['GraphStore.adjacency', 'GraphStore.nodeMeta', 'GraphStore.fileRecords'].map((s, i) => (
          <Text dimColor key={`slice-${i}`}>{`  • ${s}`}</Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>建议:</Text>
        <Text dimColor>{'  • codegraph_coupling'}</Text>
        <Text dimColor>{'  • codegraph_community'}</Text>
      </Box>
    </Box>
  ),
});

// ── 4. SCC (循环依赖检测) ──
DEMOS.push({
  title: 'codegraph_scc — 循环依赖检测',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
      <Text bold>循环依赖检测</Text>
      <Text>总 SCC: 15  |  非平凡: 2</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>循环依赖:</Text>
        <Text dimColor>{'  • GraphStore, GraphEngine, IncrementalSync'}</Text>
        <Text dimColor>{'  • QueryEngine, query.ts, ToolExecutor'}</Text>
      </Box>
    </Box>
  ),
});

// ── 5. PageRank (无循环依赖时显示绿色) ──
DEMOS.push({
  title: 'codegraph_pagerank — 重要性排名',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" padding={1}>
      <Text bold>PageRank 重要性排名 (1523 节点)</Text>
      <Box height={1} />
      {[
        { rank: 1, node: 'GraphStore', score: 0.0823 },
        { rank: 2, node: 'GraphEngine', score: 0.0712 },
        { rank: 3, node: 'CodegraphTool', score: 0.0645 },
        { rank: 4, node: 'QueryEngine', score: 0.0531 },
        { rank: 5, node: 'AppState', score: 0.0489 },
      ].map((n) => (
        <Box flexDirection="row" key={`pr-${n.rank}`}>
          <Text dimColor>{`  ${n.rank.toString().padStart(2, ' ')}. `}</Text>
          <Text>{n.node}</Text>
          <Text dimColor>{`  (${(n.score * 100).toFixed(1)}%)`}</Text>
        </Box>
      ))}
    </Box>
  ),
});

// ── 6. Community detection ──
DEMOS.push({
  title: 'codegraph_community — 社区检测',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold>社区检测 (8 社区)</Text>
      <Text dimColor>Modularity: 0.672</Text>
      <Box height={1} />
      {[
        { id: 0, size: 45, sample: ['GraphStore', 'GraphEngine', 'IncrementalSync'] },
        { id: 1, size: 38, sample: ['CodegraphTool', 'CodegraphManager'] },
        { id: 2, size: 32, sample: ['QueryEngine', 'query.ts'] },
      ].map((c) => (
        <Box flexDirection="column" key={c.id}>
          <Text>{`  社区 ${c.id}: ${c.size} 节点`}</Text>
          {c.sample.map((s) => <Text dimColor key={`${c.id}-${s}`}>{`    • ${s}`}</Text>)}
        </Box>
      ))}
    </Box>
  ),
});

// ── 7. Roles (角色分类) ──
DEMOS.push({
  title: 'codegraph_roles — 角色分类',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold>角色分类 (1523 节点)</Text>
      <Box height={1} />
      {[
        { role: 'hub', count: 12, sample: ['GraphStore', 'GraphEngine'] },
        { role: 'bridge', count: 28, sample: ['CodegraphTool', 'GrokTool'] },
        { role: 'utility', count: 156, sample: ['normalizePath', 'parseJsonOrError'] },
        { role: 'leaf', count: 45, sample: ['demo script', 'test helper'] },
      ].map((r) => (
        <Box flexDirection="column" key={r.role}>
          <Text>{`  ${r.role}: ${r.count} 节点`}</Text>
          {r.sample.map((s) => <Text dimColor key={`${r.role}-${s}`}>{`    • ${s}`}</Text>)}
        </Box>
      ))}
    </Box>
  ),
});

// ── 8. Status ──
DEMOS.push({
  title: 'codegraph_status — 索引状态',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="green" padding={1}>
      <Text bold>CodeGraph 索引</Text>
      <Text>文件: 543  |  节点: 15,234  |  边: 42,891</Text>
      <Text dimColor>索引已 12 分钟未更新，可能缺少最新变更。执行 codegraph_sync 可刷新。</Text>
    </Box>
  ),
});

// ── 9. Init/Sync result ──
DEMOS.push({
  title: 'codegraph_sync — 同步完成',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="green" padding={1}>
      <Text bold color="green">✓ 同步完成</Text>
      <Text>增量更新: 3 个文件变更</Text>
      <Text>文件: 543  |  节点: 15,234  |  边: 42,891</Text>
    </Box>
  ),
});

// ── 10. Progress bar demo (with color change) ──
DEMOS.push({
  title: '进度条变色效果 (0→30% yellow, 30→70% cyan, 70→100% green)',
  element: (
    <Box flexDirection="column" padding={1}>
      {[
        { stage: 'Parsing', progress: 15, label: 'yellow' },
        { stage: 'Resolving', progress: 45, label: 'cyan' },
        { stage: 'Indexing', progress: 82, label: 'green' },
        { stage: 'Done', progress: 100, label: 'green ✓' },
      ].map(({ stage, progress, label }) => (
        <Box flexDirection="row" gap={1} key={stage}>
          <Text dimColor>{`│  ${progress >= 100 ? '◆' : '✢'} ${stage.padEnd(8)}`}</Text>
          <ProgressBar ratio={progress / 100} width={20} fillColor={progress < 30 ? 'yellow' : progress < 70 ? 'cyan' : 'green'} />
          <Text dimColor color={progress >= 100 ? 'green' : undefined}>{`${progress}%  (${label})`}</Text>
        </Box>
      ))}
    </Box>
  ),
});

// ── 11. Unresolved references ──
DEMOS.push({
  title: 'codegraph_unresolved — 未解析引用',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
      <Text bold>未解析引用</Text>
      <Text>未解析: 5  |  已自动解析: 12</Text>
      <Box flexDirection="column" marginTop={1}>
        {[
          { from: 'src/utils/helper.ts:importFoo', to: 'external-lib/foo' },
          { from: 'src/services/api.ts:useAuth', to: '@auth/provider' },
          { from: 'src/tools/Agent.ts:runAgent', to: 'missing-module' },
        ].map((u, i) => (
          <Text dimColor key={`unres-${i}`}>{`  • ${u.from} → ${u.to}`}</Text>
        ))}
      </Box>
    </Box>
  ),
});

// ── 12. Coupling metrics ──
DEMOS.push({
  title: 'codegraph_coupling — 耦合度量',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
      <Text bold>耦合度量</Text>
      <Box height={1} />
      <Box flexDirection="column">
        <Text bold dimColor>高耦合对:</Text>
        {[
          'GraphStore ↔ GraphEngine (instability=0.35)',
          'CodegraphTool ↔ CodegraphManager (instability=0.42)',
          'QueryEngine ↔ query.ts (instability=0.28)',
        ].map((c, i) => <Text dimColor key={`couple-${i}`}>{`  • ${c}`}</Text>)}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>LCOM 内聚度:</Text>
        <Text dimColor>{'  • GraphEngine: LCOM=0.72'}</Text>
        <Text dimColor>{'  • CodegraphTool: LCOM=0.85'}</Text>
      </Box>
    </Box>
  ),
});

// ── 13. Onboard guide ──
DEMOS.push({
  title: 'codegraph_onboard — 入职指南',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold>入职指南</Text>
      <Text dimColor>已生成 Markdown 格式的入职指南</Text>
    </Box>
  ),
});

// ============================================================
// GrokTool TUI Demos
// ============================================================

// ── 14. Grok Chat ──
DEMOS.push({
  title: 'grok_chat — 智能问答',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold>Q: What is the purpose of GraphEngine?</Text>
      <Box height={1} />
      <Text>GraphEngine is the core algorithm engine that provides 15 graph algorithms including PageRank, Tarjan SCC, Louvain community detection, and BFS/DFS. It operates on data loaded from GraphStore and is used by both CodegraphTool and GrokTool for structural analysis.</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>相关文件:</Text>
        <Text dimColor>{'  • src/services/graph/GraphEngine.ts:30'}</Text>
        <Text dimColor>{'  • src/services/graph/GraphStore.ts:85'}</Text>
      </Box>
    </Box>
  ),
});

// ── 15. Grok Architecture ──
DEMOS.push({
  title: 'grok_architecture — 架构分析',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold>架构分析 (8 个社区)</Text>
      <Text dimColor>Modularity: 0.672</Text>
      <Box height={1} />
      {[
        { id: 0, size: 45, sample: ['GraphStore', 'GraphEngine', 'IncrementalSync'] },
        { id: 1, size: 38, sample: ['CodegraphTool', 'CodegraphManager'] },
        { id: 2, size: 32, sample: ['QueryEngine', 'query.ts'] },
      ].map((c) => (
        <Box flexDirection="column" key={c.id}>
          <Text>{`  社区 ${c.id}: ${c.size} 节点`}</Text>
          {c.sample.map((s) => <Text dimColor key={`${c.id}-${s}`}>{`    • ${s}`}</Text>)}
        </Box>
      ))}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>LLM 分析:</Text>
        <Text dimColor>{'  架构分为 3 个主要模块群: 图核心层 (GraphStore/Engine), 工具层 (CodegraphTool/GrokTool), 引擎层 (QueryEngine/query.ts)。建议关注 GraphStore↔GraphEngine 的高耦合。'}</Text>
      </Box>
    </Box>
  ),
});

// ── 16. Grok Hotspots ──
DEMOS.push({
  title: 'grok_hotspots — 热点分析',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" padding={1}>
      <Text bold>热点分析 (20 个热点)</Text>
      <Box height={1} />
      {[
        'GraphStore (score: 8%)',
        'GraphEngine (score: 7%)',
        'CodegraphTool (score: 6%)',
        'QueryEngine (score: 5%)',
      ].map((h, i) => <Text dimColor key={`hot-${i}`}>{`  • ${h}`}</Text>)}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>时间耦合 (last 30 days, 142 commits):</Text>
        <Text dimColor>{'  • GraphStore.ts ↔ GraphEngine.ts (23 co-changes)'}</Text>
        <Text dimColor>{'  • CodegraphTool.ts ↔ CodegraphManager.ts (18 co-changes)'}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor bold>LLM 分析:</Text>
        <Text dimColor>{'  GraphStore 和 GraphEngine 是架构热点，频繁共变表明高耦合。建议考虑引入接口层解耦。'}</Text>
      </Box>
    </Box>
  ),
});

// ── 17. Grok Status ──
DEMOS.push({
  title: 'grok_status — 图谱状态',
  element: (
    <Box flexDirection="column" borderStyle="round" borderColor="green" padding={1}>
      <Text bold>Grok 知识图谱</Text>
      <Text>节点: 15,234  |  边: 42,891</Text>
      <Text dimColor>更新: 2026-06-06T12:00:00Z</Text>
    </Box>
  ),
});

// ── 18. Grok Generate (with progress) ──
DEMOS.push({
  title: 'grok_generate — 图谱生成进度 (含变色进度条)',
  element: (
    <Box flexDirection="column" padding={1}>
      <Text dimColor>{'│'}</Text>
      <Text dimColor>{'│  ◆ 扫描文件        — done'}</Text>
      <Text dimColor>{'│  ◆ 分析代码        — done'}</Text>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{'│  ✢ 组装图谱        '}</Text>
        <ProgressBar ratio={0.65} width={20} fillColor="cyan" />
        <Text dimColor>{'65%  (42s)'}</Text>
      </Box>
    </Box>
  ),
});

// ============================================================
// Render all demos
// ============================================================

const SEPARATOR = '═'.repeat(72);

for (const demo of DEMOS) {
  console.log(`\n${SEPARATOR}`);
  console.log(`  ${demo.title}`);
  console.log(SEPARATOR);
  try {
    const output = renderToString(demo.element, { columns: 80 });
    console.log(output);
  } catch (e) {
    console.log(`  [渲染错误] ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n${SEPARATOR}`);
console.log('  Demo 完成 — 共展示 18 个 TUI 渲染器效果');
console.log(SEPARATOR);
