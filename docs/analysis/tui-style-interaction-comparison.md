# TUI 样式交互效果对比 — 基于代码逻辑深度分析

> 分析基于两个数据源：(1) 截图 `/private/tmp/tui_analysis_1.png` 和 `/private/tmp/tui_analysis_2.png` 的实际视觉内容；(2) ola-cc (`src/components/Spinner/*`) 和 codegraph (`src/ui/*`) 的源代码实现。

---

## 一、ola-cc Spinner 系统架构（图1/图2 共用）

### 核心组件链

```
SpinnerWithVerb → SpinnerAnimationRow → [SpinnerGlyph + GlimmerMessage + status parts]
```

**SpinnerAnimationRow** (`SpinnerAnimationRow.tsx`) — 动画引擎：
- 使用 `useAnimationFrame(intervalMs)` 驱动渲染循环
- **默认间隔 200ms (5fps)**，Agent 运行时降为 **500ms (2fps)** 以减少 commit overlap
- 每 50 次渲染采样一次 body 耗时用于 profiling
- 计算 frame、glimmerIndex、flashOpacity、tokenCounter、elapsedTime、stalledIntensity

**SpinnerGlyph** (`SpinnerGlyph.tsx`) — 字符旋转动画：
- 使用 `getDefaultCharacters()` 生成字符集，**正序+逆序** 双向循环 (`SPINNER_FRAMES`)
- `frame = Math.floor(time / 120)` → 120ms 每帧切换
- **stalled 渐变到红色**：`interpolateColor(baseRGB, ERROR_RED {r:171,g:43,b:63}, stalledIntensity)`
- **reducedMotion 模式**：静态 ● 圆点，2s 周期（1s 可见、1s dim）
- 尺寸：`width={2} height={1}` 的 Box 容器

**GlimmerMessage** (`GlimmerMessage.tsx`) — 消息文字的光晕扫过效果：
- 三种渲染模式：
  1. **requesting 模式**：glimmer 光点从左向右扫过消息文字
  2. **tool-use 模式**：全文字整体闪烁 (`flashOpacity = sin(time/1000 * PI)`)
  3. **responding 模式**：光点从右向左回扫
- 使用 `getGraphemeSegmenter()` 按 grapheme 拆分消息（支持 emoji/CJK）
- 光晕范围：`glimmerIndex ± 1` 的 3 字符宽度窗口，窗口内用 shimmerColor，窗口外用 messageColor
- **stalled 模式**：整行文字渐变到 ERROR_RED，同 SpinnerGlyph 的红色渐变逻辑

**ShimmerChar** (`ShimmerChar.tsx`) — 单字符微光效果：
- `isHighlighted = index === glimmerIndex`
- `isNearHighlight = Math.abs(index - glimmerIndex) === 1`
- 周围 ±1 字符使用 shimmerColor，其余使用 messageColor

**FlashingChar** (`FlashingChar.tsx`) — 整行闪烁字符：
- 用于 tool-use 模式的全行颜色交替
- `interpolateColor(baseRGB, shimmerRGB, flashOpacity)` RGB 平滑插值
- 当 flashOpacity > 0.5 时使用 shimmerColor，否则使用 messageColor

### Thinking shimmer（思考状态光晕）

内联于 `SpinnerAnimationRow`（不再使用独立 ThinkingShimmerText 组件）：
- **延迟 3s 后激活** (`THINKING_DELAY_MS = 3000`)
- **2s 周期正弦波** (`THINKING_GLOW_PERIOD_S = 2`)
- 颜色范围：`THINKING_INACTIVE {r:153,g:153,b:153}` ↔ `THINKING_INACTIVE_SHIMMER {r:185,g:185,b:185}`
- 即灰色↔浅灰的呼吸效果，不是 cyan/蓝色
- `thinkingOnly` 时显示 `(thinking)` 格式，否则裸文字

### 状态栏 progressive width gating

SpinnerAnimationRow 的状态部分按可用空间渐进显示：
- 优先级：spinnerSuffix → timer → tokens → thinking
- `SHOW_TOKENS_AFTER_MS = 30000`（30s 后才显示 token 计数）
- Token 计数动画：smooth increment，gap<70 时每帧 +3，gap<200 时 +15%，gap≥200 时 +50
- `leaderTokens = Math.round(displayedResponseLength / 4)`（4:1 字符/token 比率）

### Stall 检测

`useStalledAnimation(time, responseLength, hasActiveTools, reducedMotion)`：
- 当长时间无输出且无活跃工具时，spinner 和文字渐变到红色
- `stalledIntensity` 作为 0→1 的渐变系数，驱动 RGB 插值
- 颜色：`ERROR_RED {r:171, g:43, b:63}` — 一种暗红，不是纯红

---

## 二、codegraph Shimmer 进度系统（索引/安装界面）

### 架构

```
shimmer-progress.ts (主线程) → shimmer-worker.ts (Worker 线程, fs.writeSync(1,...))
```

**双线程设计的关键原因**：主线程可能被 SQLite 阻塞，Node.js worker 的 `process.stdout` 通过主线程事件循环代理，导致动画冻结。`fs.writeSync(1, ...)` 是直接 kernel syscall，绕过事件循环。

### shimmer-worker.ts — Worker 线程动画引擎

**Spinner 字符序列**：
- Unicode 模式：`['·', '✢', '✳', '✶', '✻', '✽']` — 6 帧（非 Braille 点阵！）
- ASCII 模式：`['.', '*', '+', 'x', 'o', 'O']` — 6 帧
- Windows 默认 ASCII（`CODEGRAPH_ASCII=1` 或 `process.platform === 'win32'`）
- Linux kernel console (`TERM=linux`) → ASCII
- macOS/Linux → Unicode（与 ola-cc 完全不同的字符集！）

**帧率参数**：
- `ANIM_INTERVAL = 150` ms → spinner 切换间隔
- `FRAMES_PER_GLYPH = 3` → 每字符停留 3 帧 → 450ms/字符
- 渲染 tick: `setInterval(render, 50)` → 50ms/帧 (20fps 渲染刷新)
- 实际 spinner 视觉帧率 = 150ms/(FRAMES_PER_GLYPH=3) = 每 450ms 切换一个 glyph ≈ **~2.2 fps 视觉切换**

**颜色系统 — amber-orange shimmer 渐变**（非 cyan！）：
```typescript
function shimmerColor(frame): string {
  const t = (Math.sin(frame * 2 * PI / 13) + 1) / 2;
  r = lerp(160, 251, t);  // 深琥珀 → 明橙
  g = lerp(100, 191, t);
  b = lerp(9, 36, t);     // 极低蓝色分量 → 纯暖色
  return `\x1b[38;2;${r};${g};${b}m${BOLD}`;
}
```
- **色域**：RGB(160,100,9) ↔ RGB(251,191,36) — amber 到 bright orange
- **周期**：13帧的 sin 波 → ~650ms (50ms×13) 呼吸周期
- **加粗**：`\x1b[1m` (BOLD) 同时施加

**进度条 — shimmer 独有颜色渐变条**：

```typescript
function renderBar(frame, filled, empty): string {
  // 25 字符宽的 █░░░ 条
  const shimmerPos = ((frame % 24) / 24) * (filled + 6) - 3;  // 光点在 bar 上移动
  const shimmerWidth = 3;  // 光晕宽度
  for (let i = 0; i < filled; i++) {
    const dist = Math.abs(i - shimmerPos);
    const t = Math.max(0, 1 - dist / shimmerWidth);
    // 同 amber-orange 色域，每个 █ 字符独立着色
    r = lerp(160, 251, t); g = lerp(100, 191, t); b = lerp(9, 36, t);
    bar += `\x1b[38;2;${r};${g};${b}m${BOLD}${G.barFilled}`;
  }
  bar += `${RST}${DM}${G.barEmpty.repeat(empty)}${RST}`;
}
```

**bar 字符**：
- Unicode：`barFilled = '█'`, `barEmpty = '░'`
- ASCII：`barFilled = '#'`, `barEmpty = '-'`
- bar 宽度固定 25 字符
- 光点在 bar 上移动（3字符宽度光晕），24帧循环 ≈ 1.2s/扫过

**三种显示模式**：

| 条件 | 输出格式 | 示例 |
|------|---------|------|
| `percent >= 0` | `│ glyph phaseName bar percent%` | `│ ✢ Scanning files ████░░░░░░░░░░░░░░░░░░░ 45%` |
| `count > 0` | `│ glyph phaseName... count found` | `│ ✳ Parsing code... 1,234 found` |
| 默认 | `│ glyph phaseName...` | `│ · Scanning files...` |

**阶段完成格式** (`finishPhase()`):
```typescript
`\r\x1b[K`  // 清行
`${DM}${G.rail}${RST}  ${GRN}${G.phaseDone}${RST} ${currentMessage}${detail}`
// detail = " — done" 或 " — 1,234 found"
```

完成图标：
- Unicode：`◆` (phaseDone) + ✓ (ok)
- ASCII：`*` (phaseDone) + `[OK]` (ok)
- 颜色：绿色 `\x1b[32m`

**边框字符**：
- Unicode：`│` (rail), `├──`/`└──`/`│   ` (tree 系列), `─` (hLine), `—` (dash)
- ASCII：`|`, `|--`/`\`--`/`|   `, `-`, `-`

### shimmer-progress.ts — 主线程接口

```typescript
interface ShimmerProgress {
  onProgress: (progress: IndexProgress) => void;
  stop: () => Promise<void>;
}
```

- 四个阶段：`scanning → parsing → storing → resolving`
- 进度数据：`{ phase, current, total }` → 计算 percent 或 count
- stop 时 2 秒超时强制 terminate worker

### 安装界面交互（installer/index.ts）

使用 `@clack/prompts` 库提供交互式 TUI：
- `clack.intro()` / `clack.outro()` — 会话边框
- `clack.spinner()` — clack 自带的 spinner（不同于 shimmer）
- `clack.confirm()` / `clack.select()` / `clack.multiselect()` — 交互式选择
- `clack.log.success()` / `clack.log.warn()` / `clack.log.info()` — 状态行输出
- 安装过程中使用 shimmer 进度显示索引状态

---

## 三、两图与代码的精确对照

### 图 1 — 主交互界面

图中可见的视觉元素对应代码：

| 视觉元素 | 对应代码 | 实现细节 |
|----------|---------|---------|
| 旋转 spinner 字符 | `SpinnerGlyph` → `getDefaultCharacters()` 正序+逆序 | 非 Braille ⠋ 系列，是自定义字符集双向循环 |
| spinner cyan 色 | `SpinnerGlyph` → `messageColor` theme 键 | 由 Theme 配置决定，通常是 cyan/浅蓝 |
| 文字光晕扫过 | `GlimmerMessage` → shimmerColor + glimmerIndex | requesting→左扫, tool-use→整体闪烁, responding→右扫 |
| tool-use 闪烁 | `GlimmerMessage` mode=tool-use → `flashOpacity` | `sin(time/1000 * PI)` 全行 baseColor↔shimmerColor 交替 |
| thinking 呼吸 | SpinnerAnimationRow 内联 → `thinkingShimmerColor` | 灰色↔浅灰正弦波 (RGB 153↔185)，非 cyan |
| stalled 红变 | SpinnerGlyph+GlimmerMessage → `interpolateColor(base, ERROR_RED, stalledIntensity)` | 渐变到暗红 RGB(171,43,63)，不是纯红 |
| token 计数 | SpinnerAnimationRow → smooth increment | 4:1 字符/token 比率，30s 后显示 |
| 状态括号 | `<Text dimColor>(</Text>` + `<Byline>{parts}</Byline>` + `<Text dimColor>)</Text>` | dim 灰色括号包裹状态部件 |

### 图 2 — Agent/子任务界面

图中可见的视觉元素对应代码：

| 视觉元素 | 对应代码 | 实现细节 |
|----------|---------|---------|
| Box Drawing 边框 | `formatter.ts` → `formatSubgraphTree` | `├──`, `└──`, `│   ` Unicode tree 系列 |
| ✓ 完成标记 | `glyphs.ts` → `UNICODE_GLYPHS.ok` | Unicode ✓, ASCII `[OK]` |
| ✗ 错误标记 | `glyphs.ts` → `UNICODE_GLYPHS.err` | Unicode ✗, ASCII `[ERR]` |
| ◆ 阶段完成 | `glyphs.ts` → `UNICODE_GLYPHS.phaseDone` | Unicode ◆, ASCII `*` |
| │ 竖线 rail | `glyphs.ts` → `UNICODE_GLYPHS.rail` | Unicode │, ASCII `|` |
| — dash | `glyphs.ts` → `UNICODE_GLYPHS.dash` | Unicode —, ASCII `-` |
| amber spinner | `shimmer-worker.ts` → `SPINNER_GLYPHS` | ✢/✳/✶/✻/✽ 序列 + amber-orange shimmer 色 |
| amber 进度条 | `shimmer-worker.ts` → `renderBar()` | 25字符 █░░░ 条 + 光点扫过渐变 |
| 阶段完成行 | `shimmer-worker.ts` → `finishPhase()` | `│ ◆ phaseName — done` 格式 |
| Windows 兼容 | `glyphs.ts` → `supportsUnicode()` | Windows→ASCII fallback, mojibake 防护 |

---

## 四、两个系统的核心差异对比

| 特征 | ola-cc (图1/图2 主界面) | codegraph (索引/安装界面) |
|------|------------------------|--------------------------|
| **Spinner 字符集** | 自定义字符集正序+逆序双向循环 | ✢✳✶✻✽ 6帧单向 / ASCII: .+x oO |
| **Spinner 颜色** | Theme messageColor (cyan 系列) | amber-orange 渐变 RGB(160,100,9)↔RGB(251,191,36) |
| **Spinner 帧率** | 5fps (200ms) / Agent时 2fps (500ms) | 20fps 渲染, ~2.2fps 视觉切换 (450ms/glyph) |
| **进度条** | 无（纯 spinner + 文字） | 25字符 █░░░ bar + shimmer 光点扫过 |
| **文字光晕** | GlimmerMessage 3字符窗口扫过 | 无（仅 spinner + bar） |
| **闪烁效果** | FlashingChar tool-use 全行闪烁 | shimmer 颜色 sin 波呼吸 |
| **Thinking 呼吸** | 灰色↔浅灰 (RGB 153↔185) | 无 |
| **Stalled 红变** | 渐变到 ERROR_RED (171,43,63) | 无 stalled 概念 |
| **完成标记** | figures.arrowDown/arrowUp 上下箭头 | ✓/✗/◆ + `— done` 文字 |
| **边框方式** | Ink React 组件 Box 边框 | │ rail 竖线前缀 + Box Drawing tree |
| **渲染机制** | Ink useAnimationFrame React 重渲染 | Worker 线程 fs.writeSync(1,...) 直接 syscall |
| **平台兼容** | figures 库统一处理 | 双字符集 (Unicode/ASCII) + 环境变量控制 |
| **交互模式** | 5种 (requesting/tool-input/tool-use/responding/thinking) | 3种 (percent/count/默认) |
| **Token 计数** | smooth increment + 4:1 比率 | 无（仅文件/节点计数） |
| **字体加粗** | 无 | `\x1b[1m` BOLD 施加于 shimmer 区域 |

---

## 五、TUI 设计亮点与工程权衡

### ola-cc 的设计决策

1. **React 编译器优化** — `react/compiler-runtime` (`_c` 编译缓存) 减少 Spinner 热路径重渲染
2. **50ms→200ms 降频** — 从 20fps 降到 5fps，commit 频率从 383x/turn 降到 25x/turn
3. **parent/child 分层** — SpinnerWithVerb(非动画) → SpinnerAnimationRow(动画)，外层只在 props/app 变化时重渲染
4. **progressive width gating** — 状态栏按屏幕宽度渐进显示，窄屏只显示核心信息
5. **内联 Thinking shimmer** — 原独立组件合并到 SpinnerAnimationRow，复用同一个 animationFrame 订阅，消除冗余 50ms timer

### codegraph 的设计决策

1. **Worker 线程独立渲染** — 主线程 SQLite 阻塞时动画不冻结，`fs.writeSync(1,...)` 绕过 Node 事件循环
2. **Unicode/ASCII 双字符集** — Windows OEM codepage mojibake 防护，`CODEGRAPH_ASCII=1` 逃生舱
3. **原子锁文件** — `O_EXCL` + `link()` 硬链接，daemon 仲裁无空窗口
4. **shimmer 颜色数学** — `lerp + sin` 实现无依赖的颜色渐变，纯 ANSI 24-bit color
5. **bar 光点扫过** — 进度条不是静态填充，有 3 字符宽 amber 光晕在 bar 上移动

### 共同原则

1. **零图形依赖** — 所有动效基于 Unicode 字符切换 + ANSI color escape
2. **流畅 vs 正确** — ola-cc 用 React 重渲染保证正确性，codegraph 用 raw syscall 保证流畅性
3. **dim/bright 权重** — 两系统都用 `\x1b[2m` dim 和 `\x1b[1m` bold 区分主次信息
4. **环境适配** — ola-cc 通过 Theme 系统适配，codegraph 通过 platform/env 检测适配

---

## 六、进度动画技术实现汇总

| 效果 | ola-cc 实现方式 | codegraph 实现方式 |
|------|----------------|--------------------|
| **Spinner 旋转** | getDefaultCharacters() 正序+逆序, Ink useAnimationFrame(200ms) | ✢✳✶✻✽ 6帧, Worker setInterval(50ms) |
| **颜色渐变** | interpolateColor(baseRGB, targetRGB, t) | lerp(a,b,t) + sin 波周期 |
| **文字光晕** | GlimmerMessage 3字符窗口, grapheme segmenter | 无 |
| **全行闪烁** | FlashingChar sin(time/1000*PI) | shimmerColor sin(frame*2*PI/13) |
| **进度条** | 无 | renderBar 25字符 █░░░ + 光点扫过 |
| **Thinking** | 内联 sin 波, 灰色↔浅灰 | 无 |
| **Stalled 红变** | interpolateColor → ERROR_RED | 无 |
| **完成状态** | spinner 消失, 文字变为静态 | ◆ phaseDone + `— done` |
| **平台兼容** | figures 库 | supportsUnicode() + 双字符集 |
| **线程模型** | 主线程 React 重渲染 | Worker 线程 fs.writeSync 直接 syscall |

---

## 七、TUI 效果优化设计方案

> 本节包含从 codegraph 移植 TUI 效果到 ola-cc 的具体设计方案，以及 Compact 进度条 shimmer 优化。

### 7.1 Compact 进度条 Shimmer 优化

**现状**：compact 操作的进度条使用静态 █/░ 字符（`src/components/Spinner.tsx`），无视觉反馈。

**已完成的修改**（2026-06-09）：

创建了统一 shimmer 工具库 `src/utils/shimmer.ts`，并在 `Spinner.tsx` 中集成：
- `shimmerColor(frame)` — amber-orange 渐变色计算，RGB(160,100,9) ↔ RGB(251,191,36)
- `renderShimmerBar(frame, percent, width)` — 带 shimmer 光点的进度条渲染
- 3 字符宽度光晕在进度条上移动，24 帧循环 ≈ 1.2s/扫过
- glow 边缘使用 DIM_BASE(120,120,120) 混合实现平滑亮度衰减
- 使用 `useAnimationFrame(100ms)` 驱动动画
- 未填充区域使用 dim 灰色 `░`

**效果对比**：
```
之前：  15% 正在生成摘要(缓存共享)...
       █████░░░░░░░░░░░░░░░░░░░░░░░░░  （静态灰色）

之后：  15% 正在生成摘要(缓存共享)...
       █████░░░░░░░░░░░░░░░░░░░░░░░░░  （amber shimmer 光点扫过）
```

**相关文件**：
- `src/utils/shimmer.ts` — 统一 shimmer 工具库（shimmerColor + renderShimmerBar）
- `src/utils/__tests__/shimmer.test.ts` — 19 个测试用例
- `src/components/Spinner.tsx` — 集成 shimmer 进度条 + progressFrame 动画
- `src/services/compact/compact.ts` — 进度事件发射（第 1297-1302 行）
- `src/services/compact/worker/types.ts` — `CompactProgressEvent` 接口（第 62-68 行）
- `src/screens/REPL.tsx` — 进度事件处理（第 2690-2693 行）

### 7.2 codegraph TUI 效果移植方案

**可复用的 codegraph 视觉效果**：

| 效果 | codegraph 实现 | ola-cc 移植方案 |
|------|---------------|----------------|
| Amber shimmer 渐变 | `lerp(160,251,t)` + `sin` 波 | ✅ 已复用到 shimmer.ts + ShimmerProgressBar 组件 |
| 进度条光点扫过 | `renderBar` 25-char + 3-char 光晕 | ✅ 已实现 renderShimmerBar + useAnimationFrame(100ms) |
| CodeGraph/Grok 统一 shimmer | 静态 ProgressBar | ✅ ShimmerProgressBar 替换两工具的 ProgressBar |
| 阶段完成标记 | `◆ phaseName — done` | ✅ compact 完成时 `◆ 压缩完成 — done` |
| Box Drawing 树 | `├──`/`└──`/`│` | ✅ TeammateSpinnerLine `├─`/`└─`/`╘═`/`╞═` |

**统一 shimmer 工具库**（✅ 已实现 `src/utils/shimmer.ts`）：

**ShimmerProgressBar 组件**（✅ 已实现 `src/components/design-system/ShimmerProgressBar.tsx`）：

```typescript
// CodeGraph 和 Grok 工具统一使用 ShimmerProgressBar 替代静态 ProgressBar
// ShimmerProgressBar 封装了 useAnimationFrame(100ms) + renderShimmerBar
// renderToolUseProgressMessage 返回的 React 元素树中，ShimmerProgressBar 作为子组件
// 其内部 hook 在 React 渲染管线中正常工作

// CodeGraph: React.createElement(ShimmerProgressBar, { progress, width: 16 })
// Grok:      React.createElement(ShimmerProgressBar, { progress, width: 16 })
// Compact:   renderShimmerBar(progressFrame, progress, Math.min(columns - 4, 30))
```

```typescript
// src/utils/shimmer.ts
const AMBER = { r: 160, g: 100, b: 9 }
const ORANGE = { r: 251, g: 191, b: 36 }
const DIM_BASE = { r: 120, g: 120, b: 120 }

export function shimmerColor(frame: number): { r: number; g: number; b: number } {
  // 24-frame period matches position cycle for synchronized color+position
  const t = (Math.sin(frame * 2 * Math.PI / 24) + 1) / 2
  return {
    r: Math.round(AMBER.r + (ORANGE.r - AMBER.r) * t),
    g: Math.round(AMBER.g + (ORANGE.g - AMBER.g) * t),
    b: Math.round(AMBER.b + (ORANGE.b - AMBER.b) * t),
  }
}

export function renderShimmerBar(
  frame: number,
  percent: number,
  width: number = 25
): string {
  width = Math.max(0, width)
  if (width === 0) return ''
  const clampedPercent = Math.max(0, Math.min(100, percent))
  const filled = Math.round((clampedPercent / 100) * width)
  const empty = width - filled
  const shimmerPos = ((frame % 24) / 24) * (filled + 6) - 3
  const shimmerWidth = 3
  const glowColor = shimmerColor(frame)

  let bar = ''
  for (let i = 0; i < filled; i++) {
    const dist = Math.abs(i - shimmerPos)
    const t = Math.max(0, 1 - dist / shimmerWidth)
    if (t > 0) {
      // Blend glow color with dim base for smooth edge falloff
      const r = Math.round(DIM_BASE.r + (glowColor.r - DIM_BASE.r) * t)
      const g = Math.round(DIM_BASE.g + (glowColor.g - DIM_BASE.g) * t)
      const b = Math.round(DIM_BASE.b + (glowColor.b - DIM_BASE.b) * t)
      bar += `\x1b[38;2;${r};${g};${b}m\x1b[1m█\x1b[0m`
    } else {
      bar += '█'
    }
  }
  bar += `\x1b[2m${'░'.repeat(empty)}\x1b[0m`
  return bar
}
```

### 7.3 Compact 进度数据流

**完整数据流**：
```
compact.ts (发射 CompactProgressEvent)
  → REPL.tsx onCompactProgress 回调
    → setSpinnerProgress(event.progress)
      → Spinner.tsx SpinnerWithVerbInner
        → renderProgressBar(progress, width, progressFrame)
          → amber shimmer 光点扫过效果
```

**进度阶段**：
| 阶段 | progress 范围 | message |
|------|--------------|---------|
| 缓存共享摘要 | 15% | "正在生成摘要(缓存共享)..." |
| 流式摘要 | 5%-49% | "正在生成摘要..." |
| 合并 | 50%-70% | "合并摘要..." |
| 压缩 | 71%-99% | "压缩上下文..." |
| 完成 | 100% | 清除进度条 |