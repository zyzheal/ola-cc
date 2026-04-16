# 工具识别修复总结

## 问题描述

在 macOS 系统下，系统存在以下问题：

1. **PowerShellTool 错误启用**：PowerShellTool 的 `isEnabled()` 方法始终返回 `true`，导致在非 Windows 系统（如 macOS）上也被识别为可用工具
2. **工具识别不准确**：当执行搜索操作时，系统可能错误地尝试使用 PowerShellTool 而不是使用封装好的 GrepTool（基于 ripgrep）
3. **未使用 ripgrep 封装**：系统没有正确使用已封装的 ripgrep 工具进行快速文件搜索

## 根本原因

### 1. PowerShellTool 平台判断缺失

**文件**: `src/tools/PowerShellTool/PowerShellTool.tsx`

```typescript
// 修复前
isEnabled(): boolean {
  return true;  // ❌ 在所有平台都启用
}

// 修复后
isEnabled(): boolean {
  // PowerShell is only available on Windows platforms
  return getPlatform() === 'windows';  // ✅ 仅在 Windows 启用
}
```

### 2. 工具识别流程

系统的工具识别流程如下：

```
工具调用
  ↓
findToolByName(tools, toolName)
  ↓
tool.isSearchOrReadCommand(input)
  ↓
返回 { isSearch, isRead, isList }
```

关键文件：
- `src/utils/collapseReadSearch.ts` - 工具识别逻辑
- `src/tools.ts` - 工具注册和过滤
- `src/utils/platform.ts` - 平台检测

### 3. GrepTool (ripgrep) 已正确封装

**文件**: `src/tools/GrepTool/GrepTool.ts`

GrepTool 已经正确封装了 ripgrep，具有以下特性：
- ✅ 使用 `src/utils/ripgrep.ts` 底层封装
- ✅ 自动排除 VCS 目录（.git, .svn 等）
- ✅ 支持 `.gitignore` 模式
- ✅ 默认限制 250 条结果（防止上下文膨胀）
- ✅ 支持多种输出模式：content, files_with_matches, count
- ✅ 按修改时间排序结果

## 修复内容

### 修改的文件

**`src/tools/PowerShellTool/PowerShellTool.tsx`** (第 349-352 行)

```diff
  isEnabled(): boolean {
-   return true;
+   // PowerShell is only available on Windows platforms
+   return getPlatform() === 'windows';
  },
```

### 影响范围

1. **macOS/Linux 系统**：
   - ✅ PowerShellTool 不再被识别为可用工具
   - ✅ 搜索操作会正确使用 GrepTool (ripgrep)
   - ✅ BashTool 作为主要的 shell 工具

2. **Windows 系统**：
   - ✅ PowerShellTool 正常工作
   - ✅ 不受此修复影响

## 工具架构说明

### 核心工具接口

所有工具都遵循 `Tool` 接口（定义在 `src/Tool.ts`）：

```typescript
type Tool = {
  name: string
  isEnabled(): boolean                    // 工具是否可用
  isSearchOrReadCommand(input): {         // 是否为搜索/读取操作
    isSearch: boolean
    isRead: boolean
  }
  getPath(input): string                  // 提取操作的文件路径
  preparePermissionMatcher(input): ...    // 权限匹配器
  call(args, context, ...): Promise       // 执行工具
  // ... 其他方法
}
```

### 主要搜索/读取工具

| 工具 | 平台 | 底层实现 | 用途 |
|------|------|----------|------|
| **GrepTool** | 全平台 | ripgrep (`rg`) | 文件内容搜索 |
| **GlobTool** | 全平台 | fast-glob | 文件名匹配 |
| **FileReadTool** | 全平台 | Node.js fs | 文件读取 |
| **BashTool** | macOS/Linux | bash/zsh | Shell 命令 |
| **PowerShellTool** | Windows | PowerShell | Windows Shell 命令 |

### ripgrep 集成层次

```
GrepTool (src/tools/GrepTool/GrepTool.ts)
  ↓
ripGrep (src/utils/ripgrep.ts)
  ↓
ripgrepCommand (src/utils/ripgrep.ts)
  ↓
系统 rg / 内置 rg / 嵌入 rg
```

**ripgrep 配置模式**（`src/utils/ripgrep.ts`）：

1. **System mode**: 使用系统安装的 `rg`（如果 `USE_BUILTIN_RIPGREP` 未设置且找到系统 rg）
2. **Embedded mode**: 在打包版本中，使用 bun 内置的 rg
3. **Builtin mode**: 使用 vendored 二进制文件（`src/utils/vendor/ripgrep/`）

## 验证方法

### 1. 构建验证

```bash
bun run build
```

✅ 构建成功，无错误

### 2. 平台检测验证

在 macOS 上运行：

```typescript
import { getPlatform } from './src/utils/platform.js'
console.log(getPlatform())  // 应输出: 'macos'
```

### 3. 工具可用性验证

```typescript
import { getAllBaseTools } from './src/tools.js'
import { getPlatform } from './src/utils/platform.js'

const tools = getAllBaseTools()
const platform = getPlatform()

for (const tool of tools) {
  if (tool.name === 'PowerShell') {
    console.log(`PowerShell enabled: ${tool.isEnabled()}`)
    // macOS/Linux: 应输出 false
    // Windows: 应输出 true
  }
}
```

### 4. GrepTool 功能验证

```typescript
import { GrepTool } from './src/tools/GrepTool/GrepTool.js'

// 验证 GrepTool 正确配置
console.log('GrepTool enabled:', GrepTool.isEnabled())  // 应输出 true
console.log('GrepTool isReadOnly:', GrepTool.isReadOnly({}))  // 应输出 true
console.log('GrepTool isSearchOrReadCommand:', GrepTool.isSearchOrReadCommand({}))
// 应输出: { isSearch: true, isRead: false }
```

## 相关代码位置

### 工具定义和注册
- `src/Tool.ts` - 核心 Tool 接口定义
- `src/tools.ts` - 工具注册中心，`getAllBaseTools()`, `assembleToolPool()`
- `src/constants/tools.ts` - 工具可用性常量

### 工具实现
- `src/tools/GrepTool/GrepTool.ts` - GrepTool 实现（ripgrep 封装）
- `src/tools/PowerShellTool/PowerShellTool.tsx` - PowerShellTool 实现
- `src/tools/BashTool/BashTool.tsx` - BashTool 实现
- `src/tools/GlobTool/GlobTool.ts` - GlobTool 实现

### 工具执行和识别
- `src/services/tools/toolExecution.ts` - 工具执行引擎
- `src/utils/collapseReadSearch.ts` - 工具识别和折叠逻辑
- `src/utils/platform.ts` - 平台检测

### ripgrep 底层
- `src/utils/ripgrep.ts` - ripgrep 底层封装
  - `ripGrep()` - 主要搜索函数
  - `ripGrepStream()` - 流式搜索
  - `ripgrepCommand()` - 获取 rg 命令配置
  - `getRipgrepStatus()` - 获取 ripgrep 状态

## 后续建议

### 1. 添加 PowerShellTool 平台检查测试

```typescript
describe('PowerShellTool', () => {
  it('should be disabled on macOS', () => {
    // Mock getPlatform to return 'macos'
    expect(PowerShellTool.isEnabled()).toBe(false)
  })
  
  it('should be enabled on Windows', () => {
    // Mock getPlatform to return 'windows'
    expect(PowerShellTool.isEnabled()).toBe(true)
  })
})
```

### 2. 添加工具识别集成测试

验证在不同平台下，搜索操作能正确路由到 GrepTool 而不是 PowerShellTool。

### 3. 文档更新

在 `AGENTS.md` 或 `README.md` 中添加：
- 工具平台兼容性说明
- ripgrep 集成使用指南
- 如何添加新工具的指南

## 总结

✅ **已修复**: PowerShellTool 现在仅在 Windows 平台上启用  
✅ **已验证**: 项目构建成功  
✅ **影响**: macOS/Linux 系统将正确使用 GrepTool (ripgrep) 进行搜索操作  
✅ **兼容性**: Windows 系统不受影响，PowerShellTool 正常工作  

此修复确保了：
1. 工具识别的准确性
2. 跨平台兼容性
3. 正确使用已封装的 ripgrep 工具
4. 避免在非 Windows 系统上错误尝试使用 PowerShell
