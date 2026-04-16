# 发布版本回车键无响应问题 - 深度分析

## 问题描述

使用 `bun build --target node` 构建的发布版本 (`dist/publish/cli.js`) 在 TTY 交互模式下：
- ✅ 输入字符正常
- ✅ 删除/退格键正常
- ❌ **按回车键无响应，无法发送消息**

## 问题根源分析

### 1. 回车键处理流程

正常的回车键处理链路：

```
终端 Enter 键
  ↓ (raw mode 下)
发送 \r (0x0D, carriage return)
  ↓
stdin 'readable' 事件
  ↓
App.handleReadable() → stdin.read()
  ↓
parseKeypress(s) 解析
  ↓
s === '\r' → key.name = 'return'
  ↓
input-event.ts: parseKey()
  ↓
key.return = (keypress.name === 'return')
  ↓
useTextInput.ts: mapKey()
  ↓
case key.return → handleEnter() → onSubmit()
```

### 2. 关键代码位置

#### 2.1 回车符解析 (`src/ink/parse-keypress.ts:701-705`)

```typescript
if (s === '\r') {
  key.raw = undefined
  key.name = 'return'  // ← 这里将 \r 映射为 'return'
} else if (s === '\n') {
  key.name = 'enter'   // ← \n 映射为 'enter'（不同的名称）
}
```

#### 2.2 Key 对象构建 (`src/ink/events/input-event.ts:39`)

```typescript
const key: Key = {
  return: keypress.name === 'return',  // ← 只有 name === 'return' 时才为 true
  // ...
}
```

#### 2.3 回车处理 (`src/hooks/useTextInput.ts:366-368`)

```typescript
case key.return:
  // Must come before key.meta so Option+Return inserts newline
  return () => handleEnter(key)
```

**关键点**：只有 `key.return === true` 才会触发提交，`key.enter` 没有对应的处理逻辑！

### 3. 可能的问题原因

#### 原因 A: Bun build `--target node` 的 stdin 编码问题 (最可能)

**假设**：Bun 的构建工具在 `--target node` 模式下，可能错误地处理了 stdin 的编码或字符串比较。

**验证方法**：
1. 检查 `dist/publish/cli.js` 中 `s === '\r'` 的比较是否被正确保留
2. 在运行时打印实际接收到的字符

**可能的问题**：
- Bun 的 minifier 可能错误地转义了 `\r` 字符串
- `--target node` 模式下 stdin 的 encoding 设置可能不同
- Node.js 和 Bun 的 `setRawMode` 实现有细微差异

#### 原因 B: stdin.setEncoding('utf8') 未正确设置

在 `App.tsx:227` 有：
```typescript
stdin.setEncoding('utf8');
```

如果这行代码在构建版本中没有正确执行，stdin 可能返回 Buffer 而不是 string，导致 `s === '\r'` 比较失败。

#### 原因 C: Raw mode 未正确启用

如果 `setRawMode(true)` 在构建版本中没有正确工作：
- Terminal 会在线路模式 (line mode) 下缓冲输入
- Enter 键可能产生 `\n` 而不是 `\r`
- 或者 Enter 键被终端驱动层吞掉

#### 原因 D: Bracketed Paste 模式干扰

在 `App.tsx:273` 启用了 bracketed paste：
```typescript
this.props.stdout.write(EBP);  // CSI 200h
```

如果终端不支持或实现有 bug，paste 标记可能吞掉回车符。

### 4. 为什么删除键正常但回车不行

**删除键 (Backspace)**：
- Raw mode 下发送 `\x7f` (DEL)
- 这是单字节、无歧义的控制字符
- 解析代码：`s === '\x7f' || s === '\x1b\x7f'`

**回车键 (Enter)**：
- Raw mode 下应该发送 `\r` (0x0D)
- 但如果 raw mode 未正确启用，可能：
  - 不发送任何字符（线路模式缓冲）
  - 发送 `\n` 而不是 `\r`
  - 被终端驱动拦截

**关键差异**：
- `\x7f` 在任何模式下都是 DEL
- `\r` vs `\n` 取决于 raw mode 是否正确

## 诊断步骤

### Step 1: 验证 stdin 接收到的实际字符

创建诊断脚本 `diagnose_enter_key.mjs`（已创建），运行：

```bash
node diagnose_enter_key.mjs
```

这会显示：
- 每个按键的原始值
- 字节表示（十六进制）
- 是否检测到 `\r`

### Step 2: 检查构建输出中的关键代码

```bash
# 搜索 \r 比较
grep -o "===.\\\\r" dist/publish/cli.js | head -5

# 搜索 return 名称赋值
grep -o "name=.return" dist/publish/cli.js | head -5
```

### Step 3: 对比 dev 版本和 publish 版本

```bash
# Dev 版本 (bun run dev)
bun run dev

# Publish 版本
node dist/publish/cli.js
```

观察两者行为差异。

### Step 4: 检查 setRawMode 是否被调用

在 `App.tsx` 的 `handleSetRawMode` 中添加日志：

```typescript
handleSetRawMode = (isEnabled: boolean): void => {
  console.error('[DEBUG] handleSetRawMode called:', isEnabled)
  // ... rest of code
}
```

重新构建后运行：
```bash
node dist/publish/cli.js 2>debug.log
```

## 可能的修复方案

### 修复 1: 确保 stdin encoding 正确 (最可能有效)

在 `App.tsx` 的 `handleSetRawMode` 中，确保 encoding 设置：

```typescript
handleSetRawMode = (isEnabled: boolean): void => {
  const { stdin } = this.props;
  
  // 确保 encoding 正确设置
  stdin.setEncoding('utf8');
  
  if (isEnabled) {
    // ... existing code
    stdin.setRawMode(true);
    console.error('[DEBUG] Raw mode enabled, isRaw:', stdin.isRaw);
    // ...
  }
}
```

### 修复 2: 兼容 \r 和 \n

在 `parse-keypress.ts` 中，让 `\n` 也触发 return：

```typescript
if (s === '\r') {
  key.raw = undefined
  key.name = 'return'
} else if (s === '\n') {
  key.name = 'return'  // 改为 'return' 而不是 'enter'
}
```

**风险**：可能影响 multiline 输入的处理

### 修复 3: 添加 stdin 类型检查

在 `handleReadable` 中确保读取的是字符串：

```typescript
handleReadable = (): void => {
  try {
    let chunk;
    while ((chunk = this.props.stdin.read()) !== null) {
      // 确保 chunk 是字符串
      if (typeof chunk !== 'string') {
        chunk = chunk.toString('utf8');
      }
      this.processInput(chunk);
    }
  } catch (error) {
    // ...
  }
};
```

### 修复 4: Bun build 配置调整

修改 `scripts/build-publish.ts` 中的构建配置：

```typescript
const cmd = [
  'bun', 'build',
  './src/entrypoints/cli.tsx',
  '--target', 'node',
  '--format', 'esm',
  '--outfile', outfile,
  '--minify',
  '--packages', 'bundle',
  '--conditions', 'node',
  '--external', 'bun:*',
  // 添加以下标志
  '--no-bundle',  // 尝试不打包某些模块
]
```

或者尝试不使用 `--minify` 看是否是 minifier 的问题。

## 立即执行的诊断命令

```bash
# 1. 运行诊断脚本
node diagnose_enter_key.mjs

# 2. 检查构建输出
grep -c "setRawMode" dist/publish/cli.js
grep -c "parseKeypress" dist/publish/cli.js

# 3. 对比 dev 和 publish 版本
echo "测试 dev 版本..."
bun run dev

echo "测试 publish 版本..."
node dist/publish/cli.js

# 4. 查看 stdin 属性
node -e "
process.stdin.setRawMode(true);
console.error('isRaw:', process.stdin.isRaw);
console.error('encoding:', process.stdin.encoding);
process.stdin.on('readable', () => {
  const chunk = process.stdin.read();
  console.error('chunk:', chunk, typeof chunk, chunk?.toString('hex'));
});
"
```

## 根本原因假设

**最可能的原因**：Bun 的 `--target node` 构建模式在处理 stdin raw mode 时，与 Node.js 的运行时行为存在不兼容。

具体来说：
1. Bun 编译时可能假设 stdin 总是返回 string
2. 但 Node.js 在某些情况下可能返回 Buffer
3. 或者 `setRawMode` 的 polyfill 不完整
4. 导致 `\r` 字符没有被正确解析为 `key.name = 'return'`

## 下一步行动

1. ✅ 运行 `diagnose_enter_key.mjs` 确认 stdin 接收的字符
2. 🔍 检查 `dist/publish/cli.js` 中 `s === '\r'` 是否被正确保留
3. 🔧 尝试修复方案 1-4
4. 🧪 重新构建并测试

## 相关文件

- `src/ink/parse-keypress.ts` - 按键解析核心
- `src/ink/events/input-event.ts` - Key 对象构建
- `src/hooks/useTextInput.ts` - 回车处理逻辑
- `src/ink/components/App.tsx` - Raw mode 设置
- `scripts/build-publish.ts` - 构建配置
- `dist/publish/cli.js` - 发布版本输出

## 参考

- Node.js Readable Stream: https://nodejs.org/api/stream.html#readable-streams
- Raw mode: https://nodejs.org/api/tty.html#tty_readstream_setrawmode_mode
- Bun build: https://bun.sh/docs/bundler
