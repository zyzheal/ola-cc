## Node.js 22 stdin rawMode 问题分析与修复方案

### 问题现象
使用 `bun build --target node` 构建的发布版本在 Node.js 22 环境下，进入交互页面后按回车键没有反应。

### 问题分析

#### Node.js 22 TTY 变化
Node.js 22 对 TTY ReadStream 有一些变化，可能影响 stdin 的 flowing mode 状态管理：
- `readableFlowing` 状态可能为 `null`（初始状态）
- `stdin.read()` 和 `stdin.resume()` 的交互可能有问题
- `setRawMode()` 可能影响 flowing mode 状态

#### 当前代码流程
1. `earlyInput.ts` 的 `startCapturingEarlyInput()`: 启用 rawMode，添加 readable 监听器
2. `stopCapturingEarlyInput()`: 移除监听器，禁用 rawMode
3. `App.tsx` 的 `handleSetRawMode(true)`:
   - 调用 `stopCapturingEarlyInput()`
   - drain stdin (`while(stdin.read() !== null)`)
   - `stdin.resume()`
   - `stdin.setRawMode(true)`
   - 添加 readable 监听器

#### 潜在问题点
1. **顺序问题**: `stdin.read()` 将 stdin 设置为 flowing mode，但 `stdin.resume()` 也设置 flowing mode
2. **状态竞争**: 在 Node.js 22 中，多个状态转换可能导致 stdin 处于不稳定状态
3. **监听器时机**: 在某些状态下，添加 readable 监听器后可能不会触发 flowing mode

### 修复方案

#### 方案 1: 在 setRawMode 之后调用 resume
```javascript
stdin.setRawMode(true);
stdin.resume(); // 确保在 rawMode 启用后 stdin 处于 flowing mode
stdin.addListener('readable', this.handleReadable);
```

#### 方案 2: 使用 pause/resume 循环重置状态
```javascript
// 在 setRawMode 之前重置状态
stdin.pause();
stdin.resume();
stdin.setRawMode(true);
stdin.addListener('readable', this.handleReadable);
```

#### 方案 3: 使用 data 事件替代 readable 事件
使用 `data` 事件监听器，它会自动触发 flowing mode：
```javascript
stdin.setRawMode(true);
stdin.on('data', this.handleData);
```

### 推荐修复

最可靠的修复是在 `setRawMode(true)` 之后调用 `stdin.resume()`，确保 stdin 正确进入 flowing mode：

```typescript
// src/ink/components/App.tsx handleSetRawMode 函数
stdin.setRawMode(true);
stdin.resume(); // 确保在 rawMode 启用后 stdin 处于 flowing mode
stdin.addListener('readable', this.handleReadable);
```

### 测试方法
运行诊断脚本验证修复：
```bash
node scripts/diag-node22-stdin.js
```