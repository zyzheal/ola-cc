/**
 * WebFetch工具常量定义
 * 避免魔法数字和硬编码字符串
 */

// Node.js 环境检测
export const IS_NODE =
  typeof process !== 'undefined' &&
  process.versions != null &&
  process.versions.node != null

// 浏览器环境检测
export const IS_BROWSER = typeof window !== 'undefined' && window !== null

// 存储适配器 - 提供 localStorage API 的跨环境实现
export const storageAdapter = {
  getItem(key: string): string | null {
    if (IS_BROWSER && typeof localStorage !== 'undefined') {
      return localStorage.getItem(key)
    }
    // Node.js 环境：使用内存存储（CLI 是短期运行的）
    // 如果需要持久化，可以使用文件系统存储
    return null
  },
  setItem(_key: string, _value: string): void {
    if (IS_BROWSER && typeof localStorage !== 'undefined') {
      localStorage.setItem(_key, JSON.stringify(_value))
    }
    // Node.js 环境：忽略写入（CLI 是短期运行的）
  },
  removeItem(key: string): void {
    if (IS_BROWSER && typeof localStorage !== 'undefined') {
      localStorage.removeItem(key)
    }
  },
  clear(): void {
    if (IS_BROWSER && typeof localStorage !== 'undefined') {
      localStorage.clear()
    }
  },
}

// 超时常量
export const TIMEOUTS = {
  DOMAIN_CHECK: 10_000, // 10 seconds
  FETCH: 60_000, // 60 seconds
  CONFIRMATION: 5 * 60_000, // 5 minutes
} as const

// 缓存常量
export const CACHE = {
  TTL_URL: 15 * 60 * 1000, // 15 minutes
  TTL_DOMAIN_CHECK: 5 * 60 * 1000, // 5 minutes
  MAX_URL_CACHE_SIZE: 50 * 1024 * 1024, // 50MB
  MAX_DOMAIN_CACHE_SIZE: 128, // number of domains
} as const

// 限制常量
export const LIMITS = {
  MAX_URL_LENGTH: 2000,
  MAX_MARKDOWN_LENGTH: 100_000,
  MAX_HTML_BEFORE_TURNDOWN: 500_000,
  MAX_REDIRECTS: 10,
  MAX_HTTP_CONTENT_LENGTH: 10 * 1024 * 1024,
  MAX_CONFIRMATION_ATTEMPTS: 3,
} as const

// 错误类型
export const ERROR_TYPES = {
  DOMAIN_BLOCKED: 'DOMAIN_BLOCKED',
  DOMAIN_CHECK_FAILED: 'DOMAIN_CHECK_FAILED',
  DOMAIN_CHECK_REQUIRES_CONFIRMATION: 'DOMAIN_CHECK_REQUIRES_CONFIRMATION',
  EGRESS_BLOCKED: 'EGRESS_BLOCKED',
} as const

// 状态码
export const STATUS_CODES = {
  SUCCESS: 200,
  REDIRECT: {
    MOVED_PERMANENTLY: 301,
    FOUND: 302,
    TEMPORARY_REDIRECT: 307,
    PERMANENT_REDIRECT: 308,
  },
  FORBIDDEN: 403,
} as const

// 用户操作选项
export const USER_ACTIONS = {
  ALLOW: 'allow',
  DENY: 'deny',
  SKIP: 'skip',
} as const

// 错误消息模板
export const ERROR_MESSAGES = {
  // URL相关错误
  INVALID_URL: (url: string) => `❌ 无效的URL: ${url}`,
  URL_VALIDATION_FAILED: (error: string) => `❌ URL验证失败: ${error}`,
  INVALID_DOMAIN: (domain: string) => `❌ 无效的域名: ${domain}`,

  // 域名检查错误
  DOMAIN_CHECK_UNAVAILABLE: (domain: string) =>
    `⚠️ 无法验证域名 ${domain} 的安全性。

这可能是由以下原因造成的：
• 网络限制或企业安全策略阻止了对检查服务器的访问
• 域名检查服务暂时不可用
• 防火墙或代理配置问题

请使用 confirm_domain_access 工具来确认是否继续访问。`,

  DOMAIN_CHECK_SERVER_ERROR: (domain: string, status: number) =>
    `⚠️ 无法验证域名 ${domain} 的安全性。

服务器返回错误状态码: ${status}

这可能是由以下原因造成的：
• 域名检查服务器内部错误
• 请求格式不正确
• 服务暂时不可用

请稍后重试或使用 confirm_domain_access 工具来确认访问。`,

  DOMAIN_FORMAT_ANOMALY: (domain: string, category?: string) =>
    `⚠️ 域名格式异常: ${domain}

${category ? `检测到域名类型: ${category}` : ''}
这可能是由以下原因造成的：
• 域名包含特殊字符
• 域名格式不符合标准
• 可能是恶意或伪造的域名

请谨慎处理并确认是否要继续访问。`,

  CONFIRMATION_REQUIRED: (domain: string, category?: string) =>
    `🔒 需要确认域名访问权限

域名: ${domain}
${category ? `类型: ${category}` : ''}

由于无法自动验证此域名的安全性，需要您手动确认是否要访问。`,

  // WebFetch确认消息模板
  WEBFETCH_CONFIRMATION_REQUIRED: (domain: string, category?: string, previousChoice?: string) =>
    `🔒 无法验证域名 ${domain} 的安全性

${category ? `📂 域名类型: ${category}` : ''}
${previousChoice ? `🕒 之前的选择: ${previousChoice}` : ''}
⚠️ 这可能是由以下原因造成的:
• 网络限制或企业安全策略
• 域名检查服务暂时不可用
• 防火墙或代理配置问题

请使用 confirm_domain_access 工具来确认是否要继续访问。`,

  WEBFETCH_OPTIONS_INSTRUCTIONS: (url: string, domain: string, suggestion?: string) =>
    `📋 请选择操作以继续访问域名: ${domain}

${suggestion ? `💡 智能建议: ${suggestion}` : ''}

🔧 可用选项:
1. 🟢 confirm_domain_access(url: "${url}", action: "allow")
   - 允许访问并将域名添加到信任列表

2. ⚡ confirm_domain_access(url: "${url}", action: "skip")
   - 仅此次跳过检查，不记忆选择

3. 🔴 confirm_domain_access(url: "${url}", action: "deny")
   - 拒绝访问此域名

📝 提示:
• 选择 "allow" 将记住您的选择，下次访问时不再询问
• 选择 "skip" 仅影响当前请求
• 某些域名类型可能有特殊处理（如学术网站）`,

  // 成功消息
  FETCH_SUCCESS: (domain: string, size: number) =>
    `✅ 成功获取域名 ${domain} 的内容
📊 内容大小: ${formatFileSize(size)}`,

  FETCH_BLOCKED: (domain: string) =>
    `🚫 访问被阻止
域名: ${domain}
原因: 用户已拒绝访问或域名在黑名单中`,

  // 配置相关消息
  CONFIG_UPDATED: (setting: string, value: any) =>
    `⚙️ 配置已更新
${setting}: ${value}`,

  CONFIG_INVALID: (errors: string[]) =>
    `❌ 配置无效
错误详情:
${errors.map(e => `• ${e}`).join('\n')}`,

  // 偏好相关消息
  PREFERENCE_RECORDED: (domain: string, action: string) =>
    `📝 已记录偏好设置
域名: ${domain}
操作: ${action}`,

  PREFERENCE_CLEARED: () =>
    `🧹 已清除所有域名偏好设置`,

  // 帮助信息
  HELP_CONFIRMATION: () =>
    `📖 如何使用域名确认功能

当遇到无法验证的域名时，系统会提示您进行确认：

1. 🟢 允许 (allow): 添加到信任列表，下次自动允许
2. ⚡ 跳过 (skip): 仅本次生效，不记录偏好
3. 🔴 拒绝 (deny): 添加到黑名单，阻止访问

💡 提示：
• 学术网站通常安全，建议选择允许
• 不熟悉的网站建议先选择跳过
• 定期检查偏好设置以确保安全`,

  // 统计信息
  STATISTICS: (stats: any) =>
    `📊 域名偏好统计
总域名数: ${stats.totalDomains}
允许域名: ${stats.allowedDomains}
拒绝域名: ${stats.deniedDomains}
最近确认: ${stats.recentConfirmations}

按类型分类:
${Object.entries(stats.categories || {}).map(([cat, count]) => `• ${cat}: ${count}`).join('\n')}`,
} as const

// 辅助函数
function formatFileSize(bytes: number): string {
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  if (bytes === 0) return '0 Bytes'
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i]
}

// 域名类别
export const DOMAIN_CATEGORIES = {
  ACADEMIC: 'academic',
  NEWS: 'news',
  TECH: 'tech',
  GOVERNMENT: 'government',
  EDUCATION: 'education',
  SOCIAL_MEDIA: 'social_media',
  E_COMMERCE: 'ecommerce',
  UNKNOWN: 'unknown',
} as const

// 域名声誉
export const DOMAIN_REPUTATION = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const

// 用户偏好存储键
export const STORAGE_KEYS = {
  DOMAIN_PREFERENCES: 'web_fetch_domain_preferences',
  RECENT_CONFIRMATIONS: 'web_fetch_recent_confirmations',
} as const

// 配置选项
export const CONFIG_OPTIONS = {
  AUTO_CONFIRM: {
    ENABLED: 'autoConfirm.enabled',
    TIMEOUT: 'autoConfirm.timeout',
    MAX_ATTEMPTS: 'autoConfirm.maxAttempts',
  },
  BEHAVIOR: {
    SKIP_PREFLIGHT: 'webFetch.skipPreflight',
    ALLOW_ACADEMIC: 'webFetch.allowAcademic',
    ALLOW_TRUSTED: 'webFetch.allowTrusted',
  },
} as const