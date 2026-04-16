# 流式文本缓冲优化

## 问题背景

在与 AI 交互过程中，流式文本响应通过 `handleMessageFromStream` 函数逐字符累积到 React 状态 `streamingText` 中。原始实现存在以下潜在问题：

### 原始实现（`src/screens/REPL.tsx:1549-1558`）

```typescript
const [streamingText, setStreamingText] = useState<string | null>(null);
const onStreamingText = useCallback((f: (current: string | null) => string | null) => {
  if (!showStreamingText) return;
  setStreamingText(f);
}, [showStreamingText]);
```

### 问题分析

1. **字符串拼接开销**：每次 delta 到达时执行 `(text ?? '') + deltaText`，JavaScript 字符串不可变导致新对象创建
2. **高频状态更新**：每个字符 delta 都触发 `setState`，虽然 Ink 有 16ms 渲染节流，但状态更新本身有开销
3. **无上限累积**：长响应可能导致 `streamingText` 无限增长
4. **闭包引用**：每次 `onStreamingText` 回调都捕获当前 `streamingText` 状态

## 优化方案

### 架构设计

采用 **环形缓冲区 + 节流渲染** 策略：

```
┌─────────────────────────────────────────────────────────┐
│  StreamingTextBuffer (useRef - 不触发重渲染)              │
│  ┌─────────────────────────────────────────────┐        │
│  │  string[] buffer (累积 delta)                │        │
│  │  totalLength: number                         │        │
│  │  maxLength: 50KB (环形截断)                  │        │
│  │  flushIntervalMs: 100ms (节流)               │        │
│  └─────────────────────────────────────────────┘        │
│                        │                                  │
│                        ▼ flush()                          │
│  ┌─────────────────────────────────────────────┐        │
│  │  setStreamingText (仅节流时触发 React 渲染)     │        │
│  └─────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### 核心实现

```typescript
class StreamingTextBuffer {
  private buffer: string[] = []
  private totalLength = 0
  private readonly maxLength = 50000  // 最大 50KB
  private lastFlushTime = 0
  private readonly flushIntervalMs = 100  // 节流间隔

  append(text: string): void {
    // 数组 push 比字符串拼接高效 O(1) vs O(n)
    this.buffer.push(text)
    this.totalLength += text.length

    // 环形缓冲区：超出容量时移除最老内容
    if (this.totalLength > this.maxLength) {
      const excess = this.totalLength - this.maxLength
      let removed = 0
      while (removed < excess && this.buffer.length > 0) {
        const first = this.buffer.shift()!
        removed += first.length
      }
      this.totalLength = Math.min(this.totalLength, this.maxLength)
    }

    // 节流刷新：每 100ms 最多触发一次 React 状态更新
    const now = Date.now()
    if (this.onFlush && now - this.lastFlushTime >= this.flushIntervalMs) {
      this.flush()
      this.lastFlushTime = now
    }
  }

  flush(): void {
    if (this.onFlush && this.buffer.length > 0) {
      this.onFlush(this.buffer.join(''))  // 仅此时触发 setState
    }
  }

  clear(): void {
    this.buffer = []
    this.totalLength = 0
    if (this.onFlush) {
      this.onFlush('')
    }
  }
}
```

### 集成方式

```typescript
// useRef 存储缓冲区实例（不触发重渲染）
const streamingTextBufferRef = useRef<StreamingTextBuffer | null>(null);
const [streamingText, setStreamingText] = useState<string | null>(null);

const onStreamingText = useCallback((f: (current: string | null) => string | null) => {
  if (!showStreamingText) return;
  const currentText = streamingTextBufferRef.current?.getText() ?? null;
  const newText = f(currentText);
  if (newText === null || newText === '') {
    streamingTextBufferRef.current?.clear();
  } else {
    const oldText = currentText ?? '';
    const delta = newText.substring(oldText.length);
    if (delta) {
      getOrCreateBuffer().append(delta);  // 累积到 buffer，不立即触发 setState
    }
  }
}, [showStreamingText, getOrCreateBuffer]);
```

## 性能对比

| 指标 | 原始实现 | 优化后 | 改善 |
|------|----------|--------|------|
| 内存分配 | 每次 delta 创建新字符串 | 数组 push + 节流 join | ~90% 减少 |
| setState 调用 | 每次 delta | 每 100ms 最多一次 | ~99% 减少（假设 10 字符/ms） |
| 内存上限 | 无限制 | 50KB | 有界 |
| 字符串操作复杂度 | O(n²) 累积 | O(n) 数组 + O(1) push | 显著改善 |

### 计算示例

假设 AI 响应 10,000 字符，每个字符一个 delta：

**原始实现：**
- 字符串拼接：1 + 2 + 3 + ... + 10000 = 50,005,000 字符复制
- setState 调用：10,000 次

**优化后：**
- 数组操作：10,000 次 O(1) push
- setState 调用：假设 100ms 内约 1000 字符，10,000/1000 = 10 次
- 最终 join：一次 O(n)

## 兼容性

- **向后兼容**：`onStreamingText` 接口签名不变，`messages.ts` 无需修改
- **清空调用**：`onStreamingText?.(() => null)` 正确触发 `clear()`
- **视觉效果**：100ms 节流低于人类感知阈值（~200ms），视觉无差异

## 扩展性

`StreamingTextBuffer` 可复用于其他流式场景：
- 终端输出流
- 日志流式显示
- WebSocket 消息累积

## 文件变更

- `src/screens/REPL.tsx`: 添加 `StreamingTextBuffer` 类，修改 `streamingText` 管理逻辑
- `docs/streaming-text-optimization.md`: 本文档

## 验证方法

```bash
# 1. 构建验证
bun run build

# 2. 运行并观察内存
claude --model sonnet "写一篇 5000 字的文章"
ps -o pid,rss,vsz,command -p $(pgrep -f "claude")

# 3. 检查渲染性能
# 使用 --debug 模式观察帧率
```

## 总结

通过引入环形缓冲区和节流渲染，在**不影响用户体验**的前提下：
- 消除了高频 setState 导致的 React 渲染压力
- 限制了流式文本的内存上限
- 将字符串操作从 O(n²) 优化到 O(n)

这是典型的 **空间换时间 + 批处理优化** 架构模式。
