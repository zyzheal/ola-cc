# NPM 发布总结 - v0.0.16

## ✅ 发布成功

**包名**: `@zyzheal/ola-cc`  
**版本**: `0.0.16`  
**发布时间**: 2026年4月16日  
**发布标签**: `latest`

## 📦 包信息

```
名称: @zyzheal/ola-cc
版本: 0.0.16
文件名: zyzheal-ola-cc-0.0.16.tgz
包大小: 14.8 MB
解压大小: 40.4 MB
SHA: 46df8ef6e8956639543ad22189b14cc82e49f300
文件数: 19
```

## 🎯 本次更新内容

### 主要修复

**修复**: 发布版本在 Node.js 运行时下回车键无响应

**根本原因**: 
- `inputToString()` 函数使用 `String(buffer)` 在 Node.js 和 Bun 下行为不一致
- Raw mode 下 Enter 键发送的 `\r` (0x0D) 字节没有被正确解码

**修复方法**:
- 将 `String(buffer)` 替换为 `buffer.toString('utf8')`
- 确保跨运行时的 UTF-8 解码一致性

**影响范围**:
- ✅ 修复 `dist/publish/cli.js` (--target node 构建)
- ✅ 不影响 `dist/cli` (--target bun 构建)

### 包含文件

```
LICENSE.md                    - 许可证
README.md                     - 使用文档
cli.js                        - 主程序 (10.7MB)
package.json                  - 包配置
sdk-tools.d.ts                - TypeScript 类型定义

vendor/
├── audio-capture.node        - 音频捕获原生模块
├── conpty.node               - Windows PTY 支持
├── conpty_console_list.node  - Windows 控制台列表
├── pty.node                  - PTY 原生模块
├── sharp-darwin-arm64.node   - macOS ARM64 图像处理
├── ripgrep/                  - 多平台 ripgrep 二进制
│   ├── aarch64-unknown-linux-gnu/rg
│   ├── arm64-darwin/rg
│   ├── x64-darwin/rg
│   ├── x64-win32/rg.exe
│   └── x86_64-unknown-linux-musl/rg
└── seccomp/                  - Linux 安全计算模式
    ├── arm64/
    │   ├── apply-seccomp
    │   └── unix-block.bpf
    └── x64/
        ├── apply-seccomp
        └── unix-block.bpf
```

## 🚀 安装方法

### 全局安装

```bash
npm install -g @zyzheal/ola-cc
```

### 项目安装

```bash
npm install @zyzheal/ola-cc
```

### 使用 npx 直接运行

```bash
npx @zyzheal/ola-cc
```

## 📝 使用方式

安装后可以使用 `ola-c` 命令：

```bash
# 启动交互会话
ola-c

# 或
npx ola-c
```

## 🔍 验证安装

```bash
# 检查版本
npm list -g @zyzheal/ola-cc

# 运行测试
ola-c --version
```

## 📊 发布历史

| 版本 | 日期 | 主要更新 |
|------|------|----------|
| 0.0.15 | - | 初始发布 |
| **0.0.16** | 2026-04-16 | 修复 Node.js 回车键问题 |

## 🐛 已知问题

无已知严重问题。

## 📮 反馈渠道

- GitHub: https://github.com/anthropics/claude-code
- npm: https://www.npmjs.com/package/@zyzheal/ola-cc

## 🔧 构建配置

**功能标志**:
- VOICE_MODE
- BUDDY

**构建目标**: 
- Node.js >= 18.0.0
- Bun >= 1.3.5

**依赖**:
- ws: ^8.18.0

**可选依赖**:
- sharp: *

## ✨ 总结

v0.0.16 成功发布到 npm 仓库，包含关键的跨运行时兼容性修复。用户现在可以在 Node.js 环境下正常使用回车键发送消息。

---

发布完成时间：2026年4月16日
发布者：AI Platform Cli Assistant
