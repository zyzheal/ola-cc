# Voice Mode 深度分析

**项目**: Claude Code 源码分析  
**分析日期**: 2026-04-12  
**状态**: 已完成  

---

## 执行摘要

### Voice Mode 统计概览

| 指标 | 数量 |
|------|------|
| Voice 服务文件 | 3 个 |
| Feature Gate | `VOICE_MODE` |
| 外部可用 | ❌ 内部限定 |
| 支持平台 | macOS / Linux / Windows |

### Voice Mode 组件分类

| 组件 | 文件数 | 复杂度 |
|------|--------|--------|
| 语音服务 | 1 | 高 |
| 语音关键词 | 1 | 低 |
| 语音流 STT | 1 | 高 |

---

## 1. Voice Mode 架构

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Voice Input Flow                      │
├─────────────────────────────────────────────────────────┤
│  用户按下语音键 → 启动录音 → 语音识别 → 文本输入          │
│       ↓              ↓           ↓           ↓          │
│   UI 触发      audio-capture   STT 服务    Prompt 提交    │
│                          ↓                               │
│                    SoX/arecord 备选                        │
└─────────────────────────────────────────────────────────┘
```

### 1.2 音频采集

**录音规格**:
```typescript
const RECORDING_SAMPLE_RATE = 16000   // 16kHz 采样率
const RECORDING_CHANNELS = 1          // 单声道
```

**静音检测**:
```typescript
const SILENCE_DURATION_SECS = '2.0'   // 2 秒静音停止
const SILENCE_THRESHOLD = '3%'        // 3% 音量阈值
```

---

## 2. 核心服务分析

### 2.1 voice.ts (语音服务)

**功能**: 语音输入核心服务

**音频采集方式**:

| 平台 | 主要方式 | 备选方式 |
|------|----------|----------|
| macOS | CoreAudio (native) | SoX `rec` |
| Linux | cpal (native) | arecord (ALSA) |
| Windows | CoreAudio (native) | SoX `rec` |

#### Native Audio 模块

```typescript
// 懒加载原生音频模块
type AudioNapi = typeof import('audio-capture-napi')
let audioNapi: AudioNapi | null = null

function loadAudioNapi(): Promise<AudioNapi> {
  audioNapiPromise ??= (async () => {
    const t0 = Date.now()
    const mod = await import('audio-capture-napi')
    mod.isNativeAudioAvailable()
    audioNapi = mod
    logForDebugging(`[voice] audio-capture-napi loaded in ${Date.now() - t0}ms`)
    return mod
  })()
  return audioNapiPromise
}
```

**加载延迟**:
- 热启动：~1s
- 冷启动：~8s (coreaudiod 刚启动后)

#### SoX 备选方案

```typescript
function startSoxRecording(outputPath: string): ChildProcess {
  return spawn('rec', [
    '-r', String(RECORDING_SAMPLE_RATE),
    '-c', String(RECORDING_CHANNELS),
    '-e', 'signed-integer',
    '-b', '16',
    '-L',  // Little endian
    '-V0', // Quiet
    '-n',  // No display
    'silence', // Silence detection
    '1', '0.1', `${SILENCE_THRESHOLD}%`, // Start threshold
    '1', `${SILENCE_DURATION_SECS}`, `${SILENCE_THRESHOLD}%`, // Stop threshold
    outputPath,
  ])
}
```

#### Arecord 备选方案 (Linux)

```typescript
function startArecordRecording(outputPath: string): ChildProcess {
  return spawn('arecord', [
    '-f', 'S16_LE',         // Format: 16-bit Little Endian
    '-r', String(RECORDING_SAMPLE_RATE),
    '-c', String(RECORDING_CHANNELS),
    '-t', 'raw',            // Raw audio
    outputPath,
  ])
}
```

#### Arecord 探测 (WSL 支持)

```typescript
// WSL1/无音频设备检测
function probeArecord(): Promise<{ ok: boolean; stderr: string }> {
  arecordProbe ??= new Promise(resolve => {
    const child = spawn('arecord', [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
    
    // 150ms 超时判断是否成功打开设备
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ ok: true, stderr: '' })
    }, 150)
    
    child.once('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stderr: stderr.trim() })
    })
  })
  return arecordProbe
}
```

### 2.2 voiceKeyterms.ts (语音关键词)

**功能**: 语音识别关键词管理

**用途**:
- 唤醒词检测
- 命令词识别
- 上下文关键词

### 2.3 voiceStreamSTT.ts (语音流识别)

**功能**: 流式语音转文本

**支持的 STT 服务**:
| 服务 | 说明 |
|------|------|
| Nova 3 | Anthropic 语音识别 |
| 本地 STT | 备选离线识别 |

**Feature Gate**: `tengu_cobalt_frost`

---

## 3. UI 集成

### 3.1 VoiceIndicator.tsx

**功能**: 语音状态指示器

**显示状态**:
- 待机 (麦克风图标)
- 录音中 (波形动画)
- 识别中 (旋转动画)
- 错误 (警告图标)

### 3.2 VoiceModeNotice.tsx

**功能**: 语音模式通知

**显示内容**:
- 语音模式启用通知
- 语音功能说明
- 快捷键提示

---

## 4. Hooks 集成

### 4.1 useVoice.ts

**功能**: 语音功能 Hook

**返回**:
```typescript
interface UseVoiceReturn {
  isRecording: boolean
  isProcessing: boolean
  error: string | null
  startRecording: () => Promise<void>
  stopRecording: () => Promise<void>
  cancelRecording: () => void
}
```

### 4.2 useVoiceEnabled.ts

**功能**: 语音启用状态检查

**返回**: `boolean`

**检查项**:
- Feature Gate 启用
- 音频设备可用
- 权限授予

### 4.3 useVoiceIntegration.tsx

**功能**: 语音集成

**集成点**:
- PromptInput 集成
- 语音命令处理
- 错误处理

---

## 5. 依赖检查

### 5.1 命令检测

```typescript
function hasCommand(cmd: string): boolean {
  const result = spawnSync(cmd, ['--version'], {
    stdio: 'ignore',
    timeout: 3000,
  })
  return result.error === undefined
}
```

### 5.2 ALSA 卡检测 (Linux)

```typescript
function linuxHasAlsaCards(): Promise<boolean> {
  linuxAlsaCardsMemo ??= readFile('/proc/asound/cards', 'utf8').then(
    cards => {
      const c = cards.trim()
      return c !== '' && !c.includes('no soundcards')
    },
    () => false,
  )
  return linuxAlsaCardsMemo
}
```

---

## 6. 包管理器集成

### 6.1 依赖安装建议

**macOS**:
```bash
brew install sox    # SoX 音频工具
```

**Linux**:
```bash
apt install sox     # Debian/Ubuntu
pacman -S sox       # Arch
dnf install sox     # Fedora
```

**Windows**:
```bash
choco install sox   # Chocolatey
```

---

## 7. Feature-Gated 功能

| 功能 | Feature Gate | 外部可用 |
|------|--------------|----------|
| 语音模式 | `VOICE_MODE` | ❌ |
| Nova 3 STT | `tengu_cobalt_frost` | ❌ |
| 语音指示器 | `VOICE_MODE` | ❌ |
| 语音集成 | `VOICE_MODE` | ❌ |

---

## 8. 安全与隐私

### 8.1 音频数据处理

**处理流程**:
```
麦克风输入 → 本地录音 → STT API → 文本 → 删除音频
                                      ↓
                                 不存储音频
```

### 8.2 权限要求

| 平台 | 权限 | 说明 |
|------|------|------|
| macOS | 麦克风权限 | 系统级授权 |
| Linux | 音频组权限 | `audio` 组成员 |
| Windows | 麦克风权限 | 隐私设置 |

### 8.3 数据最小化

**原则**:
- 录音仅用于即时识别
- 不存储原始音频
- 不传输音频数据 (仅 STT 结果)

---

## 9. 错误处理

### 9.1 常见错误

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| `No audio devices` | 无音频设备 | 连接麦克风 |
| `Permission denied` | 权限不足 | 授予麦克风权限 |
| `arecord: command not found` | 缺少 arecord | 安装 alsa-utils |
| `rec: command not found` | 缺少 SoX | 安装 sox |

### 9.2 降级策略

```
Native Audio 失败 → SoX → arecord → 错误提示
```

---

## 10. 性能优化

### 10.1 懒加载

```typescript
// 仅在首次使用时加载原生模块
function loadAudioNapi(): Promise<AudioNapi> {
  audioNapiPromise ??= import('audio-capture-napi')
  return audioNapiPromise
}
```

### 10.2 缓存探测结果

```typescript
// 音频设备探测结果缓存 (会话内不变)
let arecordProbe: Promise<ArecordProbeResult> | null = null
```

### 10.3 静默加载

```typescript
// 后台预加载，避免 UI 阻塞
useEffect(() => {
  loadAudioNapi() // 不等待结果
}, [])
```

---

## 11. 使用流程

### 11.1 首次使用

```
1. 用户按下语音键
       ↓
2. 检查权限
       ↓
3. 加载音频模块 (~1-8s)
       ↓
4. 开始录音
       ↓
5. 用户说话
       ↓
6. 检测静音 (2 秒)
       ↓
7. 停止录音
       ↓
8. STT 识别
       ↓
9. 文本填入输入框
```

### 11.2 后续使用

```
1. 用户按下语音键
       ↓
2. 直接使用缓存模块
       ↓
3. 开始录音 (即时)
       ↓
4. ...同上
```

---

## 12. 平台差异

### 12.1 macOS

**优势**:
- CoreAudio 原生支持
- 系统级麦克风权限
- 高质量音频采集

**注意事项**:
- 首次加载较慢
- 需要用户授权

### 12.2 Linux

**优势**:
- ALSA 原生支持
- 开源驱动

**注意事项**:
- WSL1 无音频支持
- WSL2+WSLg 有 PulseAudio 支持
- 需要 `audio` 组权限

### 12.3 Windows

**优势**:
- CoreAudio 原生支持
- 广泛硬件支持

**注意事项**:
- 隐私设置需要启用
- 可能需要管理员权限

---

## 13. 改进建议

### 短期 (P0)
- [ ] 补充 STT 服务详细分析
- [ ] 补充错误处理完整流程

### 中期 (P1)
- [ ] 语音命令词汇表
- [ ] 多语言支持分析

### 长期 (P2)
- [ ] 离线 STT 集成
- [ ] 语音命令自定义

---

## 附录：Voice Mode 文件清单

### 核心服务 (3)
`voice.ts` - 语音采集服务  
`voiceKeyterms.ts` - 语音关键词  
`voiceStreamSTT.ts` - 流式语音识别

### UI 组件 (2)
`VoiceIndicator.tsx` - 语音状态指示器  
`VoiceModeNotice.tsx` - 语音模式通知

### Hooks (3)
`useVoice.ts` - 语音功能 Hook  
`useVoiceEnabled.ts` - 启用状态 Hook  
`useVoiceIntegration.tsx` - 语音集成 Hook

---

## 附录：录音参数速查

| 参数 | 值 | 说明 |
|------|-----|------|
| 采样率 | 16000 Hz | 16kHz 语音质量 |
| 声道数 | 1 | 单声道 |
| 位深度 | 16-bit | CD 质量 |
| 字节序 | Little Endian | 通用格式 |
| 静音阈值 | 3% | 环境噪音容忍 |
| 静音时长 | 2.0s | 自动停止延迟 |

---

*文档版本：1.0 | 最后更新：2026-04-12*
