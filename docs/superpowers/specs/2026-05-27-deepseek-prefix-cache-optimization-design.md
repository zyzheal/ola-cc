# DeepSeek V4 Prefix Cache 优化设计方案

## 概述

针对 DeepSeek V4 Flash/Pro（上下文窗口 1M tokens）通过 ola-cc 接入时的 token 消耗优化，核心通过**工具列表会话级冻结**和**Provider 自感知参数注入**两个最小改动，最大化 prefix caching 命中率，降低 TTFT 和 token 消耗。

## 背景

### 接入方式

DeepSeek V4 通过两种方式接入 ola-cc：

| 接入方式 | 适配器 | 配置示例 |
|---------|--------|---------|
| Anthropic API 兼容 | `src/services/api/claude.ts`（原生） | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` |
| OpenAI 兼容 | `src/services/api/openaiShim.ts` | `OPENAI_API_BASE=https://moma.cmecloud.cn/v1` + `CLAUDE_CODE_USE_OPENAI=true` |

### 缓存机制差异

| 特性 | Claude 原生 | DeepSeek / vLLM |
|------|------------|-----------------|
| 缓存控制 | 显式 `cache_control` marker | 自动 prefix caching |
| 触发条件 | 开发者标记 | KV cache block 精确匹配 |
| 可缓存范围 | 指定 blocks | 连续前缀（含 system + 历史） |
| 缓存粒度 | block 级别 | block 级别（~16 tokens） |
| 账单计价 | 有 cached tokens 折扣 | 取决于供应商实现 |

### 当前瓶颈

每轮请求中工具列表由 `toolRanker.ts` 按 BM25 相关性重新排序。工具顺序变化导致前缀不连续，造成 ~13K tokens 的 KV cache 完全无法命中。

```
当前模式（每轮）：
  轮 1: [system(6K) | 工具列表A(13K) | 历史 | 查询]  → 冷启动
  轮 2: [system(6K) | 工具列表B(13K) | 历史 | 查询]  → 13K 全 miss
  轮 3: [system(6K) | 工具列表C(13K) | 历史 | 查询]  → 13K 全 miss
```

## 设计

### 总体架构

```
优化管线（仅 Prefix Caching Provider 启用）:

  请求入站
     │
     ├── Provider 检测 ──→ getCacheStrategy()
     │     ├── 'explicit' → 保持现有 Claude 原生 cache_control 逻辑
     │     └── 'prefix'   → 进入优化管线
     │
     ├── [prefix] 工具排序冻结 ──→ toolRanker.ts
     │     ├── session 首次：BM25 排序一次
     │     └── session 后续：返回冻结顺序，跳过重排
     │
     ├── [prefix] 参数注入 ──→ openaiShim.ts / claude.ts
     │     ├── contextLimit: 1_000_000 (DeepSeek V4)
     │     └── extra_body: { enable_prefix_caching: true }
     │
     └── 发送请求 → 后端 prefix cache 命中的概率大幅提高
```

### 模块设计

#### M1: Provider 策略检测

**文件：** `src/utils/model/providers.ts`

新增两个导出函数：

```typescript
export type CacheStrategy = 'explicit' | 'prefix'

/** DeepSeek 及相关 prefix caching 代理的 hostname 列表 */
const PREFIX_CACHE_HOSTS = [
  'api.deepseek.com',       // DeepSeek Anthropic API
  'moma.cmecloud.cn',        // minimax 代理
]

export function getCacheStrategy(): CacheStrategy {
  // OpenAI 兼容模式
  const openaiBase = process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL
  if (openaiBase) {
    try {
      const host = new URL(openaiBase).host
      if (PREFIX_CACHE_HOSTS.some(h => host === h || host.endsWith('.' + h)))
        return 'prefix'
    } catch {}
    return 'explicit'
  }

  // Anthropic API 模式
  if (process.env.ANTHROPIC_BASE_URL) {
    try {
      const host = new URL(process.env.ANTHROPIC_BASE_URL).host
      if (PREFIX_CACHE_HOSTS.some(h => host === h || host.endsWith('.' + h)))
        return 'prefix'
    } catch {}
  }

  return 'explicit'
}
```

#### M2: 工具列表会话级冻结

**文件：** `src/services/api/toolRanker.ts`

需要新增 import：`import { getSessionId } from '../../bootstrap/state.js'`

新增 `getToolsForPrefixCache()` 函数，实现 session 级单次排序 + 冻结：

```typescript
// Session 级缓存
const sessionToolOrder = new Map<string, Tool[]>()

function getSessionKey(): string {
  return process.env.OLA_CC_SESSION_ID || getSessionId()
}

function getToolsForPrefixCache(tools: Tool[]): Tool[] {
  const key = getSessionKey()
  if (sessionToolOrder.has(key)) {
    return sessionToolOrder.get(key)!
  }
  // 首次：BM25 排序一次（用空查询作为基准，将核心工具排在前面）
  const sorted = rankTools(tools, '')
  sessionToolOrder.set(key, sorted)
  return sorted
}
```

在导出函数 `rankTools()` 入口处添加判断分支：

```typescript
export function rankTools(tools: Tool[], query: string): Tool[] {
  if (getCacheStrategy() === 'prefix') {
    return getToolsForPrefixCache(tools)
  }
  // 原有的 BM25 每轮排序逻辑
  // ...
}
```

**关键规则：**
- 仅在 `getCacheStrategy() === 'prefix'` 时激活
- 冻结以 session 为粒度（session ID 变化时重新排序）
- 核心工具（Read/Edit/Write/Bash/Glob/Grep）通过 `ALWAYS_INCLUDE_TOOLS` 机制确保排在前面
- 不影响既有 `explicit` 模式的每轮排序行为

#### M3: DeepSeek 特化参数注入

**文件：** `src/services/api/openaiShim.ts`

在 `createOpenAICompatibleShimClient()` 的 `doCreate()` 中添加 DeepSeek 检测：

```typescript
// 在 parseExtraBodyEnv() 下方添加
function isDeepSeekProvider(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).host
    return host === 'api.deepseek.com' || host.endsWith('.api.deepseek.com')
  } catch {
    return false
  }
}
```

在 context limit 计算和 extra_body 注入点修改：

```typescript
// contextLimit 计算
const rawLimit = process.env.OPENAI_CONTEXT_LIMIT
const isDeepSeek = isDeepSeekProvider(baseURL)
const contextLimit = isDeepSeek
  ? 1_000_000  // DeepSeek V4 Flash/Pro 实际窗口
  : !rawLimit || isNaN(parsedLimit) || parsedLimit < 1000
    ? 128_000
    : parsedLimit

// extra_body 注入
if (isDeepSeek) {
  paramsToSend.extra_body = {
    ...paramsToSend.extra_body,
    enable_prefix_caching: true,
  }
}
```

### 效果估算

假设典型开发 session：10 轮交互，工具列表 ~13K tokens

| 指标 | 当前（每轮重排） | 优化后（会话级冻结） | 改善 |
|------|----------------|-------------------|------|
| 每轮 cache miss | 13K tokens（工具列表全量） | 0 tokens（前缀命中） | **100%** |
| 10 轮累计额外 KV 计算 | ~130K tokens | ~0 tokens | **~10x** |
| TTFT (第 2-10 轮) | 全量计算 | 前缀命中 → 增量计算 | **-50%~70%** |
| 改动量 | — | ~40 行 | — |

### 风险与限制

| 风险 | 影响 | 应对 |
|------|------|------|
| 冻结后工具顺序不针对当前查询优化 | 低。核心工具始终排前，DeepSeek 的语义理解不受工具顺序影响 | 仅对 `prefix` 策略启用，不满意可回退 |
| 代理不报告 cached tokens | 中。TTFT 降低仍可验证缓存效果 | 添加 `OLA_CC_LOG_CACHE_STATS` 日志标志 |
| PREFIX_CACHE_HOSTS 列表维护 | 低。新增代理时追加即可 | 支持 `OLA_CC_PREFIX_CACHE_HOSTS` 环境变量扩展 |

### 测试策略

| 测试类型 | 内容 | 覆盖模块 |
|---------|------|---------|
| 单元测试 | `getCacheStrategy()` 多种 URL 输入 | providers.ts |
| 单元测试 | 冻结工具顺序在 session 内不变 | toolRanker.ts |
| 集成测试 | prefix 模式与 explicit 模式互不影响 | toolRanker.ts |
| 手工验证 | 监控 TTFT 实际变化，比较冻结前后 | 运行时 |

### 实施路线

| 步骤 | 改动 | 优先级 |
|------|------|--------|
| 1 | `providers.ts`: 新增 `getCacheStrategy()` | P0 |
| 2 | `toolRanker.ts`: 会话级冻结逻辑 | P0 |
| 3 | `openaiShim.ts`: DeepSeek 参数注入 | P1 |
| 4 | 验证 + 可观测性日志 | P1 |

### 回退方案

通过环境变量 `OLA_CC_DISABLE_PREFIX_CACHE_OPT=1` 一键禁用所有优化，恢复原始行为。无需代码回滚。