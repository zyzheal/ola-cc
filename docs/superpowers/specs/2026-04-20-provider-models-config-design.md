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
| `src/utils/model/modelOptions.ts` | `getModelOptionsBase()` 优先检查 `providerModels`，有配置时替代内置列表 |
| `src/utils/model/model.ts` | `getUserSpecifiedModelSetting()` 优先读取 `model` 字段作为默认 |

### 核心逻辑

**1. modelOptions.ts — getModelOptionsBase()**

```typescript
function getModelOptionsBase(fastMode = false): ModelOption[] {
  // 最高优先级：providerModels 配置
  const models = resolveProviderModels()
  if (models?.length) {
    return [
      getDefaultOptionForUser(fastMode),
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

**2. resolveProviderModels() — 项目级覆盖全局**

```typescript
function resolveProviderModels(): string[] | undefined {
  const projectConfig = getCurrentProjectConfig()
  if (projectConfig.providerModels !== undefined) {
    return projectConfig.providerModels
  }
  return getGlobalConfig().providerModels
}
```

**3. model.ts — 默认模型优先读取 config.model**

```typescript
// getUserSpecifiedModelSetting() 新增优先级
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  // 1. 运行时 override（/model 命令已选择的）
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) return modelOverride

  // 2. 新增：~/.claude.json 的 model 字段
  const configModel = getGlobalConfig().model
  if (configModel) return configModel

  // 3. 环境变量
  specifiedModel = process.env.ANTHROPIC_MODEL
    || process.env.OPENAI_MODEL
    // ... 现有逻辑

  // ... 现有 allowlist 检查保持不变
}
```

### 数据流

```
~/.claude.json
├── model: "qwen3.6-plus"          ← 默认模型
├── providerModels: [...]          ← 可选列表
└── env: { baseUrl, apiKey }       ← 连接信息
         ↓
getUserSpecifiedModelSetting()     ← 读取默认模型
getModelOptionsBase()              ← 生成 /model 选择器列表
         ↓
ModelPicker                        ← UI 展示
         ↓
选中后写入 mainLoopModel → getAnthropicClient() 发起请求
```

## 依赖关系

```
config.ts        ← 新增字段定义 + 持久化（已有的 saveGlobalConfig 机制自动支持）
modelOptions.ts  ← 读取 providerModels 生成选项
model.ts         ← 读取 model 字段作为默认
```

无新增外部依赖。

## 边界情况

1. **providerModels 为空数组 `[]`** — 视为未配置，回退到内置列表
2. **providerModels 有值但 model 未设置** — `/model` 显示列表，但无默认选中（用户必须手动选择）
3. **model 指向 providerModels 之外的模型** — 允许（视为自定义模型），但不在列表中高亮
