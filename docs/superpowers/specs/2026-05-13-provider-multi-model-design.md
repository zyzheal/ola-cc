# Provider 多 Model 支持设计文档

**日期:** 2026-05-13
**状态:** 待批准
**范围:** 重构 `/auth` 系统支持一个 Provider 绑定多个 Model，`/model` 命令感知 Provider 上下文

## 背景

当前 `ProviderProfile` 将 provider（API URL + Key + 协议类型）与单一 model 绑定在一起，每个 profile 只能保存一个 model。用户需求：
1. 一个 Provider 支持多个 model
2. 切换 model 时不需要重新输入 API 信息
3. `/model` 命令直接列出当前 Provider 下的 model 供选择

## 目标

- Provider 内嵌 Model 列表，支持多个 model 共享同一套认证信息
- 引导表单支持添加多个 model
- `/model` 命令优先展示当前 Provider 下的 model 列表
- 向后兼容旧格式（单 model profile）

## 数据结构变更

### ProviderProfile 新格式

```typescript
interface ProviderProfile {
  name: string
  provider: 'openai' | 'anthropic'
  apiUrl: string
  apiKey: string
  models: string[]          // 新增：支持多个 model
  defaultModel: string      // 新增：默认 model（切换 provider 时使用）
  verified: boolean
  addedAt: string
}
```

### ProfilesData 新格式

```typescript
interface ProfilesData {
  profiles: ProviderProfile[]
  activeProfile?: string    // 当前激活的 provider
  activeModel?: string      // 新增：当前激活的 model
}
```

### 存储格式示例

```json
{
  "__olaProviders__": {
    "profiles": [
      {
        "name": "dashscope",
        "provider": "openai",
        "apiUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "apiKey": "sk-xxx",
        "models": ["qwen3.6-plus", "qwen-max", "qwen-turbo"],
        "defaultModel": "qwen3.6-plus",
        "verified": true,
        "addedAt": "2026-05-13T10:00:00.000Z"
      }
    ],
    "activeProfile": "dashscope",
    "activeModel": "qwen-max"
  }
}
```

## 向后兼容

迁移函数：加载 profiles 时自动转换旧格式。

```typescript
function migrateProfile(p: any): ProviderProfile {
  if (p.models && Array.isArray(p.models)) return p  // 已迁移
  // 旧格式：单个 model 字段
  const model = p.model || p.defaultModel || ''
  return {
    ...p,
    models: model ? [model] : [],
    defaultModel: model,
  }
}
```

## 交互流程

### 添加 Provider（引导表单）

1. 输入名称
2. 选择 Provider 类型（OpenAI / Anthropic）
3. 输入 API URL
4. 输入 API Key（掩码）
5. 输入第一个 model 名称
6. **新增步骤：** "是否添加更多 model？（输入 model 名称或按 Enter 跳过）"
   - 输入 model 名称 → 加入列表 → 继续询问
   - 直接按 Enter → 进入验证步骤
7. 验证连接（使用第一个 model）
8. 完成

### `/model` 命令行为变更

**无参数：**
1. 检查当前是否有激活的 Provider（`activeProfile`）
2. 如果有 → 显示 `ProviderModelPicker` 组件，列出该 Provider 下的 models
3. 如果没有 → 显示现有的 ModelPicker（Claude 内置模型）

**`/model <name>`：**
1. 检查 `<name>` 是否在当前 provider 的 models 列表中
2. 如果是 provider model → 绕过 `validateModel()`，直接设置 `mainLoopModel` 和 `activeModel`
3. 如果不是 provider model → 走现有 `SetModelAndClose` 路径（validateModel 验证）
   - 验证通过后，清除 `activeProfile`（因为切换到了非 provider 模型）
4. 更新 AppState 中的 `mainLoopModel`

**`/model --providers`：**
- 改为使用 `loadProfiles()` 统一读取，列出所有 provider 及其 models

### `/auth list` 显示格式

```
已保存的 Provider 配置:
1. dashscope (当前)  ✓  openai
   URL: https://dashscope.aliyuncs.com/compatible-mode/v1
   Models: qwen3.6-plus (默认), qwen-max, qwen-turbo
   当前模型: qwen-max

2. claude-pro  ✓  anthropic
   URL: https://api.anthropic.com
   Models: claude-sonnet-4-20250514 (默认)
```

### `/auth use` 行为

- 切换到指定 provider
- 使用其 `defaultModel` 作为当前模型
- 更新 `activeProfile` 和 `activeModel`

### 切换 Model 的两种方式

| 方式 | 命令 | 效果 |
|------|------|------|
| 切换 Provider | `/auth use dashscope` | 切换 provider，使用 defaultModel |
| 切换 Model | `/model <name>` | 仅切换 model，provider 不变 |

## 新增命令

| 命令 | 功能 | 示例 | 交互方式 |
|------|------|------|----------|
| `/auth add-model <provider> <model>` | 给指定 provider 添加新 model | `/auth add-model dashscope qwen-turbo` | CLI-only，添加后验证连接 |
| `/auth remove-model <provider> <model>` | 从 provider 移除 model | `/auth remove-model dashscope qwen-turbo` | CLI-only，不能移除 defaultModel |
| `/auth edit <name>` | 编辑 provider 配置 | `/auth edit dashscope` | 复用 AddProviderForm，填充 initialValues |

**`/auth edit` 交互流程：**
1. 加载指定 provider 的现有数据
2. 复用 AddProviderForm，填充所有字段为当前值
3. 用户修改后重新验证连接
4. 保存（覆盖原 profile，不创建新 profile）

**`/auth add-model` 行为：**
- 如果 provider 不存在 → 报错
- 如果 model 已存在 → 提示已存在
- 添加后使用新 model 验证连接

**`/auth remove-model` 行为：**
- 如果 model 是 defaultModel 且是唯一 model → 拒绝（至少保留一个 model）
- 如果 model 是 defaultModel 但有其他 model → 将第一个 model 设为新 default
- 如果 `activeModel` 正是要移除的 model → 将 activeModel 设为 defaultModel

## 架构

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/commands/auth/auth.tsx` | 重构 ProviderProfile 类型；迁移函数；引导表单添加多 model 步骤；`/auth list` 显示 models 列表；新增 `/auth add-model`、`/auth remove-model` 处理 |
| `src/commands/model/model.tsx` | `/model` 无参数时优先检查当前 provider 的 models；新增 `ProviderModelPicker` 组件逻辑；`/model <name>` 对 provider model 绕过 validateModel |
| `src/components/ProviderModelPicker.tsx` | **新增组件**：Provider 内 model 选择器 UI |
| `src/commands/auth/index.ts` | 更新描述文案 |
| `src/commands.ts` | 无需改动 |

> **注意：** `model.tsx` 是预编译文件（使用 `react/compiler-runtime`）。直接编辑编译后的输出，保持与现有编译模式兼容。

### 核心逻辑

**0. ProviderModelPicker 新组件（src/components/ProviderModelPicker.tsx）**

```typescript
function ProviderModelPicker({
  provider,
  activeModel,
  onDone,
}: {
  provider: ProviderProfile
  activeModel: string
  onDone: (result?: string, options?: { display?: CommandResultDisplay }) => void
}) {
  // 渲染当前 provider 下的 models 列表
  // 用户选择后：更新 activeModel + activeProfile.activeModel + setAppState(mainLoopModel)
  // 如果选择不在 models 列表中（自由输入），清除 activeProfile
}
```

此组件职责：
- 展示 `provider.models` 列表，标注 `defaultModel` 和 `activeModel`
- 支持用户从列表中选择或自由输入 model 名称
- 选中后同步 `ProfilesData.activeModel` 和 `AppState.mainLoopModel`
- 自由输入的 model 不在 provider.models 中时，清除 `activeProfile`

**1. loadProfiles 迁移****

```typescript
function loadProfiles(): ProfilesData {
  try {
    const settings = getSettingsForSource('userSettings')
    const raw = (settings as any).__olaProviders__
    if (raw && typeof raw === 'object') {
      const profiles = (Array.isArray(raw.profiles) ? raw.profiles : [])
        .map(migrateProfile)
      return {
        profiles,
        activeProfile: raw.activeProfile,
        activeModel: raw.activeModel,
      }
    }
  } catch { /* ignore */ }
  return { profiles: [] }
}
```

**2. `/auth use` 切换逻辑**

```typescript
case 'use': {
  const profile = data.profiles.find(p => p.name === parsed.name)
  if (!profile) { /* error */ break }

  // 设置环境变量
  if (profile.provider === 'openai') {
    process.env.CLAUDE_CODE_USE_OPENAI = 'true'
    process.env.OPENAI_API_KEY = profile.apiKey
    process.env.OPENAI_API_BASE = profile.apiUrl
    process.env.OPENAI_BASE_URL = profile.apiUrl
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = profile.apiKey
    if (profile.apiUrl) process.env.ANTHROPIC_BASE_URL = profile.apiUrl
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_API_KEY
  }

  // 使用 defaultModel
  const modelToUse = profile.defaultModel || profile.models[0] || ''
  setAppState(prev => ({ ...prev, mainLoopModel: modelToUse }))
  data.activeProfile = profile.name
  data.activeModel = modelToUse
  saveProfiles(data)
  break
}
```

**3. `/model` 无参数时显示 Provider models**

```typescript
// 检查当前 provider 是否有 models
const activeProfile = data.profiles.find(p => p.name === data.activeProfile)
if (activeProfile && activeProfile.models.length > 0) {
  // 显示 Provider model 选择器
  return <ProviderModelPicker
    provider={activeProfile}
    activeModel={data.activeModel || activeProfile.defaultModel}
    onDone={onDone}
  />
}
// 回退到现有 ModelPicker
return <ModelPickerWrapper onDone={onDone} />
```

## 数据流

```
/auth add → AddProviderForm → 添加多个 models → verifyProviderProfile → saveProfiles
                                                                        ↓
/auth use → 设置环境变量 + activeProfile + activeModel → setAppState(mainLoopModel)
                                                                        ↓
/model → 检查 activeProfile.models → ProviderModelPicker → 更新 activeModel
                                                                        ↓
API 请求 → 使用环境变量（API Key + URL）+ mainLoopModel
```

## 边界情况

1. **旧 profile 没有 models 数组** — 迁移函数自动转换
2. **models 列表为空** — 视为无效 profile，`/auth list` 显示警告
3. **defaultModel 不在 models 列表中** — 视为无效，使用 models[0]
4. **/model 切换 provider 外的 model** — 允许（如从 dashscope 切回 claude-sonnet），验证通过后清除 `activeProfile`，后续 `/model` 无参数时回退到 ModelPicker
5. **/auth delete 当前 provider** — 清除 activeProfile 和 activeModel
6. **API Key 明文存储** — 与现有 settings.json 中其他敏感信息一致
7. **/auth remove-model 移除最后一个 model** — 拒绝，至少保留一个 model
8. **/model <name> 与 validateModel() 冲突** — provider model 不在 Anthropic allowlist 中，需绕过验证。方案：检查 model 是否在 activeProfile.models 中，如果是则跳过 validateModel
9. **并发修改** — 多个终端同时修改 settings.json 可能导致数据丢失，settings.ts 已有文件锁机制保护

## Analytics 事件

| 事件名 | 参数 | 触发时机 |
|--------|------|----------|
| `tengu_auth_add_model` | `{ provider, model }` | 添加 model 成功 |
| `tengu_auth_remove_model` | `{ provider, model }` | 移除 model 成功 |
| `tengu_auth_edit_provider` | `{ provider, changedFields }` | 编辑 provider 成功 |
| `tengu_model_switch_provider` | `{ provider, fromModel, toModel }` | 通过 /model 切换 provider 内 model |

## 依赖关系

```
auth.tsx              ← ProviderProfile 类型变更、迁移函数、引导表单多 model 步骤
                        ← /auth list 显示 models 列表
                        ← /auth use 使用 defaultModel
                        ← /auth add-model / remove-model CLI 处理
                        ← /auth edit 复用 AddProviderForm
ProviderModelPicker.tsx ← 新组件：Provider 内 model 选择器
                          ← 展示 models 列表、选择、自由输入
                          ← 同步 activeModel + mainLoopModel
                          ← 自由输入 model 不在列表中时清除 activeProfile
model.tsx             ← /model 无参数时检查 provider models，显示 ProviderModelPicker
                        ← /model <name> 对 provider model 绕过 validateModel
                        ← /model <name> 对非 provider model 清除 activeProfile
                        ← /model --providers 统一使用 loadProfiles()
settings.ts           ← 无需改动（已有的 updateSettingsForSource 自动支持新字段）
```

无新增外部依赖。
