# 回车键无响应 - 修复方案

## 根本原因

经过深度代码分析，问题定位在 `src/ink/parse-keypress.ts` 的 `inputToString` 函数。

### 问题代码 (第 196-211 行)

```typescript
function inputToString(input: Buffer | string): string {
  if (Buffer.isBuffer(input)) {
    if (input[0]! > 127 && input[1] === undefined) {
      ;(input[0] as unknown as number) -= 128
      return '\x1b' + String(input)  // ← 问题：String(Buffer) 在 Node.js 下可能不正确
    } else {
      return String(input)  // ← 问题：应该用 input.toString('utf8')
    }
  } else if (input !== undefined && typeof input !== 'string') {
    return String(input)
  } else if (!input) {
    return ''
  } else {
    return input
  }
}
```

### 问题分析

1. **Buffer 转换问题**：
   - `String(buffer)` 在 Bun 和 Node.js 下行为可能不同
   - 应该使用 `buffer.toString('utf8')` 确保正确的 UTF-8 解码
   - 在 raw mode 下，Enter 键产生单字节 `\r` (0x0D)
   - `String(Buffer.from('\r'))` 可能不会正确解码为 `'\r'`

2. **为什么删除键正常**：
   - 删除键发送 `\x7f` (DEL)，也是单字节
   - 但如果 Buffer 转换有问题，应该也受影响
   - **除非**：`String(buffer)` 对某些字节范围处理正确，对 `\r` 处理不正确

3. **为什么在 `--target bun` 下正常**：
   - Bun 的 `String(Buffer)` 实现可能与 Node.js 不同
   - Bun 可能内部做了正确的转换

### 影响链路

```
Enter 键
  ↓
Terminal 发送 \r (0x0D)
  ↓
stdin.read() 返回 Buffer([0x0D]) 或 '\r'
  ↓
inputToString(buffer) 调用 String(buffer)
  ↓
❌ 可能返回 '\r' 或其他值（取决于运行时）
  ↓
parseKeypress(s) 检查 s === '\r'
  ↓
❌ 如果不匹配，key.name 不会被设置为 'return'
  ↓
key.return = false
  ↓
useTextInput 不触发 handleEnter
  ↓
❌ 消息无法发送
```

## 修复方案

### 修复 1: 修正 inputToString 函数 (推荐)

**文件**: `src/ink/parse-keypress.ts`

```typescript
function inputToString(input: Buffer | string): string {
  if (Buffer.isBuffer(input)) {
    // 使用正确的 UTF-8 解码，而不是 String(buffer)
    if (input[0]! > 127 && input[1] === undefined) {
      ;(input[0] as unknown as number) -= 128
      return '\x1b' + input.toString('utf8')
    } else {
      return input.toString('utf8')
    }
  } else if (input !== undefined && typeof input !== 'string') {
    return String(input)
  } else if (!input) {
    return ''
  } else {
    return input
  }
}
```

**改动**：
- `String(input)` → `input.toString('utf8')` (对于 Buffer 类型)

**理由**：
- `buffer.toString('utf8')` 是 Node.js 和 Bun 都支持的标准方法
- 确保字节被正确解码为字符串
- `String(buffer)` 的行为在不同运行时可能不一致

### 修复 2: 同时在 App.tsx 中确保 stdin encoding

**文件**: `src/ink/components/App.tsx` (第 227 行附近)

```typescript
handleSetRawMode = (isEnabled: boolean): void => {
  const { stdin } = this.props;
  
  // 确保 encoding 设置为 utf8
  stdin.setEncoding('utf8');
  
  if (isEnabled) {
    // ... existing code
  }
}
```

**添加调试日志**（临时）：

```typescript
handleReadable = (): void => {
  // ...
  try {
    let chunk;
    while ((chunk = this.props.stdin.read() as string | null) !== null) {
      // 添加类型检查
      if (typeof chunk !== 'string') {
        console.error('[DEBUG] chunk is not string:', typeof chunk, chunk);
        chunk = chunk.toString('utf8');
      }
      this.processInput(chunk);
    }
  } catch (error) {
    // ...
  }
}
```

### 修复 3: 兼容 \r 和 \n (备选)

如果修复 1 不够，可以在 `parse-keypress.ts` 中让 `\n` 也触发 return：

```typescript
if (s === '\r') {
  key.raw = undefined
  key.name = 'return'
} else if (s === '\n') {
  // 在 raw mode 下，某些终端/运行时可能发送 \n 而不是 \r
  // 将其也映射为 return 以兼容
  key.raw = undefined
  key.name = 'return'  // 改为 'return' 而不是 'enter'
}
```

**风险**：可能影响 multiline 输入，需要测试

## 实施步骤

### Step 1: 应用修复 1

```bash
# 编辑 src/ink/parse-keypress.ts
# 将第 200 行和第 202 行的 String(input) 改为 input.toString('utf8')
```

### Step 2: 重新构建

```bash
# 重新构建发布版本
bun run scripts/build-publish.ts
```

### Step 3: 测试

```bash
# 测试发布版本
node dist/publish/cli.js

# 对比 dev 版本
bun run dev
```

### Step 4: 验证

如果修复成功：
- ✅ 回车键可以正常发送消息
- ✅ 删除键仍然正常
- ✅ 其他按键正常
- ✅ 在 Node.js 和 Bun 下都正常工作

## 诊断验证

如果修复后仍有问题，运行诊断脚本：

```bash
node diagnose_enter_key.mjs
```

检查输出：
1. Enter 键是否产生 `\r`？
2. `stdin.isRaw` 是否为 `true`？
3. chunk 的类型是 string 还是 Buffer？

## 相关文件

- `src/ink/parse-keypress.ts:196-211` - inputToString 函数（修复目标）
- `src/ink/parse-keypress.ts:701-705` - 回车符解析
- `src/ink/components/App.tsx:227` - stdin encoding 设置
- `src/ink/components/App.tsx:396-430` - handleReadable 处理
- `scripts/build-publish.ts` - 构建配置

## 技术背景

### Buffer.toString vs String(Buffer)

```typescript
// 正确的方式
const buf = Buffer.from([0x0D])  // \r 的字节码
const str = buf.toString('utf8')  // '\r'

// 可能不一致的方式
const str2 = String(buf)  // 可能是 '\r'，也可能是其他表示
```

在 Node.js 中：
- `Buffer.toString('utf8')` 是标准的解码方法
- `String(buffer)` 可能返回字面表示如 `<Buffer 0d>`

在 Bun 中：
- 两者可能都工作，但行为可能与 Node.js 不同

### Raw Mode 下的字符编码

在 raw mode 下：
- 每个按键立即发送，不经过线路规程
- Enter 键发送 `\r` (0x0D, carriage return)
- Backspace 发送 `\x7f` (DEL) 或 `\x08` (BS)
- 这些都是单字节，需要正确解码

## 总结

**根本原因**：`inputToString` 函数使用 `String(buffer)` 而不是 `buffer.toString('utf8')`，导致在 Node.js 运行时下 Buffer 到 String 的转换不正确。

**修复方法**：将 Buffer 转换改为标准的 `buffer.toString('utf8')` 方法。

**影响范围**：只影响发布版本（`--target node`），dev 版本（`--target bun`）不受影响。
