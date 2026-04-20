# Provider Models 配置化设计文档

**日期:** 2026-04-20
**状态:** 待批准
**范围:** 在 base_branch_code 中支持通过 ~/.claude.json 的 providerModels 配置自定义模型列表

## 目标

将 `/model` 命令的模型列表来源从硬编码的 `ALL_MODEL_CONFIGS` 改为 `~/.claude.json` 中的 `providerModels` 配置，同时支持 `model` 字段指定默认模型。Anthropic 和 OpenAI 协议共用同一套逻辑。

## 约束

- `providerModels` 配置存在时**完全替代**内置模型列表，不回退到 `ALL_MODEL_CONFIGS`
- `providerModels` 未配置时保持现有行为不变
- 同时支持全局级（~/.claude.json）和项目级（projects 下）配置，项目级覆盖全局

## 配置格式

### 全局配置（~/.claude.json）

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://coding.dashscope.aliyuncs.com/apps/anthropic",
    "ANTHROPIC_API_KEY": "sk-xxx"
  },
  "model": "qwen3.6-plus",
  "providerModels": ["qwen3.6-plus", "qwen3.5-plus", "glm-5", "kimi-k2.5"]
}
```

### 项目级配置（~/.claude.json 的 projects 下）

```json
{
  "projects": {
    "/path/to/my-project": {
      "model": "glm-5",
      "providerModels": ["glm-5", "glm-4.7"]
    }
  }
}
```

项目级配置存在时**完全覆盖**全局配置，不合并。

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | `string` | 默认使用的模型 ID |
| `providerModels` | `string[]` | `/model` 命令展示的可选模型列表 |
| `env` | `Record<string, string>` | 连接信息（baseUrl、apiKey 等），已有字段 |

OpenAI 协议同理：

```json
{
  "env": {
    "CLAUDE_CODE_USE_OPENAI": "1",
    "OPENAI_BASE_URL": "https://api.deepseek.com/v1",
    "OPENAI_API_KEY": "sk-xxx"
  },
  "model": "deepseek-chat",
  "providerModels": ["deepseek-chat", "deepseek-reasoner"]
}
```

## 架构

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/utils/config.ts` | GlobalConfig 新增 `model?: string` 和 `providerModels?: string[]`；ProjectConfig 同理 |
| `src/utils/model/modelOptions.ts` | `getModelOptionsBase()` 开头优先检查 `providerModels`；新增 `resolveProviderConfig()` / `getProviderModelDefaultOption()` |
| `src/utils/model/model.ts` | `getUserSpecifiedModelSetting()` 优先读取 `config.model`；绕过 `isModelAllowed` 对 provider model 的检查 |

### 核心逻辑

**1. modelOptions.ts — getModelOptionsBase()**

```typescript
function getModelOptionsBase(fastMode = false): ModelOption[] {
  // 最高优先级：providerModels 配置
  const { models } = resolveProviderConfig()
  if (models?.length) {
    return [
      getProviderModelDefaultOption(),
      ...models.map(id => ({
        value: id,
        label: id,
        description: `Provider model (${id})`,
      })),
    ]
  }

  // 回退到现有内置逻辑（Anthropic/OpenAI/Bedrock 等）
  if (process.env.USER_TYPE === 'ant') { ... }
  // ... 现有分支全部保持不变
}
```

`getProviderModelDefaultOption()` 返回通用 Default 选项，不引用具体 Claude 模型名：

```typescript
function getProviderModelDefaultOption(): ModelOption {
  const { model } = resolveProviderConfig()
  return {
    value: null,
    label: 'Default (recommended)',
    description: model
      ? `Use configured model (${model})`
      : 'Use the configured default model',
  }
}
```

**2. resolveProviderModels() — 项目级覆盖全局**

两个字段共享相同的项目路径解析逻辑，合并为一个函数避免重复读取：

```typescript
function resolveProviderConfig(): {
  models?: string[]
  model?: string
} {
  const config = getGlobalConfig()
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  // 项目级存在时完全覆盖全局
  if (projectConfig?.providerModels !== undefined) {
    return {
      models: projectConfig.providerModels,
      model: projectConfig.model,
    }
  }
  return {
    models: config.providerModels,
    model: config.model,
  }
}
```

**3. model.ts — 默认模型优先读取 config.model**

```typescript
// getUserSpecifiedModelSetting() 重构优先级
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  // 1. 运行时 override（/model 命令已选择的）
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) return modelOverride

  // 2. 新增：config.model 字段（项目级优先）
  const { model: configModel, models: providerModels } = resolveProviderConfig()
  if (configModel) return configModel

  // 3. 环境变量
  const specifiedModel = process.env.ANTHROPIC_MODEL
    || process.env.OPENAI_MODEL
    || (getSettings_DEPRECATED() || {}).model
    || undefined

  // 4. allowlist 检查：仅对非 provider model 生效
  //    provider model 不在内置 allowlist 中是预期的，不应拦截
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    if (providerModels?.includes(specifiedModel)) {
      return specifiedModel
    }
    return undefined
  }

  return specifiedModel
}
```

### 数据流

```
~/.claude.json
├── model: "qwen3.6-plus"          ← 默认模型
├── providerModels: [...]          ← 可选列表
└── env: { baseUrl, apiKey }       ← 连接信息
         ↓
resolveProviderConfig()            ← 统一解析项目级/全局配置
         ↓
getUserSpecifiedModelSetting()     ← 读取默认模型（绕过 allowlist）
getModelOptionsBase()              ← 生成 /model 选择器列表
         ↓
ModelPicker                        ← UI 展示
         ↓
选中后写入 mainLoopModel → getAnthropicClient() 发起请求
```

## 依赖关系

```
config.ts        ← 新增字段定义 + 持久化（已有的 saveGlobalConfig 机制自动支持）
                 ← resolveProviderConfig() — 统一的项目/全局配置解析
modelOptions.ts  ← getModelOptionsBase() 优先读取 providerModels 生成选项
                 ← getProviderModelDefaultOption() — provider model 的 Default 选项
model.ts         ← getUserSpecifiedModelSetting() 优先读取 config.model
                 ← 绕过 isModelAllowed 对 provider model 的拦截
```

无新增外部依赖。

> **注意：** 不需要将新字段加入 `GLOBAL_CONFIG_KEYS` 数组。该数组用于 UI 展示和类型检查，持久化机制通过 `saveGlobalConfig` 写入整个对象，新可选字段会自动持久化。

## 边界情况

1. **providerModels 为空数组 `[]`** — 视为未配置，回退到内置列表
2. **providerModels 有值但 model 未设置** — `/model` 显示列表，Default 选项文案为 "Use the configured default model"
3. **model 指向 providerModels 之外的模型** — 允许（视为自定义模型），不在列表中高亮
4. **model 不在内置 allowlist 中** — provider model 预期不在 allowlist 中，`getUserSpecifiedModelSetting()` 应绕过 `isModelAllowed()` 拦截
5. **provider model 与环境变量冲突** — `config.model` 优先级高于环境变量，环境变量不会被使用
