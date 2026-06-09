// 脱敏规则：匹配常见敏感模式并遮蔽值
// 使用后缀匹配 (_TOKEN/_KEY/_SECRET 等) 避免误匹配如 MONKEY_PATCH_ENABLED
// 包含完整敏感词 (如 GITHUB_TOKEN) 直接匹配
const SENSITIVE_PATTERNS = [
  /(?:^|_)TOKEN$/i, /(?:^|_)KEY$/i, /(?:^|_)SECRET$/i,
  /(?:^|_)PASSWORD$/i, /(?:^|_)CREDENTIAL$/i, /(?:^|_)CRED$/i,
  /DATABASE_URL$/i, /REDIS_URL$/i, /MONGO_URI$/i, /(?:^|_)SMTP$/i,
  /GITHUB_TOKEN$/i, /NPM_TOKEN$/i, /AWS_ACCESS_KEY$/i, /API_KEY$/i,
  // I3: 补充常见敏感模式
  /(?:^|_)AUTHORIZATION$/i, /(?:^|_)COOKIE$/i, /(?:^|_)SESSION$/i,
  /(?:^|_)JWT$/i, /(?:^|_)BEARER$/i, /(?:^|_)PRIVATE_KEY$/i,
  /CONNECTION_STRING$/i,
]

export function redactEnv(env: string[]): string[] {
  return env.map(e => {
    const [key, ...rest] = e.split('=')
    if (SENSITIVE_PATTERNS.some(p => p.test(key))) {
      return `${key}=<REDACTED>`
    }
    // I4: URL 中的密码: postgres://user:password@host → postgres://user:***@host
    // 外层判断与内部替换正则均使用贪婪匹配到最后一个 @
    const value = rest.join('=')
    if (/:\/\/[^:]*:.*@/.test(value)) {
      return `${key}=${value.replace(/(:\/\/[^:]*:).*@/, '$1***@')}`
    }
    return e
  })
}

export function redactCmdline(cmdline: string): string {
  return cmdline
    .replace(/--password=\S+/g, '--password=<REDACTED>')
    .replace(/--token=\S+/g, '--token=<REDACTED>')
    .replace(/--api-key=\S+/g, '--api-key=<REDACTED>')
    // I3: 补充常见命令行敏感参数
    .replace(/--secret=\S+/g, '--secret=<REDACTED>')
    .replace(/--secret-key=\S+/g, '--secret-key=<REDACTED>')
    .replace(/--access-key=\S+/g, '--access-key=<REDACTED>')
    .replace(/--private-key=\S+/g, '--private-key=<REDACTED>')
    .replace(/--auth-token=\S+/g, '--auth-token=<REDACTED>')
    .replace(/--bearer-token=\S+/g, '--bearer-token=<REDACTED>')
    .replace(/--db-password=\S+/g, '--db-password=<REDACTED>')
    .replace(/--redis-password=\S+/g, '--redis-password=<REDACTED>')
}
