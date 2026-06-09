# 生态与可扩展性系统设计

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: claude-code + oh-my-claudecode
**Priority**: P0/P1
**Effort**: L（~2300 LOC，含沙箱实现）

---

## 1. 概述

生态与可扩展性系统覆盖：Plugin Marketplace、Skill Store、Skill Search、Hooks Config Menu、Plugin Patterns Library、Mode Registry。

---

## 2. Plugin Marketplace (P0)

**Source**: `/Users/heal/claude-code/src/commands/plugin/` (16 files)

### 2.1 核心功能

完整的插件生态系统：发现、安装、管理、信任警告、设置对话框、marketplace 来源管理。

### 2.2 组件

| 组件 | 功能 |
|------|------|
| `BrowseMarketplace.tsx` | 浏览 marketplace 中的插件 |
| `DiscoverPlugins.tsx` | 发现推荐插件 |
| `ManagePlugins.tsx` | 已安装插件管理 |
| `PluginTrustWarning.tsx` | 信任警告对话框 |
| `PluginSettings.tsx` | 插件设置界面 |

### 2.3 安全设计

- 信任警告：首次安装时显示插件权限要求
- 来源管理：支持多个 marketplace 来源
- 沙箱隔离：插件运行在受限环境中

### 2.4 沙箱约束定义

**级别**: 权限级沙箱（非进程级）

| 约束 | 说明 |
|------|------|
| 文件访问 | 仅允许项目目录和 ~/.claude/ 目录 |
| 网络访问 | 默认禁止，需用户显式授权 |
| 命令执行 | 仅允许白名单命令（git, npm, bun 等） |
| 子进程 | 禁止 spawn 子进程（除非标记为 trusted） |
| 环境变量 | 禁止读取 SECRET/KEY/TOKEN 相关变量 |
| 内存限制 | 单插件最大 50MB 内存 |
| 执行超时 | 单次调用最大 30s |

**Sandbox 实现方案**: 采用 Proxy-based 权限隔离（非 VM）。每个插件运行在受限的 Proxy 对象中：
- 文件系统：通过 `fs` Proxy 限制为白名单路径（插件目录 + 工作区）
- 网络：默认禁止，需显式声明 `network: true` in manifest
- 子进程：默认禁止，需显式声明 `subprocess: true`
- 内存：V8 heap limit 通过 `--max-old-space-size=256` 控制
- 超时：每个插件调用 30s 超时，通过 `AbortController` 实现

**安全加固**:
- 原型链防护：使用 `Object.create(null)` 创建无原型的白名单对象，拦截 `__proto__`、`constructor`、`prototype` 的 get/set
- 属性访问白名单：Proxy handler 的 `get` trap 仅允许 manifest 中声明的 API 命名空间
- 深度冻结：所有注入到插件的 API 对象使用 `Object.freeze()` 递归冻结

**Proxy vs vm.Module vs Worker 决策矩阵**:

| 方案 | 安全性 | 性能 | 兼容性 | 适用场景 |
|------|--------|------|--------|---------|
| Proxy | 低（可绕过） | 极快 (<1ms) | 全平台 | 开发/测试 |
| vm.Module | 中 | 快 (~5ms) | V8 only | 可信插件 |
| Worker | 高 | 中 (~10ms) | 全平台 | 不可信插件（推荐） |

**决策依据**：
- **Proxy** 可通过 `Symbol`、`WeakRef`、`Proxy.revocable()` 等机制绕过，仅适合开发阶段快速原型验证
- **vm.Module** 提供 V8 级隔离但无法阻断 `process`、`require` 等 Node.js 全局对象访问，适用于已审计的可信插件
- **Worker 线程** 通过独立 V8 isolate 实现进程级隔离，无法访问主线程的任何对象，生产环境推荐方案
- 生产环境推荐 Worker 线程隔离。Proxy 仅作为开发阶段快速原型。升级路径：Proxy → vm.Module → Worker，每级增加 ~5ms 启动开销

**Proxy Handler 实现骨架**:

```typescript
function createPluginSandbox(manifest: PluginManifest): PluginSandbox {
  const allowedAPIs = buildAllowedAPIs(manifest.permissions)
  const handler: ProxyHandler<object> = {
    get(target, prop) {
      if (typeof prop === 'string' && isAllowedAPI(prop, allowedAPIs)) {
        return allowedAPIs[prop]
      }
      throw new PermissionDeniedError(prop)
    },
    set() { throw new PermissionDeniedError('set') },
    has(target, prop) {
      return typeof prop === 'string' && isAllowedAPI(prop, allowedAPIs)
    }
  }
  return new Proxy(Object.create(null), handler)
}
```

`Object.create(null)` 创建无原型对象，拦截 `__proto__`/`constructor`/`prototype` 访问。`get` trap 仅返回 manifest 中声明的 API 命名空间，其余抛出 `PermissionDeniedError`。

### 2.5 向后兼容

通过 feature flag `PLUGIN_MARKETPLACE` 控制，关闭时不影响现有 skill 系统。

### 2.6 Integration

| File | Operation |
|------|-----------|
| `src/commands/plugin/` | **New** — 16 files |
| `src/services/plugin/` | **New** — 插件加载和管理 |

---

## 3. Skill Store (P1)

**Source**: `/Users/heal/claude-code/src/commands/skill-store/launchSkillStore.tsx`

### 3.1 核心操作

| 操作 | API |
|------|-----|
| list | 列出可用 skills |
| get | 获取 skill 详情 |
| versions | 获取版本历史 |
| create | 创建新 skill |
| delete | 删除 skill |
| install | 安装到本地 |

### 3.2 Skill Store API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/skills` | GET | 列出所有已安装 skill |
| `/skills/:id` | GET | 获取 skill 详情 |
| `/skills/:id/install` | POST | 安装 skill |
| `/skills/:id/uninstall` | DELETE | 卸载 skill |
| `/skills/:id/versions` | GET | 获取版本列表 |
| `/skills/search` | GET | 搜索 skill（q, category, tags） |

**`/skills/search` 请求/响应 Schema**:

```typescript
// GET /skills/search?q={query}&limit={n}
interface SearchRequest {
  q: string          // 搜索关键词
  limit?: number     // 默认 20，最大 100
  offset?: number    // 分页偏移
  category?: string  // 可选分类过滤
}

interface SearchResponse {
  results: SkillEntry[]
  total: number
  took_ms: number
}

interface SkillEntry {
  id: string
  name: string
  description: string
  version: string
  author: string
  category: string
  score: number      // TF-IDF 相关性分数
  installed: boolean // 是否已安装
}
```

**协议**: 本地 JSON 文件 + 可选远程 HTTP API
**认证**: 本地无需认证，远程 API 使用 OAuth Device Code Flow

**远程 Skill Store OAuth 流程**:

```typescript
// OAuth Device Code Flow for Skill Store
// 适用于无浏览器环境（CLI 工具的标准 OAuth 模式）
async function authenticateSkillStore(): Promise<string> {
  // Step 1: 请求 device code
  const { device_code, user_code, verification_uri, expires_in, interval } =
    await fetch('https://skills.claude.ai/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'claude-cc', scope: 'read install' })
    }).then(r => r.json())

  // Step 2: 显示 user_code + verification_uri 给用户
  console.log(`请在浏览器中访问: ${verification_uri}`)
  console.log(`输入授权码: ${user_code}`)

  // Step 3: 轮询 token endpoint 直到用户授权
  return pollForToken(device_code, interval, expires_in)
}

async function pollForToken(
  deviceCode: string, interval: number, expiresIn: number
): Promise<string> {
  const deadline = Date.now() + expiresIn * 1000
  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    const resp = await fetch('https://skills.claude.ai/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: 'claude-cc'
      })
    }).then(r => r.json())

    if (resp.access_token) return resp.access_token
    if (resp.error === 'slow_down') interval = resp.interval  // 服务器要求降速
    if (resp.error === 'authorization_pending') continue
    throw new OAuthError(resp.error, resp.error_description)
  }
  throw new OAuthError('expired', 'Device code expired')
}
```

**Token 存储**: 获取的 access_token 存储到 LocalVault（见 ACP Vault 设计），key 为 `skill-store-token`。

**离线降级**: 远程 API 不可用时，自动 fallback 到本地 `~/.claude/skills/index.json` 索引。该索引在上次成功连接远程 API 时缓存，包含已安装 skill 的元数据和版本信息。离线模式下仅支持已安装 skill 的查询和操作，不支持搜索和安装新 skill。

### 3.3 向后兼容

通过 feature flag `SKILL_STORE` 控制，关闭时使用现有本地 skill 加载逻辑。

### 3.4 Integration

| File | Operation |
|------|-----------|
| `src/commands/skill-store/` | **New** |
| `src/services/skill-store/` | **New** — 远程 API 客户端 |

---

## 4. Skill Search Auto-Match (P1)

**Source**: `/Users/heal/claude-code/src/commands/skill-search/skillSearchPanel.tsx`

### 4.1 核心算法

TF-IDF 向量余弦相似度搜索：
- 英文词干化（stemming）
- CJK bi-gram 分词
- 每轮对话自动注入最相关 skill

### 4.2 TF-IDF 引擎细节

- **向量维度**: 词汇表动态构建，无固定维度上限
- **TF 计算**: log(1 + count(term, doc))
- **IDF 计算**: log(N / df(term)) + 1
- **相似度**: 余弦相似度 cos(A,B) = A·B / (|A|×|B|)
- **CJK 处理**: bi-gram 分词（中文/日文/韩文字符两两组合）
- **停止词**: 内置英文停止词表（~150 词），中文无停止词
- **索引**: 内存倒排索引，skill 数量 < 1000 时无需持久化

### 4.3 向后兼容

通过 feature flag `SKILL_SEARCH` 控制，关闭时 skill 需手动指定。

### 4.4 流程

```
用户消息 → TF-IDF 向量化 → 余弦相似度匹配 → Top-K skills → 注入 system prompt
```

### 4.5 Integration

| File | Operation |
|------|-----------|
| `src/services/skill-search/` | **New** — TF-IDF 引擎 |
| `src/query/preProcessingHooks.ts` | Modify — 自动注入匹配 skill |

---

## 5. Hooks Config Menu (P2)

**Source**: `/Users/heal/claude-code/src/commands/hooks/hooks.tsx`

### 5.1 核心功能

可视化 hooks 配置管理：交互式菜单配置 PreToolUse/PostToolUse/Stop/Notification 等事件的 hook，支持 matcher 和模式选择。

### 5.2 向后兼容

通过 feature flag `HOOKS_CONFIG` 控制，关闭时使用现有手动配置方式。

### 5.3 Integration

| File | Operation |
|------|-----------|
| `src/commands/hooks/` | **New** |
| `src/components/hooks/` | **New** — HooksConfigMenu |

---

## 6. Plugin Patterns Library (P2)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/plugin-patterns/index.ts`

### 6.1 内置模式

| 模式 | 功能 |
|------|------|
| 自动格式化 | 代码保存后自动格式化 |
| Lint 验证 | 代码变更后自动 lint |
| 提交消息验证 | git commit 前验证消息格式 |
| 测试运行器 | 代码变更后自动测试 |
| 类型检查 | TypeScript 类型检查 |

### 6.2 向后兼容

通过 feature flag `PLUGIN_PATTERNS` 控制，关闭时插件模式不生效。

### 6.3 Integration

| File | Operation |
|------|-----------|
| `src/services/plugin-patterns/` | **New** |

---

## 7. Mode Registry (P2)

**Source**: `/Users/heal/oh-my-claudecode/src/hooks/mode-registry/index.ts`

### 7.1 核心功能

集中式模式状态检测：统一管理 autopilot/autoresearch/team/ralph/ultrawork 模式的激活状态，文件级检测避免循环依赖。

### 7.2 向后兼容

通过 feature flag `MODE_REGISTRY` 控制，关闭时使用现有分散式模式检测。

### 7.3 Integration

| File | Operation |
|------|-----------|
| `src/services/mode-registry/` | **New** |

---

## 8. 架构师视角

### 8.1 生态架构

```
用户层:    /plugin → /skill-store → /skill-search
分发层:    Marketplace API → Skill Store API
执行层:    Plugin Sandbox → Skill Runtime → Hook Engine
存储层:    ~/.claude/plugins/ → ~/.claude/skills/
```

### 8.2 ola-cc 适配

ola-cc 已有 Skill 系统（superpowers），可扩展：
- Skill Store → 远程 skill 分发
- Skill Search → 自动 skill 匹配
- Plugin Marketplace → 第三方插件生态

---

## 9. 产品经理视角

### 9.1 用户价值

| 功能 | 解决的痛点 | 用户感知 |
|------|-----------|---------|
| Plugin Marketplace | "想扩展功能但不会写代码" | 浏览器式插件安装 |
| Skill Store | "skill 分享不便" | 远程 skill 商店 |
| Skill Search | "不知道用哪个 skill" | 自动推荐最相关 skill |
| Hooks Config | "hooks 配置太复杂" | 可视化配置界面 |

---

## 10. 实施路线图

| Phase | 功能 | 优先级 | 依赖 |
|-------|------|--------|------|
| Phase 1 | Skill Search Auto-Match | P1 | TF-IDF 引擎 |
| Phase 2 | Skill Store | P1 | 远程 API |
| Phase 3 | Plugin Marketplace | P1 | Phase 2 |
| Phase 4 | Hooks Config + Mode Registry | P2 | 无 |

---

## 11. Feature Flags

| Flag | 控制范围 | 默认值 |
|------|---------|--------|
| `PLUGIN_MARKETPLACE` | 插件市场功能 | off |
| `SKILL_STORE` | 远程 Skill 商店 | off |
| `SKILL_SEARCH` | TF-IDF 自动匹配 | off |
| `HOOKS_CONFIG` | 可视化 Hooks 配置 | off |
| `PLUGIN_PATTERNS` | 插件模式库 | off |
| `MODE_REGISTRY` | 集中式模式注册 | off |

每个子系统独立 feature flag，可单独启用/禁用，确保向后兼容。

---

## 12. LOC 估算与改造难度

| 子系统 | 估算行数 | 难度 | 说明 |
|--------|---------|------|------|
| Plugin Marketplace | ~800 | L | 沙箱+UI+信任链（含 Proxy-based 沙箱实现） |
| Skill Store | ~400 | M | API 客户端+UI |
| Skill Search (TF-IDF) | ~300 | M | 算法+索引+注入 |
| Hooks Config | ~200 | S | UI 配置界面 |
| Mode Registry | ~200 | S | 状态管理 |
| **总计** | **~2300** | **XL** | 含沙箱实现增量 |
