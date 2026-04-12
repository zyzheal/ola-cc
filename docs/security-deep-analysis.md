# 安全机制深度分析

**项目**: Claude Code 源码分析  
**分析日期**: 2026-04-12  
**状态**: 已完成  

---

## 执行摘要

### 安全机制统计概览

| 指标 | 数量 |
|------|------|
| 沙箱相关文件 | 2+ 个 |
| 权限管理文件 | 24+ 个 |
| 认证相关文件 | 4+ 个 |
| Bash 安全文件 | 10+ 个 |
| PowerShell 安全文件 | 8+ 个 |

### 安全层分类

| 层级 | 组件数 | 复杂度 |
|------|--------|--------|
| 沙箱隔离 | 2+ | 高 |
| 权限管理 | 24+ | 高 |
| 认证授权 | 4+ | 高 |
| 命令分类 | 5+ | 中 |
| 路径验证 | 3+ | 中 |
| 破坏性检测 | 4+ | 中 |

---

## 1. 沙箱安全机制

### 1.1 SandboxAdapter (sandbox-adapter.ts)

**功能**: 沙箱运行时适配器

**依赖**: `@anthropic-ai/sandbox-runtime`

#### 核心配置转换

```typescript
// Claude Code 设置 → Sandbox Runtime 配置
function claudeSettingsToSandboxConfig(settings: Settings): SandboxRuntimeConfig {
  return {
    filesystem: {
      readRestrictions: convertReadRules(settings),
      writeRestrictions: convertWriteRules(settings),
    },
    network: {
      allowManagedDomainsOnly: settings.sandbox.network.allowManagedDomainsOnly,
      hostPatterns: convertNetworkRules(settings),
    },
  }
}
```

#### 路径模式解析

| 模式 | 说明 | 示例 |
|------|------|------|
| `//path` | 绝对路径 (从根目录) | `//.aws/**` → `/.aws/**` |
| `/path` | 相对设置文件目录 | `/.cargo/**` → `$SETTINGS_DIR/.cargo/**` |
| `~/path` | 用户主目录 | `~/.ssh/**` |
| `./path` | 相对当前目录 | `./src/**` |

#### 沙箱违规处理

```typescript
interface SandboxViolationEvent {
  type: 'filesystem' | 'network' | 'process'
  action: 'read' | 'write' | 'connect' | 'execute'
  path?: string
  host?: string
  blocked: boolean
}
```

### 1.2 沙箱 UI 工具 (sandbox-ui-utils.ts)

**功能**: 沙箱违规 UI 展示

**用途**:
- 违规消息格式化
- 违规详情展开视图
- 用户友好错误说明

---

## 2. 权限管理系统

### 2.1 权限模式 (PermissionMode.ts)

**支持的权限模式**:

| 模式 | 说明 | 用户交互 |
|------|------|----------|
| `default` | 默认模式 | 危险操作需批准 |
| `auto` / `yolo` | 自动模式 | 分类器决定 |
| `bypass` | 绕过模式 | 无需批准 (高风险) |

### 2.2 权限规则 (PermissionRule.ts)

**规则结构**:

```typescript
interface PermissionRule {
  source: PermissionRuleSource      // 规则来源
  ruleBehavior: 'allow' | 'deny'    // 允许/拒绝
  ruleValue: PermissionRuleValue    // 规则值
}

interface PermissionRuleValue {
  toolName: string                  // 工具名称
  ruleContent?: string              // 规则内容 (可选)
}
```

**规则来源优先级**:

```
1. cliArg (命令行参数)      - 最高优先级
2. command (命令)
3. session (会话)
4. user (用户设置)
5. system (系统设置)
6. managed (管理设置)       - 最低优先级
```

### 2.3 权限请求处理 (permissions.ts)

**处理流程**:

```
工具调用请求
    ↓
1. 规则匹配 (allow/deny)
    ↓
2. 分类器检查 (BASH_CLASSIFIER / TRANSCRIPT_CLASSIFIER)
    ↓
3. Hook 执行 (权限请求 Hook)
    ↓
4. 用户批准 (如需要)
    ↓
5. 执行/拒绝
```

#### 分类器集成

```typescript
// Feature-gated 分类器支持
if (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) {
  const classifierDecision = await classifyCommand(command)
  if (classifierDecision === 'deny') {
    return { decision: 'deny', reason: 'classifier' }
  }
}
```

### 2.4 权限更新 (PermissionUpdate.ts)

**支持的更新操作**:

```typescript
interface PermissionUpdate {
  toolName: string
  ruleContent?: string
  behavior: 'allow' | 'deny'
  destination: PermissionUpdateDestination
  remember: boolean  // 是否持久化
}
```

**持久化目标**:
- `session` - 会话临时
- `user` - 用户设置文件
- `system` - 系统设置文件

### 2.5 拒绝跟踪 (denialTracking.ts)

**功能**: 跟踪分类器拒绝次数

**限制**:
```typescript
const DENIAL_LIMITS = {
  consecutiveDenials: 3,  // 连续拒绝上限
  totalDenials: 5,        // 总拒绝上限
}
```

**超限处理**:
- 自动降级到提示模式
- 用户手动确认

### 2.6 YOLO 分类器 (yoloClassifier.ts)

**功能**: 本地命令分类

**分类类型**:
- `safe` - 安全命令
- `risky` - 风险命令
- `dangerous` - 危险命令

**示例**:
```typescript
classifyYoloAction('ls -la')      // → 'safe'
classifyYoloAction('rm -rf /tmp') // → 'risky'
classifyYoloAction('rm -rf /')    // → 'dangerous'
```

---

## 3. Bash 安全机制

### 3.1 BashSecurity (bashSecurity.ts)

**功能**: Bash 命令安全检查

**检查项**:
- 命令注入检测
- 危险模式识别
- 环境变量注入防护

### 3.2 PathValidation (pathValidation.ts)

**功能**: 路径越狱检测

**检测规则**:
```typescript
// 禁止的路径模式
const FORBIDDEN_PATHS = [
  '/etc/**',
  '/root/**',
  '/var/log/**',
  // ...
]

function validatePath(path: string, cwd: string): boolean {
  // 1. 解析路径
  // 2. 检查是否在允许目录内
  // 3. 检查是否匹配禁止模式
  // 4. 返回验证结果
}
```

### 3.3 ReadOnlyValidation (readOnlyValidation.ts)

**功能**: 只读模式验证

**检查**:
- 写操作检测
- 修改操作检测
- 删除操作检测

### 3.4 ModeValidation (modeValidation.ts)

**功能**: 模式验证

**支持的模式**:
- `read-only` - 只读
- `danger` - 危险操作允许
- `auto` - 自动模式

### 3.5 DestructiveCommandWarning (destructiveCommandWarning.ts)

**功能**: 破坏性命令警告

**检测的命令**:
| 命令 | 风险等级 |
|------|----------|
| `rm -rf /` | 极高 |
| `rm -rf ~` | 高 |
| `dd if=...` | 高 |
| `mkfs.*` | 高 |
| `:(){ :|:& };:` | 极高 (Fork 炸弹) |

### 3.6 SedValidation (sedValidation.ts)

**功能**: sed 命令安全验证

**检查**:
- 就地编辑检测 (`-i`)
- 危险模式识别
- 文件路径验证

### 3.7 ShouldUseSandbox (shouldUseSandbox.ts)

**功能**: 沙箱使用判断

**判断逻辑**:
```typescript
function shouldUseSandbox(command: string, settings: Settings): boolean {
  // 1. 检查沙箱启用设置
  if (!settings.sandbox.enabled) return false
  
  // 2. 检查命令类型
  if (isSafeCommand(command)) return false
  
  // 3. 检查权限模式
  if (settings.permissionMode === 'bypass') return false
  
  return true
}
```

---

## 4. PowerShell 安全机制

### 4.1 PowerShellSecurity (powershellSecurity.ts)

**功能**: PowerShell 命令安全检查

**检查项**:
- 命令注入检测
- 危险 cmdlet 识别
- 脚本执行策略检查

### 4.2 GitSafety (gitSafety.ts)

**功能**: Git 命令安全

**保护的命令**:
- `git push --force`
- `git reset --hard`
- `git clean -fd`

### 4.3 PowerShellPermissions (powershellPermissions.ts)

**功能**: PowerShell 权限检查

---

## 5. 认证授权机制

### 5.1 认证流程 (auth.ts)

**支持的认证方式**:

| 方式 | 说明 | 优先级 |
|------|------|--------|
| OAuth | Anthropic OAuth 2.0 | 高 |
| API Key | 直接 API 密钥 | 中 |
| AWS STS | AWS 临时凭证 | 低 |

#### OAuth 认证流程

```
1. 检查现有 Token
       ↓
2. Token 过期检查
       ↓
3. 刷新 Token (如需要)
       ↓
4. 获取用户资料
       ↓
5. 验证订阅状态
```

### 5.2 认证状态管理 (authFileDescriptor.ts)

**功能**: 认证文件描述符管理

**支持**:
- API 密钥文件描述符
- OAuth Token 文件描述符

### 5.3 安全存储 (secureStorage/)

**目录**: `src/utils/secureStorage/`

**组件**:
| 文件 | 功能 |
|------|------|
| `index.ts` | 安全存储入口 |
| `macOsKeychainHelpers.ts` | macOS 钥匙串 |
| `keychainPrefetch.ts` | 钥匙串预取 |

### 5.4 AWS 认证 (aws.ts)

**功能**: AWS STS 认证

**检查**:
- STS Caller Identity 验证
- 凭证有效期检查
- 区域配置验证

### 5.5 AWS 认证状态管理 (awsAuthStatusManager.ts)

**功能**: AWS 认证状态管理

---

## 6. 权限 UI 组件

### 6.1 PermissionPromptToolResultSchema

**功能**: 权限提示 UI 数据结构

### 6.2 PermissionResult

**功能**: 权限决定结果

```typescript
type PermissionDecision = 'allow' | 'deny' | 'ask'

interface PermissionAskDecision {
  decision: 'ask'
  message: string
  options: PermissionOption[]
}

interface PermissionDenyDecision {
  decision: 'deny'
  reason: string
}
```

### 6.3 权限对话框

| 组件 | 功能 |
|------|------|
| `SandboxViolationExpandedView.tsx` | 沙箱违规详情 |
| `SandboxSettings.tsx` | 沙箱设置界面 |
| `SandboxConfigTab.tsx` | 沙箱配置标签 |

---

## 7. Feature-Gated 安全功能

| 功能 | Feature Gate | 外部可用 |
|------|--------------|----------|
| Bash 分类器 | `BASH_CLASSIFIER` | ❌ |
| 转录分类器 | `TRANSCRIPT_CLASSIFIER` | ❌ |
| 自动模式 | `TRANSCRIPT_CLASSIFIER` | ❌ |
| 绕过权限 | `bypassPermissionsKillswitch` | ⚠️ 受控 |

---

## 8. 安全策略配置

### 8.1 用户设置

```json
{
  "sandbox": {
    "enabled": true,
    "filesystem": {
      "allowWrite": ["./.git/**", "./node_modules/**"],
      "denyWrite": ["./src/**", "./config/**"]
    },
    "network": {
      "allowManagedDomainsOnly": true,
      "allowedHosts": ["api.anthropic.com", "*.anthropic.com"]
    }
  },
  "permissionMode": "default",
  "permissionRules": {
    "alwaysAllow": ["Bash(ls *)", "Glob(**/*.ts)"],
    "alwaysDeny": ["Bash(rm -rf *)"]
  }
}
```

### 8.2 管理设置

**位置**: 企业/团队管理策略

**优先级**: 最高 (用户无法覆盖)

---

## 9. 安全事件日志

### 9.1 日志类型

| 事件类型 | 说明 |
|----------|------|
| `sandbox_violation` | 沙箱违规 |
| `permission_denied` | 权限拒绝 |
| `auth_failure` | 认证失败 |
| `classifier_decision` | 分类器决定 |

### 9.2 分析追踪

```typescript
logEvent('permission_check', {
  toolName: sanitizeToolNameForAnalytics(toolName),
  decision: 'allow' | 'deny' | 'ask',
  reason: decisionReason,
  metadata: analyticsMetadata
})
```

---

## 10. 安全最佳实践

### 10.1 用户最佳实践

1. **启用沙箱** - 对未知命令使用沙箱
2. **最小权限** - 仅授予必要的权限
3. **审查规则** - 定期检查权限规则
4. **监控违规** - 查看沙箱违规日志

### 10.2 开发者最佳实践

1. **路径验证** - 始终验证用户提供的路径
2. **命令转义** - 正确转义 shell 命令
3. **错误处理** - 安全处理认证错误
4. **日志脱敏** - 日志中脱敏敏感信息

---

## 11. 安全风险评估

### 11.1 已识别风险

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 路径越狱 | 低 | 高 | 多层验证 |
| 命令注入 | 低 | 高 | 分类器 + 沙箱 |
| 凭证泄露 | 低 | 高 | 安全存储 |
| 权限提升 | 低 | 高 | 管理策略 |

### 11.2 安全边界

```
用户输入 → 路径验证 → 权限检查 → 沙箱执行
              ↓           ↓          ↓
          越狱检测   规则匹配   隔离运行
```

---

## 12. 改进建议

### 短期 (P0)
- [ ] 补充沙箱违规 UI 分析
- [ ] 补充分类器详细逻辑

### 中期 (P1)
- [ ] 安全测试用例整理
- [ ] 渗透测试报告

### 长期 (P2)
- [ ] 安全文档站点
- [ ] 安全响应流程

---

## 附录：安全文件清单

### 沙箱 (2)
`sandbox-adapter.ts` / `sandbox-ui-utils.ts`

### 权限 (24)
`PermissionMode.ts` / `PermissionPromptToolResultSchema.ts` / `PermissionResult.ts` / `PermissionRule.ts` / `PermissionUpdate.ts` / `PermissionUpdateSchema.ts` / `autoModeState.ts` / `bashClassifier.ts` / `bypassPermissionsKillswitch.ts` / `classifierDecision.ts` / `classifierShared.ts` / `dangerousPatterns.ts` / `denialTracking.ts` / `filesystem.ts` / `getNextPermissionMode.ts` / `pathValidation.ts` / `permissionExplainer.ts` / `permissionRuleParser.ts` / `permissionSetup.ts` / `permissions.ts` / `permissionsLoader.ts` / `shadowedRuleDetection.ts` / `shellRuleMatching.ts` / `yoloClassifier.ts`

### 认证 (4)
`auth.ts` / `authFileDescriptor.ts` / `authPortable.ts` / `aws.ts` / `awsAuthStatusManager.ts`

### Bash 安全 (10)
`bashSecurity.ts` / `pathValidation.ts` / `readOnlyValidation.ts` / `modeValidation.ts` / `destructiveCommandWarning.ts` / `sedValidation.ts` / `shouldUseSandbox.ts` / `bashPermissions.ts` / `commandSemantics.ts` / `bashCommandHelpers.ts`

### PowerShell 安全 (8)
`powershellSecurity.ts` / `gitSafety.ts` / `powershellPermissions.ts` / `pathValidation.ts` / `readOnlyValidation.ts` / `modeValidation.ts` / `destructiveCommandWarning.ts` / `commandSemantics.ts`

---

*文档版本：1.0 | 最后更新：2026-04-12*
