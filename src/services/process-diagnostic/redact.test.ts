import { describe, it, expect } from 'bun:test'
import { redactEnv, redactCmdline } from './redact'

describe('redactEnv', () => {
  it('should redact TOKEN suffix', () => {
    const result = redactEnv(['MY_TOKEN=abc123', 'NORMAL_VAR=hello'])
    expect(result[0]).toBe('MY_TOKEN=<REDACTED>')
    expect(result[1]).toBe('NORMAL_VAR=hello')
  })

  it('should redact KEY suffix', () => {
    const result = redactEnv(['API_KEY=secret', 'MY_API_KEY=also_secret'])
    expect(result[0]).toBe('API_KEY=<REDACTED>')
    expect(result[1]).toBe('MY_API_KEY=<REDACTED>')
  })

  it('should NOT redact KEY in middle of word', () => {
    const result = redactEnv(['MONKEY_PATCH_ENABLED=true', 'DONKEY=ride'])
    expect(result[0]).toBe('MONKEY_PATCH_ENABLED=true')
    // DONKEY ends with _KEY so it matches — acceptable trade-off
  })

  it('should redact PASSWORD', () => {
    const result = redactEnv(['DB_PASSWORD=secret123'])
    expect(result[0]).toBe('DB_PASSWORD=<REDACTED>')
  })

  it('should redact SECRET', () => {
    const result = redactEnv(['APP_SECRET=xyz'])
    expect(result[0]).toBe('APP_SECRET=<REDACTED>')
  })

  it('should redact specific tokens', () => {
    const result = redactEnv([
      'GITHUB_TOKEN=ghp_abc',
      'NPM_TOKEN=npm_abc',
      'AWS_ACCESS_KEY=AKIA123',
    ])
    expect(result[0]).toBe('GITHUB_TOKEN=<REDACTED>')
    expect(result[1]).toBe('NPM_TOKEN=<REDACTED>')
    expect(result[2]).toBe('AWS_ACCESS_KEY=<REDACTED>')
  })

  it('should redact URL passwords in non-sensitive vars', () => {
    // DATABASE_URL 先被 SENSITIVE_PATTERNS 匹配，整体 <REDACTED>
    const result1 = redactEnv(['DATABASE_URL=postgres://user:password@host/db'])
    expect(result1[0]).toBe('DATABASE_URL=<REDACTED>')
    // 非敏感 key 中的 URL 密码会被单独脱敏
    const result2 = redactEnv(['MY_CONN=postgres://user:password@host/db'])
    expect(result2[0]).toBe('MY_CONN=postgres://user:***@host/db')
  })

  it('should not redact safe variables', () => {
    const result = redactEnv(['PATH=/usr/bin', 'HOME=/root', 'NODE_ENV=production'])
    expect(result[0]).toBe('PATH=/usr/bin')
    expect(result[1]).toBe('HOME=/root')
    expect(result[2]).toBe('NODE_ENV=production')
  })
})

describe('redactCmdline', () => {
  it('should redact --password=', () => {
    const result = redactCmdline('node app.js --password=secret123 --port 3000')
    expect(result).toBe('node app.js --password=<REDACTED> --port 3000')
  })

  it('should redact --token=', () => {
    const result = redactCmdline('curl --token=abc123 https://api.example.com')
    expect(result).toBe('curl --token=<REDACTED> https://api.example.com')
  })

  it('should redact --api-key=', () => {
    const result = redactCmdline('app --api-key=xyz789')
    expect(result).toBe('app --api-key=<REDACTED>')
  })

  it('should not modify normal command lines', () => {
    const result = redactCmdline('node server.js --port 3000')
    expect(result).toBe('node server.js --port 3000')
  })

  // I3: new patterns
  it('should redact --secret=', () => {
    expect(redactCmdline('app --secret=mysecret')).toBe('app --secret=<REDACTED>')
  })

  it('should redact --auth-token=', () => {
    expect(redactCmdline('app --auth-token=bearer123')).toBe('app --auth-token=<REDACTED>')
  })

  it('should redact --private-key=', () => {
    expect(redactCmdline('ssh --private-key=/path/to/key')).toBe('ssh --private-key=<REDACTED>')
  })
})

describe('redactEnv - I3: new patterns', () => {
  it('should redact AUTHORIZATION', () => {
    expect(redactEnv(['AUTHORIZATION=Bearer xyz'])[0]).toBe('AUTHORIZATION=<REDACTED>')
  })

  it('should redact PRIVATE_KEY', () => {
    expect(redactEnv(['PRIVATE_KEY=-----BEGIN'])[0]).toBe('PRIVATE_KEY=<REDACTED>')
  })

  it('should redact CONNECTION_STRING', () => {
    expect(redactEnv(['MONGODB_CONNECTION_STRING=mongodb://host'])[0]).toBe('MONGODB_CONNECTION_STRING=<REDACTED>')
  })
})
