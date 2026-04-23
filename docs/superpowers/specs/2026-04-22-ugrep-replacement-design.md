---
name: ugrep-replacement-design
description: Design for replacing ripgrep with ugrep on Windows platform only, keeping ripgrep as fallback and on all other platforms
type: project
---

# GrepTool ugrep 替换设计 (Windows 平台)

## 背景

上游 Claude Code 2.1.117 将 Glob/Grep 工具替换为内置 bfs/ugrep。本项目已用 BFS 替代 glob，仅剩 GrepTool 的搜索引擎替换需求。

**关键发现**：ugrep 仅在 GitHub releases 提供 `ugrep-windows-x64.zip`（及可能的 win32-arm64），无 darwin/linux 预编译二进制。ripgrep 全平台覆盖。

**决策**：Windows 平台优先使用 ugrep，其他平台保持 ripgrep 不变。

## 架构

```
GrepTool.call()
    │
    ▼
unifiedSearch() ── 引擎选择
    │
    ├─ Windows → ugrepBinary() ──→ ripgrep fallback
    │
    └─ 非 Windows → ripGrep() (现有逻辑不变)
```

## 文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/utils/searchEngine.ts` | **新增** | unifiedSearch 入口、参数翻译、输出归一化 |
| `src/tools/GrepTool/GrepTool.ts` | **修改** | `ripGrep()` → `unifiedSearch()` |
| `vendor/ugrep/` | **新增** | Windows ugrep 二进制分发 |
| `scripts/build-publish-bin.ts` | **修改** | Windows 构建时下载 ugrep 到 vendor/ |
| 其他文件 | 不变 | 所有非 Windows 平台保持 ripgrep |

## ugrep → ripgrep 参数翻译表

| ripgrep flag | ugrep 等价 | 处理方式 | 备注 |
|---|---|---|---|
| `--hidden` | `--hidden` | 直传 | 两者行为一致 |
| `--glob PAT` | `-g PAT` | 替换 | ugrep 用 `-g` |
| `--glob !PAT` | `-g !PAT` | 替换 | 排除语法兼容 |
| `--max-columns N` | (删除) | 跳过 | ugrep `--width` 语义不同 |
| `-U` | (删除) | 跳过 | ugrep 默认支持多行 |
| `--multiline-dotall` | `--dotall` | 替换 | |
| `-j 1` | `-J 1` | 替换 | ugrep 短 flag 是 `-J` |
| `--sort=modified` | (删除) | 跳过 | 后处理排序 |
| `--type TYPE` | `-t TYPE` | 替换 | |
| `--no-ignore` | `--ignore-files` | 替换 | 语义相反，ugrep 默认不读 .gitignore |
| `-c` | `-c --min-count=1` | 追加 | ugrep 默认包含 0-match |
| (无 `-r`) | 加 `-r` | 追加 | ugrep 不默认递归 |
| `-l` | `-l` | 直传 | |
| `-n` | `-n` | 直传 | |
| `-i` | `-i` | 直传 | |
| `-B/-A/-C` | `-B/-A/-C` | 直传 | |
| `-e PAT` | `-e PAT` | 直传 | |

## 输出归一化

ugrep 输出在标准模式下与 ripgrep 兼容（`file:line:content` / `file:count` / 文件名列表）。

**需要处理的差异**：
1. count 模式过滤 `:0$` 行（`--min-count=1` 已处理）
2. ugrep 默认不读 `.gitignore` → 通过 `--ignore-files` 开启

**不需要处理**：
1. ANSI 颜色码 — 两者非 TTY 下默认都不输出
2. 路径格式 — 都使用 `file:line:content` 格式
3. CRLF — Windows 上两者行为一致

## 引擎选择

```typescript
function canUseUgrep(): boolean {
  // ugrep only available for Windows x64
  return process.platform === 'win32' && process.arch === 'x64'
}

async function unifiedSearch(args: string[], target: string, signal: AbortSignal): Promise<string[]> {
  if (canUseUgrep()) {
    try {
      const ugrepResults = await ugrepBinary(args, target, signal)
      return ugrepResults
    } catch (err) {
      logFallbackEvent('ugrep', 'ripgrep', err)
      return ripGrep(args, target, signal)
    }
  }
  // Non-Windows or Windows ARM64: use existing ripgrep logic
  return ripGrep(args, target, signal)
}
```

## 二进制分发

**Windows ugrep 来源**：
```
https://github.com/Genivia/ugrep/releases/download/v7.7.0/ugrep-windows-x64.zip
```

**vendor 目录结构**：
```
vendor/
├── ripgrep/           # 现有（全平台）
│   ├── x64-win32/rg.exe
│   ├── arm64-win32/rg.exe
│   ├── arm64-darwin/rg
│   └── ...
└── ugrep/             # 新增（仅 Windows x64）
    └── x64-win32/ugrep.exe
```

**注意**：ugrep 不提供 ARM64 二进制，`win32-arm64` 组合自动走 ripgrep 路径。

**许可证**：ugrep 使用 BSD-3-Clause，与项目兼容，允许商业分发。

## PCRE 处理

不做 PCRE 预检。ugrep 默认使用 POSIX ERE，不支持 lookbehind/backreferences 等特性。如果 ugrep 因 regex 错误失败，自动 fallback 到 ripgrep（ripgrep 默认引擎支持更广的 regex 语法）。

## 测试策略

| 测试 | 方法 | 平台 |
|------|------|------|
| 参数翻译 | 单元测试 translateRgToUgrep() | 任意 |
| 输出归一化 | 单元测试 normalizeOutput() | 任意 |
| ugrep 输出对比 | 集成测试：同一 pattern 对比 ugrep vs rg | Windows CI |
| fallback 链路 | 重命名 vendor binary 模拟失败 | Windows CI |
| GrepTool 不变性 | 端到端测试确保修改后输出一致 | Windows CI |

## 风险

1. **ugrep 二进制大小** — 约 5-7MB 未压缩，影响 npm 包大小（可接受）
2. **Windows ARM64** — ugrep 不提供预编译 ARM64 二进制，该组合保持 ripgrep
3. **参数翻译遗漏** — 通过 GrepTool 逐行验证已覆盖所有实际使用的 flag
4. **ugrep regex 引擎差异** — 通过 fallback 机制缓解
