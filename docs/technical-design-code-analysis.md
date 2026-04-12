# 技术设计：代码接管和功能完整性分析

**项目**: Claude Code 源码分析  
**阶段**: Phase 2 - Technical Design  
**创建日期**: 2026-04-12  
**状态**: 进行中

---

## 1. 技术可行性分析

### 1.1 源码可访问性

| 维度 | 状态 | 说明 |
|------|------|------|
| 源码获取 | ✅ 可行 | npm 包 source map 已还原 |
| 源码完整性 | ⚠️ 部分 | source map 中 sourcesContent 字段决定 |
| 原生模块 | ❌ 不可见 | C++/Rust 绑定已编译为二进制 |
| 动态代码 | ⚠️ 部分 | 运行时生成代码无法静态分析 |

### 1.2 分析技术选型

| 技术 | 用途 | 可行性 |
|------|------|--------|
| 静态分析 (AST) | 代码结构、依赖关系 | ✅ 高 |
| 动态分析 (Hook) | 运行时行为验证 | ✅ 中 |
| 文档生成 | 自动化 API 文档 | ✅ 高 |
| 可视化 | 架构图、调用图 | ✅ 中 |

---

## 2. 架构模式分析

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code CLI                       │
├─────────────────────────────────────────────────────────┤
│  UI Layer (React + Ink)                                  │
│  - App.tsx (根组件)                                      │
│  - Components (148+ 终端 UI 组件)                          │
│  - Hooks (87+ 自定义 Hooks)                              │
├─────────────────────────────────────────────────────────┤
│  Command Layer (87+ 斜杠命令)                             │
│  - 标准命令 (help, config, status...)                    │
│  - Feature-gated 命令 (buddy, ultraplan, bridge...)      │
│  - Internal-only 命令 (24+ 内部命令)                      │
├─────────────────────────────────────────────────────────┤
│  Tool Layer (53+ 工具)                                   │
│  - BashTool / FileEdit / FileRead / Write               │
│  - Agent / MCP / LSP / Glob / Grep                      │
│  - AskUserQuestion / SendMessage / Task                 │
├─────────────────────────────────────────────────────────┤
│  Service Layer                                           │
│  - API Service (Claude API 调用)                         │
│  - MCP Service (Model Context Protocol)                 │
│  - Analytics (GrowthBook, DataDog)                      │
│  - AutoDream (自动记忆整合)                              │
├─────────────────────────────────────────────────────────┤
│  Feature Modules                                         │
│  - BUDDY (宠物系统)                                      │
│  - KAIROS (持久助手)                                     │
│  - ULTRAPLAN (云端规划)                                  │
│  - COORDINATOR (多 Agent 编排)                             │
│  - BRIDGE (远程控制)                                     │
├─────────────────────────────────────────────────────────┤
│  Infrastructure                                          │
│  - CLI Transport (WebSocket/SSE)                        │
│  - Settings Management                                  │
│  - Memory/Persistence                                   │
│  - Security/Sandbox                                     │
└─────────────────────────────────────────────────────────┘
```

### 2.2 模块依赖关系

```
src/main.tsx (入口)
    │
    ├── src/commands.ts (命令注册)
    │     ├── 标准命令 (50+)
    │     ├── Feature-gated 命令 (动态加载)
    │     └── Internal-only 命令 (USER_TYPE='ant' 检查)
    │
    ├── src/tools/ (工具集)
    │     ├── BashTool/
    │     ├── FileEdit/
    │     ├── Agent/
    │     └── ...
    │
    ├── src/components/ (UI 组件)
    │     ├── App.tsx
    │     ├── InputArea/
    │     └── ...
    │
    ├── src/services/ (服务层)
    │     ├── analytics/
    │     ├── mcp/
    │     └── autoDream/
    │
    └── src/features/ (功能模块)
          ├── buddy/
          ├── assistant/ (KAIROS)
          ├── coordinator/
          └── bridge/
```

---

## 3. 分析框架设计

### 3.1 源码分析器架构

```
┌─────────────────────────────────────────────────────────┐
│                   分析器主入口                            │
│                   (analyze.ts)                           │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
┌──────────────┐ ┌──────────┐ ┌──────────┐
│ 结构分析器    │ │ 依赖分析器│ │ 功能分析器│
│ - 文件统计   │ │ - 导入导出│ │ - feature()│
│ - 目录树     │ │ - 调用图  │ │ - USER_TYPE│
│ - 模块分类   │ │ - 循环依赖│ │ - GrowthBook│
└──────────────┘ └──────────┘ └──────────┘
        │            │            │
        └────────────┼────────────┘
                     │
                     ▼
        ┌────────────────────────┐
        │     报告生成器          │
        │ - Markdown             │
        │ - JSON                 │
        │ - 可视化图表           │
        └────────────────────────┘
```

### 3.2 数据结构设计

```typescript
// 源码文件元数据
interface SourceFile {
  path: string
  type: 'ts' | 'tsx' | 'js' | 'jsx'
  size: number
  lines: number
  functions: FunctionInfo[]
  classes: ClassInfo[]
  imports: ImportInfo[]
  exports: ExportInfo[]
  featureGates: string[]
}

// 功能模块信息
interface FeatureModule {
  name: string
  featureGate: string
  files: string[]
  commands: string[]
  tools: string[]
  isEnabled: boolean  // 外部版本是否启用
  analysisStatus: 'pending' | 'in-progress' | 'completed' | 'blocked'
}

// 分析覆盖度统计
interface CoverageStats {
  totalFiles: number
  analyzedFiles: number
  documentedModules: number
  totalModules: number
  featureGatesFound: number
  commandsFound: number
  toolsFound: number
}
```

---

## 4. 功能完整性评估模型

### 4.1 评估维度

| 维度 | 权重 | 评估标准 |
|------|------|----------|
| 文档覆盖率 | 30% | 已文档化模块数 / 总模块数 |
| 代码理解深度 | 25% | 核心逻辑注释覆盖率 |
| 功能可运行性 | 20% | 可在外部版本运行的功能比例 |
| 架构清晰度 | 15% | 模块依赖关系文档质量 |
| 发现完整性 | 10% | 隐藏功能发现比例 |

### 4.2 评分卡

```
功能完整性评分 = Σ(维度得分 × 权重)

维度得分计算:
- 优秀 (90-100 分): ≥95% 覆盖率
- 良好 (75-89 分): 80-94% 覆盖率
- 中等 (60-74 分): 60-79% 覆盖率
- 待改进 (<60 分): <60% 覆盖率
```

---

## 5. 技术实现方案

### 5.1 静态分析工具链

| 工具 | 用途 | 集成方式 |
|------|------|----------|
| TypeScript Compiler API | AST 解析、类型分析 | 直接调用 |
| bun:bundle | feature() 检测 | 正则 + AST |
| 自研依赖分析器 | 模块依赖图 | Node.js 脚本 |
| Graphviz | 可视化依赖图 | CLI 调用 |

### 5.2 动态验证方案

| 场景 | 验证方法 | 工具 |
|------|----------|------|
| 命令可用性 | 执行 `/<command> --help` | Bun.spawn |
| 功能开关 | 检查 feature() 返回值 | 运行时 Hook |
| UI 行为 | 终端 UI 快照对比 | Playwright |

### 5.3 文档生成方案

```
源文件 → AST 分析 → 中间表示 → 模板渲染 → 输出文档
                           │
                           ├── Markdown (主要)
                           ├── JSON (机器可读)
                           └── HTML (可选)
```

---

## 6. 伪代码设计

### 6.1 核心分析器

```typescript
// src/analyzer/core.ts

import { parse } from 'typescript'
import { feature } from 'bun:bundle'

interface AnalysisResult {
  files: SourceFile[]
  features: FeatureModule[]
  coverage: CoverageStats
}

export async function analyzeProject(rootDir: string): Promise<AnalysisResult> {
  const files = await discoverFiles(rootDir)
  const features = await extractFeatures(files)
  const coverage = calculateCoverage(files, features)
  
  return { files, features, coverage }
}

async function discoverFiles(rootDir: string): Promise<SourceFile[]> {
  const patterns = ['src/**/*.ts', 'src/**/*.tsx']
  const filePaths = await glob(patterns, { cwd: rootDir })
  
  return Promise.all(filePaths.map(analyzeFile))
}

async function analyzeFile(filePath: string): Promise<SourceFile> {
  const content = await readFile(filePath, 'utf-8')
  const ast = parse(content, { filePath })
  
  return {
    path: filePath,
    type: getFileType(filePath),
    size: content.length,
    lines: content.split('\n').length,
    functions: extractFunctions(ast),
    classes: extractClasses(ast),
    imports: extractImports(ast),
    exports: extractExports(ast),
    featureGates: extractFeatureGates(content)
  }
}

function extractFeatureGates(content: string): string[] {
  const pattern = /feature\(['"]([^'"]+)['"]\)/g
  const matches = [...content.matchAll(pattern)]
  return [...new Set(matches.map(m => m[1]))]
}

async function extractFeatures(files: SourceFile[]): Promise<FeatureModule[]> {
  const featureMap = new Map<string, FeatureModule>()
  
  for (const file of files) {
    for (const gate of file.featureGates) {
      if (!featureMap.has(gate)) {
        featureMap.set(gate, {
          name: gate,
          featureGate: gate,
          files: [],
          commands: [],
          tools: [],
          isEnabled: false,
          analysisStatus: 'pending'
        })
      }
      featureMap.get(gate)!.files.push(file.path)
    }
  }
  
  // 从 commands.ts 提取命令信息
  const commandsFile = files.find(f => f.path.endsWith('commands.ts'))
  if (commandsFile) {
    const commandsInfo = await analyzeCommandsFile(commandsFile.path)
    for (const [gate, commands] of Object.entries(commandsInfo)) {
      featureMap.get(gate)?.commands.push(...commands)
    }
  }
  
  return Array.from(featureMap.values())
}

function calculateCoverage(files: SourceFile[], features: FeatureModule[]): CoverageStats {
  const analyzedFiles = files.filter(f => f.analysisStatus !== 'pending').length
  const documentedModules = features.filter(f => f.analysisStatus === 'completed').length
  
  return {
    totalFiles: files.length,
    analyzedFiles,
    documentedModules,
    totalModules: features.length,
    featureGatesFound: features.length,
    commandsFound: features.reduce((sum, f) => sum + f.commands.length, 0),
    toolsFound: features.reduce((sum, f) => sum + f.tools.length, 0)
  }
}
```

### 6.2 报告生成器

```typescript
// src/analyzer/report.ts

interface ReportOptions {
  format: 'markdown' | 'json' | 'html'
  outputPath: string
  includeDetails: boolean
}

export function generateReport(
  result: AnalysisResult,
  options: ReportOptions
): string {
  switch (options.format) {
    case 'markdown':
      return generateMarkdownReport(result, options)
    case 'json':
      return JSON.stringify(result, null, 2)
    case 'html':
      return generateHtmlReport(result, options)
    default:
      throw new Error(`Unsupported format: ${options.format}`)
  }
}

function generateMarkdownReport(result: AnalysisResult, options: ReportOptions): string {
  const { coverage, features } = result
  
  return `
# 功能完整性分析报告

## 概览

- 总文件数：${coverage.totalFiles}
- 已分析文件：${coverage.analyzedFiles}
- 功能模块：${coverage.totalModules}
- 已文档化模块：${coverage.documentedModules}

## 功能模块详情

${features.map(f => `
### ${f.name}
- 状态：${f.isEnabled ? '✅ 已启用' : '❌ 外部版禁用'}
- 文件数：${f.files.length}
- 命令数：${f.commands.length}
- 工具数：${f.tools.length}
`).join('\n')}

## 编译开关统计

发现 ${coverage.featureGatesFound} 个 feature gate

## 建议

${generateRecommendations(result)}
`
}

function generateRecommendations(result: AnalysisResult): string {
  const { coverage } = result
  const recommendations = []
  
  if (coverage.documentedModules / coverage.totalModules < 0.8) {
    recommendations.push('- 增加文档覆盖率至 80% 以上')
  }
  
  const disabledFeatures = result.features.filter(f => !f.isEnabled)
  if (disabledFeatures.length > 0) {
    recommendations.push(`- 分析 ${disabledFeatures.length} 个外部版禁用功能`)
  }
  
  return recommendations.join('\n') || '- 无明显改进建议'
}
```

---

## 7. TDD 测试策略

### 7.1 测试分类

| 测试类型 | 目标 | 工具 |
|----------|------|------|
| 单元测试 | 验证分析函数逻辑 | Bun:test |
| 集成测试 | 验证完整分析流程 | Bun:test + Mock FS |
| 端到端测试 | 验证报告生成 | 实际运行 + 输出比对 |

### 7.2 测试用例设计

```typescript
// src/analyzer/__tests__/core.test.ts

import { describe, it, expect } from 'bun:test'
import { analyzeFile, extractFeatureGates } from '../core'

describe('extractFeatureGates', () => {
  it('should extract single feature gate', () => {
    const content = `
      if (feature('BUDDY')) {
        // buddy code
      }
    `
    expect(extractFeatureGates(content)).toEqual(['BUDDY'])
  })
  
  it('should extract multiple feature gates', () => {
    const content = `
      if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
        // kairos code
      }
      if (feature('ULTRAPLAN')) {
        // ultraplan code
      }
    `
    expect(extractFeatureGates(content).sort())
      .toEqual(['KAIROS', 'KAIROS_BRIEF', 'ULTRAPLAN'].sort())
  })
  
  it('should handle nested feature gates', () => {
    const content = `
      if (feature('KAIROS')) {
        if (feature('KAIROS_CHANNELS')) {
          // channels code
        }
      }
    `
    expect(extractFeatureGates(content).sort())
      .toEqual(['KAIROS', 'KAIROS_CHANNELS'].sort())
  })
})

describe('analyzeFile', () => {
  it('should analyze TypeScript file correctly', async () => {
    const result = await analyzeFile('src/buddy/companion.ts')
    
    expect(result).toMatchObject({
      type: 'ts',
      functions: expect.any(Array),
      featureGates: expect.arrayContaining(['BUDDY'])
    })
  })
})
```

### 7.3 测试覆盖率目标

| 模块 | 覆盖率目标 | 优先级 |
|------|------------|--------|
| 核心分析器 | ≥90% | P0 |
| 报告生成器 | ≥80% | P1 |
| 工具函数 | ≥70% | P2 |

---

## 8. 技术风险与缓解

### 8.1 已识别风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| source map 不完整 | 分析遗漏 | 交叉验证多个版本 |
| 原生模块不可见 | 功能盲区 | 标注"未分析"区域 |
| 动态代码难追踪 | 行为分析困难 | 运行时 Hook 补充 |
| 分析性能问题 | 大文件超时 | 增量分析 + 缓存 |

### 8.2 技术债务

| 债务 | 产生原因 | 偿还计划 |
|------|----------|----------|
| AST 解析简化 | 时间限制 | 后续引入完整类型分析 |
| 硬编码路径 | 快速原型 | 重构为配置驱动 |
| 缺少可视化 | 优先级低 | Phase 4 实现 |

---

## 9. 技术决策记录

### 决策 1: 选择 TypeScript Compiler API

**背景**: 需要解析 TypeScript 源码并提取结构信息

**选项**:
- A: TypeScript Compiler API
- B: Esprima/Escodegen
- C: 正则表达式

**决策**: 选择 A

**理由**:
- 原生支持 TypeScript 语法
- 提供完整类型信息
- 社区成熟度高

### 决策 2: 优先 Markdown 输出

**背景**: 需要选择文档输出格式

**选项**:
- A: Markdown 优先
- B: JSON 优先
- C: HTML 优先

**决策**: 选择 A

**理由**:
- 人类可读性最佳
- GitHub 原生支持
- 易于版本控制

---

## 10. 下一步行动

1. **实现核心分析器** - 文件发现和结构分析
2. **实现 feature() 提取** - 编译开关检测
3. **实现报告生成器** - Markdown 报告输出
4. **编写单元测试** - 验证核心逻辑
5. **试点分析** - 对 buddy 模块完整分析

---

*文档版本：1.0 | 最后更新：2026-04-12*
