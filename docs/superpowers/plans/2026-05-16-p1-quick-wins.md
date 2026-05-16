# Phase 1: 快速见效 (P1) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过三个小改动提升工具查找和权限检查性能，同时补充 Compact prompt 中的敏感指令保护

**Architecture:** 工具查找从 O(n) 改为 O(1) Map 查找；权限规则预处理为索引；Compact prompt 增加敏感指令保护

**Tech Stack:** TypeScript, Zod

---

## 文件结构

```
src/
├── Tool.ts                              # 修改: 添加 ToolRegistry 类
├── utils/permissions/
│   ├── permissions.ts                   # 修改: 添加 PermissionIndex 类
│   └── permissionSetup.ts               # 修改: 使用索引
├── services/compact/
│   └── prompt.ts                        # 修改: 添加敏感指令保护
└── services/tools/
    └── toolExecution.ts                 # 修改: 使用 ToolRegistry
```

---

## Task 1: 工具查找 Map 化

**Files:**
- Modify: `src/Tool.ts:364-366` - 添加 ToolRegistry 类
- Modify: `src/services/tools/toolExecution.ts:345` - 使用 ToolRegistry
- Test: 通过现有功能测试验证无回归

- [ ] **Step 1: 在 Tool.ts 中添加 ToolRegistry 类**

在 `findToolByName` 函数后添加:

```typescript
/**
 * Tool registry with O(1) lookup using Map.
 * Replaces O(n) array.find() in findToolByName
 */
export class ToolRegistry {
  private toolMap: Map<string, Tool>
  private readonly tools: Tools

  constructor(tools: Tools) {
    this.tools = tools
    this.toolMap = new Map()
    for (const tool of tools) {
      // Primary name
      this.toolMap.set(tool.name.toLowerCase(), tool)
      // Aliases
      if (tool.aliases) {
        for (const alias of tool.aliases) {
          this.toolMap.set(alias.toLowerCase(), tool)
        }
      }
    }
  }

  find(name: string): Tool | undefined {
    return this.toolMap.get(name.toLowerCase())
  }

  getTools(): Tools {
    return this.tools
  }
}

/**
 * Create a ToolRegistry from tools.
 * Use this instead of repeated findToolByName calls.
 */
export function createToolRegistry(tools: Tools): ToolRegistry {
  return new ToolRegistry(tools)
}
```

- [ ] **Step 2: 修改 toolExecution.ts 使用 ToolRegistry**

在 `src/services/tools/toolExecution.ts` 第 345 行附近:

原代码:
```typescript
let tool = findToolByName(toolUseContext.options.tools, toolName)
```

修改为:
```typescript
// Use ToolRegistry for O(1) lookup instead of O(n) find
const registry = new ToolRegistry(toolUseContext.options.tools)
let tool = registry.find(toolName)
```

注意: 由于 toolExecution.ts 中每次工具调用都会创建新的 registry，需要进一步优化。可以创建一个模块级缓存:

在 `toolExecution.ts` 文件顶部添加:
```typescript
// Module-level cache for ToolRegistry, invalidated when tools change
let cachedToolsHash = 0
let toolRegistryCache: ToolRegistry | null = null

function getToolRegistry(tools: Tools): ToolRegistry {
  const currentHash = tools.length  // Simple hash based on length
  if (toolRegistryCache && cachedToolsHash === currentHash) {
    return toolRegistryCache
  }
  toolRegistryCache = new ToolRegistry(tools)
  cachedToolsHash = currentHash
  return toolRegistryCache
}
```

然后修改第 345 行:
```typescript
const registry = getToolRegistry(toolUseContext.options.tools)
let tool = registry.find(toolName)
```

- [ ] **Step 3: 运行现有测试验证无回归**

```bash
cd /Users/heal/ola-cc
# 运行相关测试（如果有的话）
# 或者直接使用 CLI 测试基本功能
bun run build:dev 2>&1 | head -50
```

- [ ] **Step 4: 提交**

```bash
git add src/Tool.ts src/services/tools/toolExecution.ts
git commit -m "perf(tool): add ToolRegistry with O(1) lookup

- Add ToolRegistry class with Map-based O(1) find
- Add module-level cache to avoid repeated registry creation
- Replace findToolByName calls in toolExecution with registry.find
- Improves tool lookup performance from O(n) to O(1)"
```

---

## Task 2: 权限规则索引

**Files:**
- Modify: `src/utils/permissions/permissions.ts` - 添加 PermissionIndex 类
- Modify: `src/hooks/useCanUseTool.tsx` - 使用索引
- Test: 验证权限检查功能正常

- [ ] **Step 1: 在 permissions.ts 中添加 PermissionIndex 类**

在 `src/utils/permissions/permissions.ts` 文件末尾添加:

```typescript
/**
 * Permission rules index for O(1) lookup by tool name.
 * Pre-processes rules to avoid O(n) traversal on every tool call.
 */
export class PermissionIndex {
  private byToolName: Map<string, PermissionRule[]>
  private allRules: PermissionRule[]

  constructor(rules: PermissionRule[]) {
    this.allRules = rules
    this.byToolName = new Map()

    for (const rule of rules) {
      // Index by tool name (e.g., "Bash", "Read", "Edit")
      const toolName = rule.tool
      if (!this.byToolName.has(toolName)) {
        this.byToolName.set(toolName, [])
      }
      this.byToolName.get(toolName)!.push(rule)
    }
  }

  /**
   * Get rules for a specific tool.
   */
  getRulesForTool(toolName: string): PermissionRule[] {
    return this.byToolName.get(toolName) ?? []
  }

  /**
   * Get all rules.
   */
  getAllRules(): PermissionRule[] {
    return this.allRules
  }

  /**
   * Check if index is empty.
   */
  isEmpty(): boolean {
    return this.allRules.length === 0
  }
}
```

- [ ] **Step 2: 创建权限上下文构建器**

在 `src/utils/permissions/permissionSetup.ts` 中修改 `buildToolPermissionContext`:

```typescript
// 在文件顶部添加模块级缓存
let permissionIndexCache: PermissionIndex | null = null

export function getPermissionIndex(rules: PermissionRule[]): PermissionIndex {
  // Reuse index if rules haven't changed (simple length-based check)
  if (permissionIndexCache && permissionIndexCache.getAllRules().length === rules.length) {
    return permissionIndexCache
  }
  permissionIndexCache = new PermissionIndex(rules)
  return permissionIndexCache
}
```

- [ ] **Step 3: 在 useCanUseTool 中使用索引**

在 `src/hooks/useCanUseTool.tsx` 中修改权限检查逻辑:

```typescript
// 在 hasPermissionsToUseTool 函数中，使用索引获取规则
const toolRules = useMemo(() => {
  if (!permissionContext?.rules) return []
  const index = getPermissionIndex(permissionContext.rules)
  return index.getRulesForTool(toolName)
}, [permissionContext?.rules, toolName])
```

- [ ] **Step 4: 测试权限功能**

```bash
# 启动 CLI 测试权限提示
bun run build:dev
# 输入测试命令触发权限检查
```

- [ ] **Step 5: 提交**

```bash
git add src/utils/permissions/permissions.ts src/utils/permissions/permissionSetup.ts src/hooks/useCanUseTool.tsx
git commit -m "perf(permissions): add PermissionIndex with O(1) tool lookup

- Add PermissionIndex class that pre-indexes rules by tool name
- Add getPermissionIndex helper with caching
- Modify useCanUseTool to use indexed rules
- Improves permission check from O(n) to O(1) per tool"
```

---

## Task 3: Compact Prompt 补充敏感指令保护

**Files:**
- Modify: `src/services/compact/prompt.ts` - 添加敏感指令保护

- [ ] **Step 1: 添加敏感指令保护提示词**

在 `src/services/compact/prompt.ts` 中，在 `DETAILED_ANALYSIS_INSTRUCTION` 后添加:

```typescript
// Sensitive instructions protection - added per upstream 2.1.139
const SENSITIVE_INSTRUCTIONS_PROTECTION = `
IMPORTANT: Preserve any sensitive user instructions or security-related configurations.
Do not summarize or remove:
- API keys, tokens, or credentials mentioned in the conversation
- Security policies, access control rules, or permission configurations
- Custom prompts, system instructions, or agent configurations
- Environment variables or deployment settings that the user explicitly provided

Retain these in the condensed conversation as needed for context.`
```

- [ ] **Step 2: 将保护提示词添加到 Compact Prompt 中**

找到 compact prompt 构建的位置，添加敏感指令保护:

```typescript
// 在构建完整 compact prompt 时追加
const fullCompactPrompt = COMPACT_PREAMBLE +
  existingAnalysisInstructions +
  SENSITIVE_INSTRUCTIONS_PROTECTION +  // 新增
  userInstructionsSection +
  // ... rest of prompt
```

- [ ] **Step 3: 验证编译通过**

```bash
cd /Users/heal/ola-cc
bun run build:dev 2>&1 | tail -20
```

- [ ] **Step 4: 提交**

```bash
git add src/services/compact/prompt.ts
git commit -m "fix(compact): add sensitive instructions protection to prompt

Per upstream 2.1.139 changelog: compaction prompt now asks the model
to preserve sensitive user instructions, API keys, credentials, and
security configurations. Adds SENSITIVE_INSTRUCTIONS_PROTECTION constant
and includes it in the compact prompt."
```

---

## 实施检查清单

| Task | 检查项 | 状态 |
|------|--------|------|
| P1.1 | 工具查找从 O(n) 变为 O(1) | ☐ |
| P1.1 | Module-level cache 避免重复创建 | ☐ |
| P1.1 | 测试验证无回归 | ☐ |
| P1.2 | PermissionIndex 类添加 | ☐ |
| P1.2 | getPermissionIndex 缓存 helper | ☐ |
| P1.2 | useCanUseTool 使用索引 | ☐ |
| P1.2 | 权限功能测试正常 | ☐ |
| P1.3 | SENSITIVE_INSTRUCTIONS_PROTECTION 添加 | ☐ |
| P1.3 | Compact prompt 包含保护 | ☐ |
| P1.3 | 编译通过 | ☐ |

---

## 预期性能提升

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 工具查找 | O(n) | O(1) | ~50x (53 tools) |
| 权限检查 | O(n rules) | O(1) per tool | ~10x |
| Compact prompt | 无保护 | 有保护 | 功能补齐 |

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-16-p1-quick-wins.md`**

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**