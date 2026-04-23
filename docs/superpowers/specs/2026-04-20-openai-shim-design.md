# OpenAI Shim 整合设计文档

**日期:** 2026-04-20
**状态:** 已批准
**范围:** 在 base_branch_code 中新增 openaiShim.ts，与现有 openai.ts 共存

## 目标

在 base_branch_code 中新增一个增强版 OpenAI 协议转换层，提供比现有 `openai.ts` 更完善的消息格式转换、流式响应处理和多模态支持，同时不引入复杂的 provider 管理系统依赖。

## 约束

- 现有 `openai.ts` 保持不变，不破坏现有功能
- 不引入 providerConfig.ts、providerProfile.ts、codexOAuth 等复杂依赖
- 保持零外部依赖（仅使用 Node.js 内置模块）

## 架构

### 文件位置

```
base_branch_code/src/services/api/
├── openai.ts          ← 现有文件，保持不变
└── openaiShim.ts      ← 新增文件
```

### 导出接口

```typescript
// 入口
export function createOpenAICompatibleShimClient(options: OpenAICompatibleClientOptions)
// 类型
export interface OpenAICompatibleClientOptions
```

### 核心功能

1. **Thinking block 转换** — Claude thinking 块作为 `[Thinking] ...` 文本嵌入
2. **多模态图片支持** — 完整 image/document block 转换
3. **增强的 tool_use 转换** — 准确的 tool_call_id 映射和状态跟踪
4. **系统消息合并** — 所有 system 块合并为单一消息，优化前缀缓存
5. **OPENAI_EXTRA_BODY** — 支持后端特定配置
6. **流式 SSE 解析** — 修复 tool_call 跨 chunk 的状态累积
7. **指数退避重试** — 429/5xx/网络错误的自动重试

### 依赖关系

```
openaiShim.ts → crypto (node 内置)
openaiShim.ts → process.env
```

无新增外部 npm 依赖。

## 调用方式

- 现有代码: `import { createOpenAICompatibleClient } from './openai.js'`
- 新代码: `import { createOpenAICompatibleShimClient } from './openaiShim.js'`

两者接口兼容，可互换使用。

## 实现要点

- **源文件:** 从 openclaude 项目的 `src/services/api/openai.ts` 移植核心逻辑
- **移除依赖:** 移除 `providerConfig.ts`、`codexOAuth.ts` 相关的 import 引用（如有）
- **内联实现:** 保持 `fetchWithRetry` 内联实现，不引入外部重试库
- **UUID 生成:** 使用 `crypto.randomUUID` 生成消息/事件 ID
- **测试文件:** 可选新增 `openaiShim.test.ts`，参考 openclaude 的 `openaiShim.test.ts`
