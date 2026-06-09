# UX Enhancements Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: oh-my-claudecode + claude-code
**Priority**: P1/P2
**Effort**: XL (8 subsystems, ~4800 LOC estimated)

---

## Effort Breakdown

| Module | Priority | LOC Estimate | Difficulty | Notes |
|--------|----------|-------------|------------|-------|
| 1. HUD Status Bar | P1 | ~800 | M | 20+ element renderer, width truncation logic |
| 2. Multi-Platform Notifications | P1 | ~900 | M | 5 platform adapters + template engine |
| 3. Wiki Knowledge Layer | P1 | ~700 | M | 7 MCP tools + markdown parser + index |
| 4. Shared Memory KV | P2 | ~350 | S | Simple KV + TTL + namespace isolation |
| 5. Python REPL Sandbox | P2 | ~600 | M | JSON-RPC + process lifecycle + safety |
| 6. Agent Trace Visualization | P2 | ~400 | S | 2 tools + timeline renderer |
| 7. Provider Profile System | P2 | ~550 | M | Auto-detect + fallback chain + 15 presets |
| 8. Token Analytics | P3 | ~500 | S | Ring buffer + stats aggregation + UI |
| **Conflict analysis & integration** | — | ~300 | — | Cross-cutting integration work |
| **Total** | — | **~5100** | — | — |

---

## 0. Core TypeScript Interfaces

所有核心子系统的配置和数据结构定义。

```typescript
// src/hud/types.ts — HUD Status Bar 配置
interface StatusLineConfig {
  preset: 'minimal' | 'focused' | 'full' | 'opencode' | 'dense';
  elements: StatusLineElement[];
  locale: 'zh' | 'en';
  maxWidth: number;                 // 终端最大宽度（自动检测）
  refreshIntervalMs: number;        // 刷新间隔，默认 1000ms
  truncationStrategy: 'ellipsis' | 'wrap' | 'hide';
}

type StatusLineElement =
  | 'context-window'        // 上下文窗口用量 + 进度条
  | 'rate-limit-5h'         // 5 小时速率限制
  | 'rate-limit-7d'         // 7 天速率限制
  | 'rate-limit-monthly'    // 月度速率限制
  | 'active-agent-count'    // 活跃 Agent 数
  | 'active-tool-count'     // 活跃 Tool 数
  | 'active-skill-count'    // 活跃 Skill 数
  | 'todo-count'            // Todo 项数
  | 'session-duration'      // 会话时长
  | 'session-health'        // 会话健康指示器
  | 'last-prompt-time'      // 最后提示时间
  | 'enterprise-billing'    // 企业计费
  | 'custom-rate-limit';    // 自定义速率限制

interface HudRenderContext {
  terminalWidth: number;
  elements: Map<StatusLineElement, string>; // 预渲染的元素内容
  locale: 'zh' | 'en';
}

// src/services/notifications/types.ts — 通知配置
interface NotificationConfig {
  platforms: NotificationPlatform[];
  verbosity: 'minimal' | 'normal' | 'verbose' | 'debug';
  replyInjection: boolean;          // 允许从 Discord/Slack 回复注入
  templateEngine: boolean;          // 启用模板引擎
  tmuxCapture: boolean;             // Tmux 窗格内容捕获
}

interface NotificationPlatform {
  type: 'discord' | 'telegram' | 'slack' | 'webhook' | 'cli';
  enabled: boolean;
  config: DiscordConfig | TelegramConfig | SlackConfig | WebhookConfig | CliConfig;
}

interface DiscordConfig {
  webhookUrl?: string;
  botToken?: string;
  channelId: string;
}

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

interface SlackConfig {
  webhookUrl?: string;
  botToken?: string;
  channel: string;
}

interface WebhookConfig {
  url: string;
  method: 'POST' | 'PUT';
  headers?: Record<string, string>;
}

interface CliConfig {
  command: string;                  // 自定义命令模板
  args?: string[];
}

type NotificationEvent =
  | 'session-start'
  | 'session-stop'
  | 'session-end'
  | 'session-idle'
  | 'ask-user-question'
  | 'agent-call';

// src/tools/WikiTools/types.ts — Wiki 知识层
interface WikiPage {
  path: string;                     // .wiki/ 下的相对路径
  category: WikiCategory;
  title: string;
  content: string;
  confidence: 'high' | 'medium' | 'low';
  lastModified: number;             // Unix timestamp
  tags: string[];
}

type WikiCategory =
  | 'architecture'
  | 'decision'
  | 'pattern'
  | 'debugging'
  | 'environment'
  | 'session-log'
  | 'reference'
  | 'convention';

interface WikiIndex {
  pages: Map<string, WikiPage>;
  tagIndex: Map<string, string[]>;  // tag → page paths
  categoryIndex: Map<WikiCategory, string[]>;
  lastRebuilt: number;
}

// src/utils/tokenAnalytics/types.ts — Token 分析
interface TokenUsageEntry {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestId: string;
}

interface TokenAnalyticsStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheHitRate: number;             // 0-1
  mostUsedModel: string;
  hourlyRequests: Map<string, number>;  // "HH:00" → count
  dailyRequests: Map<string, number>;   // "YYYY-MM-DD" → count
  avgTokensPerRequest: number;
}

// src/tools/SharedMemoryTools/types.ts — 共享内存 KV
interface SharedMemoryEntry {
  key: string;
  namespace: string;
  value: string;                    // JSON serialized
  createdAt: number;
  expiresAt: number;                // TTL expiry, max 7 days
  workspaceDir: string;             // 工作目录校验
}

// src/tools/PythonReplTool/types.ts — Python REPL
interface PythonReplState {
  pid: number | null;
  socketPath: string;
  sessionLocked: boolean;
  memoryUsageMB: number;
  lastActivity: number;
  venvPath: string | null;          // .venv 自动检测
}

// src/tools/TraceTools/types.ts — Trace 可视化
interface TraceEvent {
  id: string;
  type: 'AGENT' | 'TOOL' | 'FILE' | 'INTERVENE' | 'ERROR' | 'HOOK' | 'KEYWORD' | 'SKILL' | 'MODE';
  timestamp: number;
  duration?: number;                // ms
  label: string;
  metadata?: Record<string, unknown>;
  parentId?: string;                // 嵌套关系
}

// src/utils/providerProfileTypes.ts — Provider Profile
interface ProviderProfile {
  name: string;
  provider: string;                 // 'openai' | 'anthropic' | 'gemini' | ...
  baseUrl: string;
  apiKey?: string;
  oauthToken?: string;
  customHeaders?: Record<string, string>;
  apiFormat: 'openai' | 'anthropic' | 'gemini';
  models: string[];                 // 支持的模型列表
  autoDetect: boolean;              // 是否自动检测
}
```

---

## 1. HUD Status Bar (P1, from oh-my-claudecode)

**Source**: `/Users/heal/oh-my-claudecode/src/hud/` (20+ files)

### Features

- 5 presets: minimal / focused / full / opencode / dense
- 20+ configurable elements:
  - Context window usage + progress bar
  - Rate limits (5h/7d/monthly/enterprise)
  - Active Agent/Tool/Skill call counts
  - Todo list tracking
  - Session health (duration + indicator)
  - Last prompt time
  - Enterprise billing display
  - Custom rate limit provider
  - Chinese/English locale support
  - Smart width truncation/line wrapping

### Architecture

```
statusline stdin -> HUD parser -> element renderer -> terminal output
```

### Code Skeleton

```typescript
// src/hud/parser.ts — Statusline stdin 解析器
export function parseStatuslineInput(input: string, config: StatusLineConfig): HudRenderContext {
  const terminalWidth = config.maxWidth || process.stdout.columns || 80;
  const elements = new Map<StatusLineElement, string>();

  for (const element of config.elements) {
    const rendered = renderElement(element, input, config.locale);
    if (rendered) elements.set(element, rendered);
  }

  return { terminalWidth, elements, locale: config.locale };
}

// src/hud/elements/ — 单个元素渲染器（示例：context-window）
export function renderContextWindow(data: ContextWindowData): string {
  const percent = Math.round((data.used / data.total) * 100);
  const barWidth = 20;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  return `${bar} ${percent}% (${formatTokens(data.used)}/${formatTokens(data.total)})`;
}

// src/hud/truncation.ts — 宽度截断
export function truncateToWidth(text: string, maxWidth: number, strategy: 'ellipsis' | 'wrap' | 'hide'): string {
  if (text.length <= maxWidth) return text;
  switch (strategy) {
    case 'ellipsis': return text.slice(0, maxWidth - 3) + '...';
    case 'wrap': return text.slice(0, maxWidth) + '\n' + truncateToWidth(text.slice(maxWidth), maxWidth, strategy);
    case 'hide': return '';
  }
}

// src/hooks/useHudData.ts — React hook
export function useHudData(config: StatusLineConfig): HudRenderContext {
  const [context, setContext] = useState<HudRenderContext>(() =>
    parseStatuslineInput('', config)
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const data = collectHudData(); // 从 AppState 读取
      setContext(parseStatuslineInput(JSON.stringify(data), config));
    }, config.refreshIntervalMs);
    return () => clearInterval(interval);
  }, [config]);

  return context;
}
```

### LOC Estimate

| File/Module | LOC | Purpose |
|-------------|-----|---------|
| `src/hud/parser.ts` | ~120 | Statusline stdin parser |
| `src/hud/elements/` (20+ files) | ~400 | Individual element renderers |
| `src/hud/presets.ts` | ~80 | 5 preset definitions |
| `src/hud/truncation.ts` | ~100 | Width truncation + line wrap |
| `src/hud/locale.ts` | ~50 | i18n strings (zh/en) |
| `src/hooks/useHudData.ts` | ~50 | React hook for HUD data |
| **Subtotal** | **~800** | — |

### Integration

| File | Operation | Specific Changes |
|------|-----------|-----------------|
| `src/hud/` directory | **New** — 20+ files | Entire HUD subsystem |
| `src/components/Stats.tsx` | Modify | Add HUD element toggle in Stats panel header; render HUD preview in a new "HUD" tab alongside existing `7d`/`30d`/`all` tabs; import `useHudData` hook for live preview |
| `src/hooks/` | Modify | Add `useHudData.ts` hook that reads context window usage, rate limits, and active tool counts from `AppState` store |

---

## 2. Multi-Platform Notifications (P1, from oh-my-claudecode)

**Source**: `/Users/heal/oh-my-claudecode/src/notifications/` (17 files)

### Supported Platforms

| Platform | Type |
|----------|------|
| Discord | Webhook + Bot |
| Telegram | Bot API |
| Slack | Webhook + Bot |
| Webhook | Generic HTTP |
| CLI | Custom command |

### Event Types

| Event | Description |
|-------|-------------|
| session-start | Agent session started |
| session-stop | Agent session stopped |
| session-end | Agent session completed |
| session-idle | Agent waiting for input |
| ask-user-question | Agent needs user confirmation |
| agent-call | Sub-agent invoked |

### Features

- 4-level verbosity filtering
- Reply injection (Discord/Slack reply -> agent input)
- Template engine + variable interpolation
- Tmux pane content capture
- Notification profile system

### Code Skeleton

```typescript
// src/services/notifications/dispatcher.ts — 中央调度器
export class NotificationDispatcher {
  private adapters: Map<string, NotificationAdapter> = new Map();
  private config: NotificationConfig;

  constructor(config: NotificationConfig) {
    this.config = config;
    for (const platform of config.platforms) {
      if (platform.enabled) {
        this.adapters.set(platform.type, createAdapter(platform));
      }
    }
  }

  async dispatch(event: NotificationEvent, data: Record<string, unknown>): Promise<void> {
    // 1. 按 verbosity 过滤
    if (!this.shouldDispatch(event)) return;

    // 2. 模板渲染
    const message = this.config.templateEngine
      ? renderTemplate(event, data)
      : `${event}: ${JSON.stringify(data)}`;

    // 3. 并行发送到所有启用的平台
    const results = await Promise.allSettled(
      [...this.adapters.entries()].map(([type, adapter]) =>
        adapter.send(message).catch(err => {
          logError(`Notification ${type} failed: ${err}`);
          return null;
        })
      )
    );

    // 4. 记录发送结果
    logEvent('notification_dispatched', { event, platforms: results.length });
  }

  private shouldDispatch(event: NotificationEvent): boolean {
    const level = this.config.verbosity;
    if (level === 'minimal') return ['session-start', 'session-end', 'ask-user-question'].includes(event);
    if (level === 'normal') return !['session-idle'].includes(event);
    return true; // verbose/debug: all events
  }
}

// src/services/notifications/replyInjection.ts — 回复注入
export class ReplyInjectionBridge {
  private pendingReplies: Map<string, (reply: string) => void> = new Map();

  async waitForReply(platform: string, messageId: string, timeoutMs: number = 300_000): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(messageId);
        resolve(null);
      }, timeoutMs);

      this.pendingReplies.set(messageId, (reply: string) => {
        clearTimeout(timer);
        this.pendingReplies.delete(messageId);
        resolve(reply);
      });
    });
  }

  // 由平台 adapter 调用
  onReply(messageId: string, reply: string): void {
    this.pendingReplies.get(messageId)?.(reply);
  }
}
```

### LOC Estimate

| File/Module | LOC | Purpose |
|-------------|-----|---------|
| `src/services/notifications/dispatcher.ts` | ~150 | Central dispatch with verbosity filtering |
| `src/services/notifications/platforms/discord.ts` | ~120 | Discord webhook + bot adapter |
| `src/services/notifications/platforms/telegram.ts` | ~100 | Telegram bot adapter |
| `src/services/notifications/platforms/slack.ts` | ~120 | Slack webhook + bot adapter |
| `src/services/notifications/platforms/webhook.ts` | ~80 | Generic HTTP webhook |
| `src/services/notifications/platforms/cli.ts` | ~60 | Custom command adapter |
| `src/services/notifications/templateEngine.ts` | ~100 | Template + variable interpolation |
| `src/services/notifications/profiles.ts` | ~70 | Notification profile management |
| `src/services/notifications/replyInjection.ts` | ~100 | Reply -> agent input bridge |
| **Subtotal** | **~900** | — |

### Integration

| File | Operation | Specific Changes |
|------|-----------|-----------------|
| `src/services/notifications/` directory | **New** — 10+ files | Entire notification platform subsystem |
| `src/services/notifier.ts` | Modify | Add `sendRemoteNotification()` function that delegates to the new dispatcher when `notificationPlatforms` config is present; existing `sendNotification()` (terminal-only) remains unchanged for backward compat; new function called from `sendNotification()` as additional channel after existing terminal notification |
| `src/hooks/notifs/` | Modify | Add `useRemoteNotificationConfig.ts` hook for UI config; add `useNotificationReply.ts` hook for reply injection from Discord/Slack back into agent input |

---

## 3. Wiki Knowledge Layer (P1, from oh-my-claudecode)

**Source**: `/Users/heal/oh-my-claudecode/src/tools/wiki-tools.ts` + `src/hooks/wiki/`

### 7 MCP Tools

| Tool | Function |
|------|----------|
| `wiki_ingest` | Smart knowledge ingestion (auto-merge, no overwrite) |
| `wiki_query` | Keyword search (no vector embedding dependency) |
| `wiki_lint` | Health check (orphan pages, stale content, contradiction detection) |
| `wiki_add` | Add new page |
| `wiki_list` | List all pages |
| `wiki_read` | Read page content |
| `wiki_delete` | Delete page |

### 8 Categories

architecture / decision / pattern / debugging / environment / session-log / reference / convention

### Features

- Confidence markers (high/medium/low)
- Auto-index maintenance
- Pure filesystem + markdown parsing, no external deps

### Code Skeleton

```typescript
// src/tools/WikiTools/WikiIngestTool.ts — 智能知识摄取
export async function wikiIngest(
  input: { content: string; category: WikiCategory; title: string; tags?: string[] },
  context: ToolUseContext,
): Promise<WikiPage> {
  const wikiDir = path.join(context.cwd, '.wiki');
  const existingIndex = await loadWikiIndex(wikiDir);

  // 1. 检查是否已存在同名页面
  const existingPage = existingIndex.pages.get(input.title);
  if (existingPage) {
    // 合并而非覆盖：保留旧内容中未被新内容覆盖的段落
    const merged = mergeWikiContent(existingPage.content, input.content);
    return await writeWikiPage(wikiDir, { ...existingPage, content: merged, lastModified: Date.now() });
  }

  // 2. 自动检测 confidence
  const confidence = detectConfidence(input.content);

  // 3. 写入文件 + 更新索引
  const page: WikiPage = {
    path: `${input.category}/${slugify(input.title)}.md`,
    category: input.category,
    title: input.title,
    content: input.content,
    confidence,
    lastModified: Date.now(),
    tags: input.tags ?? [],
  };

  await writeWikiPage(wikiDir, page);
  await updateWikiIndex(wikiDir, page);
  return page;
}

// src/tools/WikiTools/WikiQueryTool.ts — 关键词搜索（无向量依赖）
export async function wikiQuery(
  input: { query: string; category?: WikiCategory; limit?: number },
  context: ToolUseContext,
): Promise<WikiPage[]> {
  const index = await loadWikiIndex(path.join(context.cwd, '.wiki'));
  const tokens = tokenize(input.query.toLowerCase());

  const scored = [...index.pages.values()]
    .filter(p => !input.category || p.category === input.category)
    .map(page => {
      const titleScore = tokens.filter(t => page.title.toLowerCase().includes(t)).length * 3;
      const contentScore = tokens.filter(t => page.content.toLowerCase().includes(t)).length;
      const tagScore = tokens.filter(t => page.tags.some(tag => tag.toLowerCase().includes(t))).length * 2;
      return { page, score: titleScore + contentScore + tagScore };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, input.limit ?? 10).map(r => r.page);
}

// src/tools/WikiTools/WikiLintTool.ts — 健康检查
export async function wikiLint(
  _input: Record<string, never>,
  context: ToolUseContext,
): Promise<{ orphans: string[]; stale: string[]; contradictions: string[] }> {
  const index = await loadWikiIndex(path.join(context.cwd, '.wiki'));
  const pages = [...index.pages.values()];

  // 孤儿页面：被引用但不存在，或存在但从未被引用
  const allRefs = new Set(pages.flatMap(p => extractPageRefs(p.content)));
  const orphans = pages.filter(p => !allRefs.has(p.path)).map(p => p.path);

  // 过期页面：超过 30 天未更新
  const stale = pages.filter(p => Date.now() - p.lastModified > 30 * 24 * 3600_000).map(p => p.path);

  // 矛盾检测：同一 topic 的不同页面结论冲突
  const contradictions = detectContradictions(pages);

  return { orphans, stale, contradictions };
}
```

### Complementarity with ASAEF

Wiki provides structured persistent knowledge layer for ola-cc's agent evolution system. Skills can consume wiki pages as knowledge backend.

### LOC Estimate

| File/Module | LOC | Purpose |
|-------------|-----|---------|
| `src/tools/WikiTools/WikiIngestTool.ts` | ~150 | Ingest with auto-merge logic |
| `src/tools/WikiTools/WikiQueryTool.ts` | ~100 | Keyword search + ranking |
| `src/tools/WikiTools/WikiLintTool.ts` | ~120 | Orphan/stale/contradiction detection |
| `src/tools/WikiTools/WikiCrudTools.ts` | ~100 | add/list/read/delete |
| `src/tools/WikiTools/wikiIndex.ts` | ~80 | Auto-index maintenance |
| `src/tools/WikiTools/wikiParser.ts` | ~80 | Markdown parsing + confidence markers |
| `src/hooks/wiki/useWikiSearch.ts` | ~40 | React hook for wiki search |
| `src/hooks/wiki/useWikiIngest.ts` | ~30 | React hook for ingest status |
| **Subtotal** | **~700** | — |

### Integration

| File | Operation | Specific Changes |
|------|-----------|-----------------|
| `src/tools/WikiTools/` directory | **New** — 5+ files | 7 MCP tool implementations |
| `src/hooks/wiki/` | **New** — Wiki hooks | React hooks for wiki operations |
| `src/services/singularity/` | Modify | Add `wikiKnowledgeAdapter.ts` in `src/services/singularity/hooks/` that reads wiki pages as structured knowledge; `EvolutionEngine.ts` P3 (reflect) phase can query wiki for historical decisions; `ReflectEngine.ts` references wiki patterns during reflection |

---

## 4. Shared Memory KV (P2, from oh-my-claudecode)

**Source**: `/Users/heal/oh-my-claudecode/src/tools/shared-memory-tools.ts`

### Features

- 5 tools: write / read / list / delete / cleanup
- Namespace isolation
- TTL auto-expiry (max 7 days)
- JSON serialized values
- Working directory validation

### LOC Estimate

| File/Module | LOC | Purpose |
|-------------|-----|---------|
| `src/tools/SharedMemoryTools/SharedMemoryWriteTool.ts` | ~80 | Write with TTL + namespace |
| `src/tools/SharedMemoryTools/SharedMemoryReadTool.ts` | ~60 | Read with namespace filter |
| `src/tools/SharedMemoryTools/SharedMemoryListTool.ts` | ~50 | List with namespace filter |
| `src/tools/SharedMemoryTools/SharedMemoryDeleteTool.ts` | ~50 | Delete + cleanup |
| `src/tools/SharedMemoryTools/sharedMemoryStore.ts` | ~80 | In-memory store + TTL expiry + JSONL persistence |
| `src/tools/SharedMemoryTools/index.ts` | ~30 | Exports |
| **Subtotal** | **~350** | — |

### Integration

| File | Operation | Specific Changes |
|------|-----------|-----------------|
| `src/tools/SharedMemoryTools/` | **New** — 3 files | 5 tool implementations + shared store |
| `src/coordinator/` | Modify | `coordinatorMode.ts` reads shared memory for cross-agent state sharing; add `sharedMemoryBridge.ts` that exposes KV read/write to coordinator agents; `workerAgent.ts` receives shared memory context in `ToolUseContext` |

---

## 5. Python REPL Sandbox (P2, from oh-my-claudecode)

**Source**: `/Users/heal/oh-my-claudecode/src/tools/python-repl/`

### Features

- JSON-RPC 2.0 over Unix socket
- 4 actions: execute / interrupt / reset / get_state
- Session lock for concurrency safety
- Timeout escalation: SIGINT -> SIGTERM -> SIGKILL
- Memory monitoring
- Bridge process auto-restart
- .venv auto-detection

### LOC Estimate

| File/Module | LOC | Purpose |
|-------------|-----|---------|
| `src/tools/PythonReplTool/PythonReplTool.ts` | ~200 | Tool interface + action dispatch |
| `src/tools/PythonReplTool/bridge.ts` | ~150 | Unix socket JSON-RPC client |
| `src/tools/PythonReplTool/processManager.ts` | ~120 | Process lifecycle + timeout escalation |
| `src/tools/PythonReplTool/sessionLock.ts` | ~50 | Concurrency lock |
| `src/tools/PythonReplTool/venvDetector.ts` | ~50 | .venv auto-detection |
| `src/tools/PythonReplTool/memoryMonitor.ts` | ~30 | Memory usage monitoring |
| **Subtotal** | **~600** | — |

### Integration

| File | Operation | Specific Changes |
|------|-----------|-----------------|
| `src/tools/PythonReplTool/` | **New** — 5+ files | Python REPL sandbox implementation |
| `src/tools.ts` | Modify | Add `PythonReplTool` to `getAllBaseTools()` array; use same `try/catch` lazy-require pattern as `REPLTool` (lines 55-58) to avoid blocking init if Python is unavailable |

---

## 6. Agent Trace Visualization (P2, from oh-my-claudecode)

**Source**: `/Users/heal/oh-my-claudecode/src/tools/trace-tools.ts`

### Tools

| Tool | Function |
|------|----------|
| `trace_timeline` | Timeline view of events |
| `trace_summary` | Summary statistics |

### Event Types

AGENT / TOOL / FILE / INTERVENE / ERROR / HOOK / KEYWORD / SKILL / MODE

### LOC Estimate

| File/Module | LOC | Purpose |
|-------------|-----|---------|
| `src/tools/TraceTools/TraceTimelineTool.ts` | ~150 | Timeline renderer with event grouping |
| `src/tools/TraceTools/TraceSummaryTool.ts` | ~100 | Stats aggregation |
| `src/tools/TraceTools/traceEventStore.ts` | ~100 | In-memory event ring buffer |
| `src/tools/TraceTools/traceRenderer.ts` | ~50 | ASCII timeline renderer |
| **Subtotal** | **~400** | — |

### Integration

| File | Operation | Specific Changes |
|------|-----------|-----------------|
| `src/tools/TraceTools/` | **New** — 2 files | 2 trace tools + store + renderer |
| `src/services/analytics/` | Modify | `index.ts` adds `traceEvent()` export that writes to `traceEventStore` ring buffer alongside existing `logEvent()`; `sink.ts` optionally forwards trace events to trace store; existing `logEvent()` callers remain unchanged |

---

## 7. Provider Profile System (P2, from openclaude)

**Source**: `/Users/heal/openclaude/src/utils/providerProfiles.ts`

### Features

- Per-provider profile files
- Auto-detection (providerAutoDetect)
- Fallback chain (providerFallback)
- 15+ presets: OpenAI/Gemini/Mistral/GitHub Copilot/Bedrock/Vertex/etc.
- API format selection
- Custom headers
- OAuth + API Key dual mode

### LOC Estimate

| File/Module | LOC | Purpose |
|-------------|-----|---------|
| `src/utils/providerProfiles.ts` | ~200 | Profile definitions + 15 presets |
| `src/utils/providerAutoDetect.ts` | ~150 | Auto-detection from env/config |
| `src/utils/providerFallback.ts` | ~100 | Fallback chain logic |
| `src/utils/providerProfileTypes.ts` | ~50 | TypeScript interfaces |
| `src/commands/auth/profiles.ts` | ~50 | Auth command integration |
| **Subtotal** | **~550** | — |

### Integration

| File | Operation | Specific Changes |
|------|-----------|-----------------|
| `src/utils/providerProfiles.ts` | **New** | Profile definitions + 15 presets |
| `src/utils/providerAutoDetect.ts` | **New** | Auto-detection logic |
| `src/utils/providerFallback.ts` | **New** | Fallback chain |
| `src/commands/auth/` | Modify | `auth.tsx` adds `/auth profile list`, `/auth profile set <name>`, `/auth profile auto-detect` subcommands; `index.ts` registers new subcommands in the auth command tree |

---

## 8. Token Analytics (P3, from openclaude)

**Source**: `/Users/heal/openclaude/src/utils/tokenAnalytics.ts`

### Features

- TokenUsageTracker: Ring buffer (1000 entries)
- Stats: Total requests/tokens, cache hit rate, most used model
- Hourly/daily request counts
- Per-request average tokens

### LOC Estimate

| File/Module | LOC | Purpose |
|-------------|-----|---------|
| `src/utils/tokenAnalytics.ts` | ~200 | Ring buffer + stats aggregation |
| `src/utils/tokenAnalyticsTypes.ts` | ~50 | TypeScript interfaces |
| `src/utils/tokenAnalyticsExport.ts` | ~80 | CSV/JSON export |
| `src/components/TokenAnalyticsPanel.tsx` | ~120 | Terminal UI for trends display |
| `src/hooks/useTokenAnalytics.ts` | ~50 | React hook for analytics data |
| **Subtotal** | **~500** | — |

### Integration

| File | Operation | Specific Changes |
|------|-----------|-----------------|
| `src/utils/tokenAnalytics.ts` | **New** | Ring buffer + stats core |
| `src/components/Stats.tsx` | Modify | Add "Analytics" tab alongside existing `7d`/`30d`/`all` tabs; render `TokenAnalyticsPanel` with historical token usage trends; import `useTokenAnalytics` hook; add `formatTokenTrend()` helper next to existing `formatPeakDay()` |

---

## Conflict Analysis

### Stats.tsx Conflicts

`src/components/Stats.tsx` is a large component (~900+ lines) with its own tab system (`Tab`/`Tabs` from `design-system/Tabs`). Two modules modify it:

| Module | Change | Risk | Mitigation |
|--------|--------|------|------------|
| HUD Status Bar (Module 1) | Add "HUD" tab + preview | M — touches tab registration and adds new import | Use existing `Tab` component pattern; add tab after `all` range tab; isolate HUD preview in separate component to minimize Stats.tsx diff |
| Token Analytics (Module 8) | Add "Analytics" tab + trends | M — same tab area | Merge both new tabs in single PR to avoid merge conflicts; use consistent tab component pattern |

**Specific conflict points in Stats.tsx:**
- `DATE_RANGE_ORDER` array (line 53): Both modules add tabs, but HUD/Analytics tabs are independent of date ranges
- `getNextDateRange()` function (line 54): Only used by date-range tabs, not affected by new tabs
- Tab rendering block: Both modules add `Tab` children — must coordinate ordering
- Import section (lines 1-26): Both add new imports — no conflict if added in alphabetical order

**Recommended approach:** Add both tabs in a single coordinated change to `Stats.tsx`. Keep new tab content in separate components (`HUDPreviewPanel.tsx`, `TokenAnalyticsPanel.tsx`) imported by Stats.

### notifier.ts Conflicts

`src/services/notifier.ts` is a small file (~157 lines) with a single `sendNotification()` entry point. Module 2 (Notifications) modifies it:

| Module | Change | Risk | Mitigation |
|--------|--------|------|------------|
| Multi-Platform Notifications (Module 2) | Add `sendRemoteNotification()` + call from `sendNotification()` | L — additive change, no existing logic modified | New function is called as additional dispatch after existing terminal notification; existing `sendToChannel()` switch-case is untouched |

**Specific conflict points in notifier.ts:**
- `sendNotification()` (line 18): Add call to `sendRemoteNotification()` after existing `sendToChannel()` — purely additive, no logic change
- `sendToChannel()` (line 40): Not modified — existing terminal notification channels remain
- Type `NotificationOptions` (line 12): May need extension for remote platforms (add `platform?: string` optional field) — backward compatible

**No breaking changes:** The existing notification flow (terminal-only) is preserved. Remote notifications are an opt-in addition gated by config.

### singularity/ Conflicts

`src/services/singularity/` has 15+ files including `EvolutionEngine.ts` (800+ lines). Module 3 (Wiki) modifies it:

| Module | Change | Risk | Mitigation |
|--------|--------|------|------------|
| Wiki Knowledge Layer (Module 3) | Add wiki adapter in `hooks/` | L — new file, no existing files modified | Create `src/services/singularity/hooks/wikiKnowledgeAdapter.ts` as new file; `EvolutionEngine.ts` P3 phase reads from adapter via existing hook pattern |

### analytics/ Conflicts

`src/services/analytics/` has 8 files. Module 6 (Trace) modifies it:

| Module | Change | Risk | Mitigation |
|--------|--------|------|------------|
| Agent Trace Visualization (Module 6) | Add `traceEvent()` to `index.ts` | L — additive export | New function wraps existing `logEvent()` pattern; `sink.ts` gets optional trace forwarding — existing sinks unchanged |

---

## Backward Compatibility

### Feature Flags

All modules are gated by compile-time feature flags using `feature()` from `bun:bundle`. This ensures zero runtime cost for disabled modules and clean opt-in for users.

| Module | Feature Flag | Default | Env Override |
|--------|-------------|---------|--------------|
| 1. HUD Status Bar | `HUD_STATUS_BAR` | OFF | `OLA_CC_ENABLE_HUD=1` |
| 2. Multi-Platform Notifications | `REMOTE_NOTIFICATIONS` | OFF | `OLA_CC_ENABLE_REMOTE_NOTIF=1` |
| 3. Wiki Knowledge Layer | `WIKI_KNOWLEDGE` | ON | `OLA_CC_DISABLE_WIKI=1` |
| 4. Shared Memory KV | `SHARED_MEMORY` | ON | `OLA_CC_DISABLE_SHARED_MEMORY=1` |
| 5. Python REPL Sandbox | `PYTHON_REPL` | OFF | `OLA_CC_ENABLE_PYTHON_REPL=1` |
| 6. Agent Trace Visualization | `AGENT_TRACE` | ON | `OLA_CC_DISABLE_TRACE=1` |
| 7. Provider Profile System | `PROVIDER_PROFILES` | ON | `OLA_CC_DISABLE_PROFILES=1` |
| 8. Token Analytics | `TOKEN_ANALYTICS` | ON | `OLA_CC_DISABLE_ANALYTICS=1` |

### Backward Compatibility Guarantees

| Module | Guarantee |
|--------|-----------|
| 1. HUD Status Bar | Disabled by default; when enabled, falls back to existing `Stats.tsx` display if HUD parser fails |
| 2. Multi-Platform Notifications | `sendNotification()` signature unchanged; remote dispatch is additive; existing terminal notification flow untouched |
| 3. Wiki Knowledge Layer | New MCP tools only; no changes to existing tool behavior; wiki pages stored in `.wiki/` directory |
| 4. Shared Memory KV | New tools only; coordinator changes are additive (shared memory bridge is optional) |
| 5. Python REPL Sandbox | Lazy-loaded with `try/catch` (same pattern as `REPLTool`); tool registration skipped if Python unavailable |
| 6. Agent Trace Visualization | `traceEvent()` is additive; existing `logEvent()` callers unchanged; trace store is separate ring buffer |
| 7. Provider Profile System | New files only; auth command additions are subcommands, existing `/auth add` flow unchanged |
| 8. Token Analytics | New tab in Stats.tsx; existing date-range tabs unchanged; ring buffer is independent of existing stats |

### Migration Path

1. **Phase 1 (P1):** Ship HUD + Notifications + Wiki with feature flags OFF (HUD, Notifications) or ON (Wiki)
2. **Phase 2 (P2):** Ship Shared Memory + Python REPL + Trace + Provider Profiles
3. **Phase 3 (P3):** Ship Token Analytics
4. Each phase can be independently enabled/disabled via feature flags
5. No breaking changes to existing APIs, tools, or commands in any phase
