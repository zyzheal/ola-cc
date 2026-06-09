# Security Hardening Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: oh-my-claudecode + openclaude + claude-code
**Priority**: P0
**Effort**: M

---

## 0. LOC 估算总表

| # | 安全功能 | 优先级 | 难度 | 新增文件 | 新增 LOC | 修改文件 | 修改 LOC | 总 LOC |
|---|----------|--------|------|----------|----------|----------|----------|--------|
| 1 | SSRF Guard | P0 | Hard | 1 (`ssrf-guard.ts`) | ~280 | 2 (`openai.ts`, `WebFetchTool/`) | ~40 | ~320 |
| 2 | Secret Scanner | P0 | Medium | 1 (`secretScanner.ts`) | ~250 | 2 (`toolExecution.ts`, `analytics/`) | ~30 | ~280 |
| 3 | URL Redaction | P0 | Easy | 1 (`urlRedaction.ts`) | ~120 | 1 (`debug.ts`) | ~15 | ~135 |
| 4 | Enhanced Bash Security | P1 | Medium | 3 (`dangerousPatterns.ts`, `readOnlyCommandValidation.ts`, `powershell/dangerousCmdlets.ts`) | ~350 | 1 (`BashTool/`) | ~25 | ~375 |
| 5 | Env Variable Security Sync | P1 | Easy | 0 | 0 | 1 (`managedEnvConstants.ts`) | ~40 | ~40 |
| 6 | Verification Tier Selector | P2 | Medium | 1 (`tierSelector.ts`) | ~200 | 1 (`AgentTool/`) | ~20 | ~220 |
| 7 | Sentinel Gate | P2 | Medium | 1 (`sentinelGate.ts`) | ~180 | 1 (`EvolutionEngine.ts`) | ~15 | ~195 |
| **合计** | | | | **8 files** | **~1,380** | **9 files** | **~185** | **~1,565** |

---

## 1. SSRF Guard (P0, from oh-my-claudecode)

**Source**: `/Users/heal/oh-my-claudecode/src/utils/ssrf-guard.ts`

### Protection Rules

| Rule | Description |
|------|-------------|
| Private IP ranges | Block 10.x, 172.16-31.x, 192.168.x |
| Loopback | Block 127.x, localhost, ::1 |
| Link-local | Block 169.254.x |
| IPv6-mapped IPv4 | Block ::ffff: |
| Encoded IP bypass | Block hex/octal/decimal encoded IPs |
| Cloud metadata | Block /metadata, /meta-data, /computeMetadata |
| Embedded credentials | Block URLs with username:password |
| Protocol restriction | Allow only http/https |

### DNS Rebinding 防护

DNS rebinding 攻击通过第一次 DNS 解析返回合法 IP，第二次解析返回内网 IP 来绕过 SSRF 检查。

防护措施：
1. **单次解析**: `ssrfGuardedLookup()` 在连接前一次性解析 DNS，不缓存结果
2. **IP 验证时机**: 验证在 DNS 解析后、TCP 连接前进行，消除 TOCTOU 窗口
3. **双检查**: 解析时检查一次 IP，连接时通过 `localAddress` 绑定再次验证

### 接口定义

```typescript
interface SSRFGuardConfig {
  allowedHosts: string[]      // 白名单
  blockPrivateIPs: boolean    // 阻断内网 IP（默认 true）
  dnsRebindProtection: boolean // DNS rebinding 防护（默认 true）
  timeout: number             // DNS 查询超时 ms（默认 5000）
}

interface SSRFCheckResult {
  allowed: boolean
  reason?: string             // 拒绝原因
  resolvedIPs?: string[]      // 解析到的 IP 列表
}

interface SSRFGuard {
  checkURL(url: string, config?: Partial<SSRFGuardConfig>): Promise<SSRFCheckResult>
  ssrfGuardedLookup(hostname: string): Promise<string[]>
}
```

### 代码骨架

```typescript
// src/utils/ssrf-guard.ts
import { isPrivateIp, isLoopback, isLinkLocal, isIPv6Mapped } from './ip-utils'

const PRIVATE_RANGES = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^169\.254\./,
  /^::ffff:/,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i
]

const CLOUD_METADATA_PATHS = ['/metadata', '/meta-data', '/computeMetadata']

export class SSRFGuardImpl implements SSRFGuard {
  async checkURL(url: string, config?: Partial<SSRFGuardConfig>): Promise<SSRFCheckResult> {
    const cfg = { ...DEFAULT_CONFIG, ...config }

    // 1. 协议检查
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { allowed: false, reason: `Protocol ${parsed.protocol} not allowed` }
    }

    // 2. 嵌入凭据检查
    if (parsed.username || parsed.password) {
      return { allowed: false, reason: 'Embedded credentials not allowed' }
    }

    // 3. 白名单检查
    if (cfg.allowedHosts.includes(parsed.hostname)) {
      return { allowed: true }
    }

    // 4. 云元数据路径检查
    if (CLOUD_METADATA_PATHS.some(p => parsed.pathname.startsWith(p))) {
      return { allowed: false, reason: 'Cloud metadata endpoint blocked' }
    }

    // 5. DNS 解析 + IP 验证
    const ips = await this.ssrfGuardedLookup(parsed.hostname)
    for (const ip of ips) {
      if (cfg.blockPrivateIPs && this.isPrivateOrReserved(ip)) {
        return { allowed: false, reason: `Private IP ${ip} blocked`, resolvedIPs: ips }
      }
    }

    return { allowed: true, resolvedIPs: ips }
  }

  async ssrfGuardedLookup(hostname: string): Promise<string[]> {
    // 单次解析，不缓存，消除 DNS rebinding 窗口
    const resolver = new dns.promises.Resolver()
    const addresses = await Promise.race([
      resolver.resolve4(hostname),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 5000))
    ])
    return addresses as string[]
  }

  private isPrivateOrReserved(ip: string): boolean {
    return PRIVATE_RANGES.some(range => range.test(ip))
  }
}
```

### Integration

| File | Operation |
|------|-----------|
| `src/utils/ssrf-guard.ts` | **New** — Port from oh-my-claudecode |
| `src/services/api/openai.ts` | Modify — Add SSRF check before requests |
| `src/tools/WebFetchTool/` | Modify — Add SSRF check |

---

## 2. Secret Scanner (P0, from openclaude)

**Source**: `/Users/heal/openclaude/src/services/teamMemorySync/secretScanner.ts`

### Features

- 30+ high-confidence patterns based on gitleaks rules
- Coverage: AWS, GCP, Azure, Anthropic, OpenAI, HuggingFace, GitHub, GitLab, Slack, Stripe, Shopify
- `scanForSecrets()` returns only rule IDs, **never actual secret values**
- `redactSecrets()` in-place replacement with `[REDACTED]`
- Runtime prefix concatenation for Anthropic API keys

### 接口定义

```typescript
interface SecretScanResult {
  hasSecrets: boolean
  ruleIds: string[]             // 命中的规则 ID（不含实际密钥值）
  matchCount: number
}

interface SecretScannerConfig {
  rules: SecretRule[]
  maxInputLength: number        // 最大输入长度（默认 1MB）
  redactReplacement: string     // 脱敏替换文本（默认 '[REDACTED]'）
}

interface SecretRule {
  id: string                    // 规则 ID（如 'aws-key', 'github-token'）
  pattern: RegExp
  description: string
  severity: 'critical' | 'high' | 'medium'
}

interface SecretScanner {
  scanForSecrets(text: string): SecretScanResult
  redactSecrets(text: string): string
}
```

### 代码骨架

```typescript
// src/utils/secretScanner.ts
const DEFAULT_RULES: SecretRule[] = [
  { id: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g, description: 'AWS Access Key', severity: 'critical' },
  { id: 'github-token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/g, description: 'GitHub Token', severity: 'critical' },
  { id: 'anthropic-key', pattern: /sk-ant-[a-zA-Z0-9-]{20,}/g, description: 'Anthropic API Key', severity: 'critical' },
  { id: 'openai-key', pattern: /sk-[a-zA-Z0-9]{20,}/g, description: 'OpenAI API Key', severity: 'high' },
  { id: 'private-key', pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g, description: 'Private Key', severity: 'critical' },
  { id: 'jwt', pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]+/g, description: 'JWT Token', severity: 'high' },
  { id: 'generic-api-key', pattern: /(?i)(api[_-]?key|apikey)\s*[:=]\s*['"]?[a-z0-9]{32,}['"]?/g, description: 'Generic API Key', severity: 'medium' }
]

export class SecretScannerImpl implements SecretScanner {
  private config: SecretScannerConfig

  constructor(config?: Partial<SecretScannerConfig>) {
    this.config = { rules: DEFAULT_RULES, maxInputLength: 1_000_000, redactReplacement: '[REDACTED]', ...config }
  }

  scanForSecrets(text: string): SecretScanResult {
    if (text.length > this.config.maxInputLength) {
      text = text.slice(0, this.config.maxInputLength)
    }
    const hitRuleIds: string[] = []
    let totalMatches = 0
    for (const rule of this.config.rules) {
      const matches = text.match(rule.pattern)
      if (matches && matches.length > 0) {
        hitRuleIds.push(rule.id)
        totalMatches += matches.length
      }
    }
    return { hasSecrets: hitRuleIds.length > 0, ruleIds: hitRuleIds, matchCount: totalMatches }
  }

  redactSecrets(text: string): string {
    let result = text
    for (const rule of this.config.rules) {
      result = result.replace(rule.pattern, this.config.redactReplacement)
    }
    return result
  }
}
```

### 典型 Pattern 示例

| 类型 | Pattern |
|------|---------|
| AWS Key | `AKIA[0-9A-Z]{16}` |
| GitHub Token | `gh[ps]_[A-Za-z0-9_]{36,}` |
| Generic API Key | `(?i)(api[_-]?key\|apikey)\s*[:=]\s*['"]?[a-z0-9]{32,}['"]?` |
| Private Key | `-----BEGIN (RSA \|EC \|OPENSSH )?PRIVATE KEY-----` |
| JWT | `eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]+` |

### Integration

| File | Operation |
|------|-----------|
| `src/utils/secretScanner.ts` | **New** — Port from openclaude |
| `src/services/tools/toolExecution.ts` | Modify — Scan tool outputs before logging |
| `src/services/analytics/` | Modify — Scan before telemetry export |

---

## 3. URL Redaction (P0, from openclaude)

**Source**: `/Users/heal/openclaude/src/utils/urlRedaction.ts`

### 接口定义

```typescript
interface URLRedactionConfig {
  sensitiveParams: string[]       // 敏感查询参数名列表
  redactCredentials: boolean      // 是否脱敏 URL 中的用户名/密码（默认 true）
  replacement: string             // 替换文本（默认 '[REDACTED]'）
}

interface URLRedactor {
  redactURL(url: string): string
  redactInText(text: string): string  // 在文本中查找并脱敏所有 URL
}
```

### Features

- 15 sensitive query parameter patterns (api_key, token, secret, password, etc.)
- Username/password redaction in URLs
- Regex fallback for invalid URLs

### Integration

| File | Operation |
|------|-----------|
| `src/utils/urlRedaction.ts` | **New** — Port from openclaude |
| `src/utils/debug.ts` | Modify — Apply URL redaction to debug logs |

---

## 4. Enhanced Bash Security (P1, from claude-code)

**Source**: `/Users/heal/claude-code/src/utils/bash/`

### 接口定义

```typescript
interface DangerousPattern {
  id: string
  pattern: RegExp
  description: string
  severity: 'critical' | 'high' | 'medium'
  category: 'shell' | 'network' | 'filesystem' | 'privilege'
}

interface BashSecurityCheckResult {
  safe: boolean
  violations: DangerousPatternMatch[]
}

interface DangerousPatternMatch {
  pattern: DangerousPattern
  matchedText: string
  position: number
}

interface BashSecurityGuard {
  checkCommand(command: string): BashSecurityCheckResult
  checkPathTraversal(path: string): { safe: boolean; normalizedPath: string; reason?: string }
  isReadOnlyCommand(command: string): boolean
}
```

### 代码骨架

```typescript
// src/utils/bash/dangerousPatterns.ts
const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // Shell 注入
  { id: 'eval', pattern: /\beval\b/, description: 'eval command', severity: 'critical', category: 'shell' },
  { id: 'exec', pattern: /\bexec\b/, description: 'exec command', severity: 'high', category: 'shell' },
  { id: 'sudo', pattern: /\bsudo\b/, description: 'sudo command', severity: 'critical', category: 'privilege' },
  { id: 'ssh', pattern: /\bssh\b/, description: 'ssh command', severity: 'high', category: 'network' },
  // 网络外泄
  { id: 'curl-pipe', pattern: /\bcurl\b.*\|/, description: 'curl piped to shell', severity: 'critical', category: 'network' },
  { id: 'wget-pipe', pattern: /\bwget\b.*\|/, description: 'wget piped to shell', severity: 'critical', category: 'network' },
  { id: 'nc', pattern: /\bnc\b|\bnetcat\b/, description: 'netcat command', severity: 'high', category: 'network' },
  // 文件系统
  { id: 'rm-rf-root', pattern: /\brm\s+(-[a-zA-Z]*)?[\/~]/, description: 'rm with absolute path', severity: 'critical', category: 'filesystem' },
  { id: 'chmod-777', pattern: /\bchmod\s+777/, description: 'chmod 777', severity: 'high', category: 'filesystem' },
]

// Path Traversal 检测
const TRAVERSAL_PATTERNS = [
  /\.\.\//,           // ../
  /\.\.\\/,           // ..\
  /%2e%2e[%2f%5c]/i, // URL encoded
  /\x00/,             // null byte
]

export class BashSecurityGuardImpl implements BashSecurityGuard {
  checkCommand(command: string): BashSecurityCheckResult {
    const violations: DangerousPatternMatch[] = []
    for (const pattern of DANGEROUS_PATTERNS) {
      const match = command.match(pattern.pattern)
      if (match) {
        violations.push({ pattern, matchedText: match[0], position: match.index ?? 0 })
      }
    }
    return { safe: violations.length === 0, violations }
  }

  checkPathTraversal(filePath: string): { safe: boolean; normalizedPath: string; reason?: string } {
    // 1. 检查 null byte
    if (filePath.includes('\x00')) {
      return { safe: false, normalizedPath: filePath, reason: 'Null byte detected' }
    }
    // 2. 检查 traversal 模式
    for (const pattern of TRAVERSAL_PATTERNS) {
      if (pattern.test(filePath)) {
        return { safe: false, normalizedPath: filePath, reason: `Path traversal pattern detected: ${pattern}` }
      }
    }
    // 3. 规范化后检查是否逃逸根目录
    const normalized = path.normalize(filePath)
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      return { safe: false, normalizedPath: normalized, reason: 'Path escapes root directory' }
    }
    return { safe: true, normalizedPath: normalized }
  }

  isReadOnlyCommand(command: string): boolean {
    const readOnlyPrefixes = ['git status', 'git log', 'git diff', 'git show', 'gh pr view', 'gh issue view']
    return readOnlyPrefixes.some(prefix => command.trim().startsWith(prefix))
  }
}
```

### Components

| File | Purpose |
|------|---------|
| `dangerousPatterns.ts` | 30+ dangerous shell patterns (python, node, ssh, eval, sudo) |
| `readOnlyCommandValidation.ts` | Git/gh read-only flag whitelist |
| `powershell/dangerousCmdlets.ts` | PowerShell dangerous cmdlet detection |
| `DANGEROUS_FILES` | Sensitive config file protection |
| `DANGEROUS_DIRECTORIES` | Sensitive directory protection |

### Integration

| File | Operation |
|------|-----------|
| `src/utils/bash/dangerousPatterns.ts` | **New** — Port dangerous patterns |
| `src/utils/bash/readOnlyCommandValidation.ts` | **New** — Port read-only validation |
| `src/tools/BashTool/` | Modify — Integrate enhanced checks |

---

## 5. Environment Variable Security Sync (P1)

**Source**: claude-code `managedEnvConstants.ts`

### Missing Variables in ola-cc

- `CLAUDE_CODE_USE_GEMINI` — Gemini provider isolation
- `GEMINI_API_KEY`, `GEMINI_BASE_URL`, `GEMINI_MODEL` — Gemini routing
- `USE_BUILTIN_RIPGREP` — Search tool control
- `ENABLE_SEARCH_EXTRA_TOOLS` — Tool search control

### Integration

| File | Operation |
|------|-----------|
| `src/utils/managedEnvConstants.ts` | Modify — Add missing variables to SAFE_ENV_VARS and PROVIDER_MANAGED_ENV_VARS |

---

## 6. Verification Tier Selector (P2, from oh-my-claudecode)

**Source**: `/Users/heal/oh-my-claudecode/src/verification/tier-selector.ts`

### Three Tiers

| Tier | Model | Trigger |
|------|-------|---------|
| LIGHT | haiku | Small changes, no security impact |
| STANDARD | sonnet | Normal changes |
| THOROUGH | opus | Architecture changes, security-sensitive files |

### Auto-Detection

- Security-sensitive: auth/, security/, permissions, credentials, .env
- Architecture: config, schema, types, package.json
- File count, line count, test coverage

### 阈值配置

```typescript
interface VerificationTierConfig {
  autoDetect: {
    fileCountThreshold: number    // > 50 files → high tier
    lineCountThreshold: number    // > 5000 lines → high tier
    testCoverageMin: number       // < 30% → high tier
  }
}
```

当变更规模超过任一阈值（文件数 > 50、行数 > 5000、测试覆盖率 < 30%）时自动升级到 THOROUGH tier。安全敏感文件和架构文件始终触发 THOROUGH tier，不受阈值影响。

### Integration

| File | Operation |
|------|-----------|
| `src/services/verification/tierSelector.ts` | **New** |
| `src/tools/AgentTool/` | Modify — Use tier selector for verification agent |

---

## 7. Sentinel Gate (P2, from oh-my-claudecode)

**Source**: `/Users/heal/oh-my-claudecode/src/sentinel-gate.ts`

### 接口定义

```typescript
interface SentinelGateConfig {
  enabled: boolean
  timeout: number                 // 超时 ms（默认 5000）
  failClosed: boolean             // 默认拒绝策略（默认 true）
  degradeToAllow: boolean         // 超时时降级为 allow（默认 true，离线友好）
}

interface SentinelCheckResult {
  allowed: boolean
  reason?: string
  healthStatus: 'healthy' | 'degraded' | 'unavailable'
  latencyMs: number
}

interface SentinelGate {
  check(claims: Record<string, unknown>): Promise<SentinelCheckResult>
  waitForReadiness(timeoutMs?: number): Promise<boolean>
}
```

### Design

- **Fail-Closed**: Default deny when gate enabled but no checks running
- `checkSentinelReadiness()`: Log health + fact check
- `waitForSentinelReadiness()`: Poll with timeout
- Claims sanitization: Force array field types

### 超时降级

sentinel 服务不可达时，超时 5s 后降级为 allow（而非 deny），避免离线场景阻断正常工作流。降级时记录 warning 日志并通知用户 sentinel 服务状态。

### Integration

| File | Operation |
|------|-----------|
| `src/services/singularity/sentinelGate.ts` | **New** |
| `src/services/singularity/EvolutionEngine.ts` | Modify — Consume sentinel gate as quality gate |

---

## 8. Feature Flags

| Flag | 控制范围 | 默认值 |
|------|---------|--------|
| `SSRF_GUARD` | SSRF 防护（内网阻断、DNS rebinding） | off |
| `SECRET_SCANNER` | Secret 扫描与脱敏 | off |
| `BASH_SECURITY` | 增强 Bash 危险命令检测 | off |
| `URL_REDACTION` | URL 敏感参数脱敏 | off |
| `VERIFICATION_TIER` | 三级验证选择器 | off |
| `SENTINEL_GATE` | Sentinel 质量门控 | off |
| `ENV_SECURITY_SYNC` | 环境变量安全同步 | off |

每个子系统独立 feature flag，可单独启用/禁用，确保向后兼容。

---

## 9. 实施路线图

### Phase 1: P0 安全基线 (Week 1-2)

| 任务 | 优先级 | 难度 | 依赖 | 预估 LOC |
|------|--------|------|------|----------|
| SSRF Guard | P0 | Hard | 无 | ~320 |
| Secret Scanner | P0 | Medium | 无 | ~280 |
| URL Redaction | P0 | Easy | 无 | ~135 |
| **Phase 1 合计** | | | | **~735** |

**目标**: 阻断内网访问、敏感信息泄露、URL 凭据暴露三大 P0 风险。

### Phase 2: P1 运行时加固 (Week 3-4)

| 任务 | 优先级 | 难度 | 依赖 | 预估 LOC |
|------|--------|------|------|----------|
| Enhanced Bash Security | P1 | Medium | Phase 1 SSRF Guard（共享 IP 工具函数） | ~375 |
| Env Variable Security Sync | P1 | Easy | 无 | ~40 |
| **Phase 2 合计** | | | | **~415** |

**目标**: 加固 shell 命令执行安全，补齐环境变量隔离。

### Phase 3: P2 智能门控 (Week 5-6)

| 任务 | 优先级 | 难度 | 依赖 | 预估 LOC |
|------|--------|------|------|----------|
| Verification Tier Selector | P2 | Medium | AgentTool | ~220 |
| Sentinel Gate | P2 | Medium | EvolutionEngine | ~195 |
| **Phase 3 合计** | | | | **~415** |

**目标**: 引入自适应验证强度和质量门控，提升 agent 输出可信度。

### 依赖关系图

```
Phase 1 (P0):  SSRF Guard ──┐
               Secret Scanner │
               URL Redaction  │
                              ▼
Phase 2 (P1):  Enhanced Bash Security (复用 SSRF 的 IP 工具函数)
               Env Variable Sync
                              ▼
Phase 3 (P2):  Verification Tier Selector
               Sentinel Gate
```

### 回滚策略

每个 Phase 独立部署，通过 feature flag 控制。任一 Phase 出现问题可单独禁用：
1. 设置对应环境变量为 `0` 或删除
2. 代码路径自动降级到原有逻辑（无 flag 时跳过新安全检查）
3. 不影响其他 Phase 的功能
