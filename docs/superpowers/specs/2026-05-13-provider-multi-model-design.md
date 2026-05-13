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
2. 如果有 → 显示该 Provider 下的 model 列表，按回车切换
3. 如果没有 → 显示现有的 ModelPicker（Claude 内置模型）

**`/model <name>`：**
- 更新 `activeModel` 为 `<name>`
- 设置 AppState 中的 `mainLoopModel`

**`/model --providers`：**
- 保持不变，列出所有 provider 及其 models

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

| 命令 | 功能 | 示例 |
|------|------|------|
| `/auth add-model <provider> <model>` | 给指定 provider 添加新 model | `/auth add-model dashscope qwen-turbo` |
| `/auth remove-model <provider> <model>` | 从 provider 移除 model | `/auth remove-model dashscope qwen-turbo` |
| `/auth edit <name>` | 编辑 provider（名称、URL、Key） | `/auth edit dashscope` |

## 架构

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/commands/auth/auth.tsx` | 重构 ProviderProfile 类型；迁移函数；引导表单添加多 model 步骤；`/auth list` 显示 models 列表 |
| `src/commands/model/model.tsx` | `/model` 无参数时优先检查当前 provider 的 models；`/model <name>` 更新 activeModel |
| `src/commands/auth/index.ts` | 更新描述文案 |
| `src/commands.ts` | 无需改动 |

### 核心逻辑

**1. loadProfiles 迁移**

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
4. **/model 切换 provider 外的 model** — 允许（如从 dashscope 切回 claude-sonnet），此时清除 activeProfile
5. **/auth delete 当前 provider** — 清除 activeProfile 和 activeModel
6. **API Key 明文存储** — 与现有 settings.json 中其他敏感信息一致

## 依赖关系

```
auth.tsx       ← ProviderProfile 类型变更、迁移函数、引导表单多 model 步骤
                 ← /auth list 显示 models 列表
                 ← /auth use 使用 defaultModel
model.tsx      ← /model 无参数时检查 provider models
                 ← ProviderModelPicker 新组件
                 ← /model <name> 更新 activeModel
settings.ts    ← 无需改动（已有的 updateSettingsForSource 自动支持新字段）
```

无新增外部依赖。
