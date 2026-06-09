# CodeGraph Init TUI 进度集成方案

> 日期: 2026-06-05 | 修正: 2026-06-05
> 基于 codegraph v0.9.6 shimmer-worker 深度分析
> **状态: ✅ 已实施** — 3 处代码修改已全部到位

---

## 一、问题根因 (已修复)

> **修正说明**: 原文称 "runCodegraph 只监听 stderr"，经代码验证该问题已修复。当前代码同时监听 stdout 和 stderr，两者都通过 `onStderr` 回调转发。以下为修改前的原始根因描述，保留作为历史记录。

codegraph 的进度信息通过 **shimmer-worker** (独立 worker 线程) 直接写入 **stdout fd 1** (`fs.writeSync(1, ...)`)

~~ola-cc 的 `CodegraphManager.runCodegraph()` 只监听 **stderr** 的 `onStderr` 回调~~ (已修复)

**修改前状态**: 进度数据流断裂 — shimmer 输出被收集到 `stdoutChunks` 但从未解析

**修改后状态**: stdout 行缓冲 → `onStderr` 回调 → `parseCodegraphStderr` 解析 → `sendProgress` → `renderToolUseProgressMessage` 渲染。解析链已贯通。

---

## 二、codegraph shimmer 4 阶段进度格式

### 阶段定义 (shimmer-progress.js:39-44)

| 阶段 | 显示名 | 有百分比 | 说明 |
|------|--------|:---:|------|
| scanning | Scanning files | ❌ | 显示已发现文件数 |
| parsing | Parsing code | ✅ | tree-sitter 解析进度 |
| storing | Storing data | ✅ | SQLite 写入进度 |
| resolving | Resolving refs | ✅ | 引用解析进度 |

### 输出格式 (通过 writeSync(1, ...) 写 stdout)

**进行中** (原地刷新 \r\x1b[K):
```
│  ✶ Scanning files... 1,234 found
│  ✶ Parsing code  ████████░░░░░░░░░░░░░░░░░  42%
```

**完成** (换行后不再修改):
```
│  ◆ Scanning files — 1,234 found
│  ◆ Parsing code — done
```

### 视觉特性

- spinner: `['·', '✢', '✳', '✶', '✻', '✽']`, 每 3 帧切换, 150ms 间隔
- 进度条: 25 字符宽, `█` 填充 + `░` 空白
- shimmer 颜色: 橙色 (160,100,9) → 亮橙 (251,191,36) 循环
- 渲染频率: 50ms/帧
- ASCII 回退: Windows 或 `CODEGRAPH_ASCII=1` 时用 `#`/`-`/`|`/`*`

---

## 三、ola-cc 当前状态

### 已有基础设施

- `parseCodegraphStderr()` — 能识别 5 种格式 (done/scanDone/scan/百分比/纯文本) ✅ 已扩展
- `renderToolUseProgressMessage()` — 进度条渲染组件，支持 count 字段 ✅ 已扩展
- `onStderrProgress` 回调链 — CodegraphTool → CodegraphManager
- `runCodegraph` — 同时监听 stdout 和 stderr ✅ 已修复

### 断层点 (修改前，已全部修复)

1. ~~`runCodegraph` 的 `onStderr` 只处理 stderr, shimmer 写 stdout~~ → ✅ 已修复，stdout 行缓冲转发给 `onStderr`
2. ~~`stdoutChunks` 收集了 shimmer 输出但从未解析~~ → ✅ 已修复，实时行缓冲解析
3. ~~`parseCodegraphStderr` 永远收不到实际进度数据~~ → ✅ 已修复，解析链贯通
4. ~~`sendProgress` 只发送固定文本, 无百分比~~ → ✅ 已修复，支持百分比和文件计数

---

## 四、集成方案 (方案 A: 解析 stdout shimmer 输出)

### 修改 1: CodegraphManager.ts — runCodegraph 新增 stdout 行缓冲

```typescript
// 在 child.stdout.on('data') 中新增行缓冲解析
let stdoutLineBuffer = '';
child.stdout.on('data', (data: Buffer) => {
  stdoutChunks.push(data);
  totalStdoutBytes += data.length;
  if (totalStdoutBytes > MAX_OUTPUT_BYTES) {
    child.kill('SIGKILL');
    timedOut = true;
  }
  // 新增: stdout 行缓冲传递给 onStderr 回调
  if (onStderr) {
    stdoutLineBuffer += data.toString();
    const lines = stdoutLineBuffer.split('\n');
    stdoutLineBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        try { onStderr(trimmed); } catch { /* ignore */ }
      }
    }
  }
});
```

### 修改 2: CodegraphTool.ts — parseCodegraphStderr 增加 scanning 格式

```typescript
// 新增: 匹配 "Scanning files... 1,234 found"
const scanMatch = clean.match(/([\w\s]+?)\.{3}\s*([\d,]+)\s*found/i);
if (scanMatch) {
  return {
    stage: scanMatch[1].trim(),
    progress: null,
    count: parseInt(scanMatch[2].replace(/,/g, ''), 10),
  };
}

// 新增: 匹配 "◆ Scanning files — 1,234 found"
const scanDoneMatch = clean.match(/[◆✶]\s*([\w\s]+?)\s*[—–-]\s*([\d,]+)\s*found/i);
if (scanDoneMatch) {
  return {
    stage: scanDoneMatch[1].trim(),
    progress: 100,
    count: parseInt(scanDoneMatch[2].replace(/,/g, ''), 10),
  };
}
```

### 修改 3: renderToolUseProgressMessage 支持文件计数

```typescript
// 在 scanning 阶段显示文件计数而非百分比
if (step.count != null) {
  return `CodeGraph · ${step.stage} ${step.count.toLocaleString()} found`;
}
```

---

## 五、预期效果

**修改前**:
```
CodeGraph · Init Initializing CodeGraph index...  (静态文本, 无进度)
```

**修改后**:
```
CodeGraph · Scanning files 1,234 found            (实时文件计数)
CodeGraph · Parsing code [████████░░░░░░] 42%     (百分比进度条)
CodeGraph · Storing data [████████████░░] 85%     (百分比进度条)
CodeGraph · Resolving refs [██████████░░░] 78%    (百分比进度条)
CodeGraph · Done                                   (完成)
```

Verbose 模式 (Ctrl+O) 额外显示:
```
✓ Scanning files — 1,234 found
✓ Parsing code — done
▸ Storing data [████████████░░] 85%
○ Resolving refs
```

---

## 六、修改文件清单

| 文件 | 修改内容 | 代码量 | 状态 |
|------|---------|--------|:---:|
| `src/tools/CodegraphTool/CodegraphManager.ts` | runCodegraph 新增 stdout 行缓冲 | ~15 行 | ✅ 已实施 |
| `src/tools/CodegraphTool/CodegraphTool.ts` | parseCodegraphStderr 新增 scanning 格式 | ~15 行 | ✅ 已实施 |
| `src/tools/CodegraphTool/CodegraphTool.ts` | renderToolUseProgressMessage 支持 count | ~5 行 | ✅ 已实施 |

**总计: ~35 行代码修改 — 全部已实施**
