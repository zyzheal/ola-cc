# 回车键无响应 - 完整诊断指南

## 问题状态

✅ **代码修复已应用**: `inputToString()` 已改为 `buffer.toString('utf8')`  
✅ **构建成功**: dist/publish/cli.js 已重新构建  
✅ **代码验证**: 构建输出中包含 21 次 `.toString('utf8')` 调用  

## 可能的原因

既然代码修复已正确应用，回车键仍然无效可能是以下原因：

### 原因 1: 终端发送的是 `\n` 而不是 `\r`

**诊断方法**:
```bash
node deep_diagnose_enter.mjs
```

**预期输出**:
- 如果 Enter 产生 `\r` (0x0D): ✅ 终端正确
- 如果 Enter 产生 `\n` (0x0A): ⚠️ 终端配置问题

**解决方案**:
检查终端配置，确保在 raw mode 下发送 `\r`。

### 原因 2: stdin encoding 未正确设置

**检查点**: `App.tsx` 第 227 行
```typescript
stdin.setEncoding('utf8');
```

**诊断**:
在发布版本中添加调试日志，确认 encoding 设置。

### 原因 3: Raw mode 未正确启用

**检查点**: 
- `stdin.isRaw` 应该为 `true`
- `setRawMode(true)` 应该成功调用

**诊断**:
```bash
node deep_diagnose_enter.mjs
```

查看输出中的 `stdin.isRaw` 值。

### 原因 4: 组件未正确处理 `key.return`

**可能位置**:
- `src/components/PromptInput/PromptInput.tsx`
- `src/hooks/useTextInput.ts`

**检查**:
确认 `key.return` 被正确传递到处理函数。

## 诊断步骤

### Step 1: 运行深度诊断

```bash
node deep_diagnose_enter.mjs
```

**观察**:
1. Buffer 转换是否正确
2. Enter 键产生的实际字符
3. stdin.isRaw 的值

### Step 2: 测试发布版本

```bash
node dist/publish/cli.js
```

**测试**:
1. 输入一些文字
2. 按 Enter
3. 观察是否有反应

### Step 3: 添加调试日志

如果上述步骤无法定位问题，在源代码中添加调试日志：

**文件**: `src/ink/parse-keypress.ts`

在 `parseKeypress` 函数开头添加：

```typescript
export function parseKeypress(s: string): ParsedKey {
  // 调试日志
  if (s === '\r' || s === '\n') {
    console.error('[DEBUG] parseKeypress received:', JSON.stringify(s), 'charCode:', s.charCodeAt(0))
  }
  // ... rest of function
}
```

**文件**: `src/ink/components/App.tsx`

在 `handleReadable` 函数中添加：

```typescript
handleReadable = (): void => {
  // ...
  while ((chunk = this.props.stdin.read() as string | null) !== null) {
    // 调试日志
    if (typeof chunk === 'string' && (chunk.includes('\r') || chunk.includes('\n'))) {
      console.error('[DEBUG] stdin chunk:', JSON.stringify(chunk))
    }
    this.processInput(chunk);
  }
}
```

然后重新构建：

```bash
bun run scripts/build-publish.ts
node dist/publish/cli.js 2>debug.log
```

### Step 4: 检查终端兼容性

某些终端可能在 raw mode 下行为不同：

**测试不同终端**:
- macOS Terminal
- iTerm2
- Ghostty
- Kitty
- xterm

## 已知的工作配置

### 开发版本 (工作正常)

```bash
bun run dev
```

- 构建目标: `--target bun`
- 运行时: Bun
- stdin 处理: Bun 原生

### 发布版本 (修复后应该工作)

```bash
node dist/publish/cli.js
```

- 构建目标: `--target node`
- 运行时: Node.js
- stdin 处理: Node.js Stream

## 如果问题仍然存在

### 收集诊断信息

运行以下命令并保存输出：

```bash
# 1. 深度诊断
node deep_diagnose_enter.mjs > diagnose_output.txt 2>&1

# 2. 发布版本诊断
node diagnose_publish.mjs >> diagnose_output.txt 2>&1

# 3. 系统信息
echo "---" >> diagnose_output.txt
echo "Node.js version: $(node --version)" >> diagnose_output.txt
echo "Platform: $(uname -s)" >> diagnose_output.txt
echo "Terminal: $TERM_PROGRAM" >> diagnose_output.txt
```

### 临时解决方案

如果急需使用，可以尝试：

**方案 1**: 使用开发版本
```bash
bun run dev
```

**方案 2**: 修改 parse-keypress.ts 兼容 `\n`

```typescript
if (s === '\r') {
  key.raw = undefined
  key.name = 'return'
} else if (s === '\n') {
  // 临时：也映射为 return
  key.raw = undefined
  key.name = 'return'
}
```

## 技术细节

### 回车键处理流程

```
终端 Enter 键
  ↓
发送 \r (0x0D) 或 \n (0x0A)
  ↓
stdin 'readable' 事件触发
  ↓
App.handleReadable() 调用 stdin.read()
  ↓
返回字符串 (因为 setEncoding('utf8'))
  ↓
processInput(chunk)
  ↓
parseMultipleKeypresses(state, input)
  ↓
inputToString(input) - 如果是 Buffer 则转换
  ↓
tokenizer.feed(inputString)
  ↓
tokens: [{ type: 'text', value: '\r' }]
  ↓
parseKeypress('\r')
  ↓
s === '\r' → key.name = 'return'
  ↓
ParsedKey { name: 'return', ... }
  ↓
input-event.ts: parseKey()
  ↓
key.return = true, input = ''
  ↓
useTextInput.ts: mapKey()
  ↓
case key.return → handleEnter()
  ↓
onSubmit()
```

### 关键检查点

1. ✅ stdin.setEncoding('utf8') - App.tsx:227
2. ✅ stdin.setRawMode(true) - App.tsx:266
3. ✅ inputToString() - parse-keypress.ts:196-211
4. ✅ s === '\r' 比较 - parse-keypress.ts:703
5. ✅ key.return 设置 - input-event.ts:39
6. ✅ case key.return - useTextInput.ts:366

## 总结

代码修复已正确应用并构建。如果回车键仍然无效，问题可能在于：

1. **终端配置**: 终端可能发送 `\n` 而不是 `\r`
2. **运行时环境**: Node.js 的 stdin 行为可能与 Bun 不同
3. **组件处理**: 某个组件可能未正确响应 `key.return`

请运行诊断脚本并收集输出，以便进一步分析问题。

---

诊断指南创建时间：2026年4月16日
