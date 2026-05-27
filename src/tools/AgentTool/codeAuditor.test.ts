/**
 * CodeAuditor — 5 项静态审计清单完整测试
 * 4 项 LLM 审计已迁移至 Skill 层（/orion-deep-audit）
 *
 * Run: bun test src/tools/AgentTool/codeAuditor.test.ts
 */

import { describe, it, expect } from 'bun:test'
import {
  checkSyntax,
  checkHallucinatedAPI,
  checkInfiniteLoop,
  checkDeadCode,
  checkComplexityLimit,
  runAudit,
  getAuditSummary,
  AUDIT_CHECKLIST,
} from './codeAuditor'

// ============================================
// 通用：审计清单完整性
// ============================================

describe('AUDIT_CHECKLIST', () => {
  it('should have exactly 5 static checks', () => {
    expect(AUDIT_CHECKLIST.length).toBe(5)
  })

  it('should have correct IDs', () => {
    const ids = AUDIT_CHECKLIST.map(c => c.id)
    expect(ids).toEqual(['syntax', 'hallucinated-api', 'infinite-loop', 'dead-code', 'complexity-limit'])
  })

  it('should all be static checks', () => {
    for (const check of AUDIT_CHECKLIST) {
      expect(check.isStatic).toBe(true)
    }
  })
})

// ============================================
// Check 1: Syntax & Format
// ============================================

describe('checkSyntax', () => {
  it('should pass for valid TypeScript code', async () => {
    const result = await checkSyntax('const x: number = 42;', 'ts')
    expect(result.passed).toBe(true)
    expect(result.checkId).toBe('syntax')
  })

  it('should handle empty code', async () => {
    const result = await checkSyntax('', 'ts')
    expect(result.checkId).toBe('syntax')
  })
})

// ============================================
// Check 2: Hallucinated API
// ============================================

describe('checkHallucinatedAPI', () => {
  it('should pass when no whitelist defined', async () => {
    const result = await checkHallucinatedAPI('foo()', 'ts')
    expect(result.passed).toBe(true)
    expect(result.details).toContain('未定义 API 白名单')
  })

  it('should pass when all calls are whitelisted', async () => {
    const result = await checkHallucinatedAPI('console.log("hi")', 'ts', { apiWhitelist: ['log'] })
    expect(result.passed).toBe(true)
  })

  it('should detect non-whitelisted API calls', async () => {
    const result = await checkHallucinatedAPI('foo.bar(); baz.qux()', 'ts', { apiWhitelist: ['bar'] })
    expect(result.passed).toBe(false)
    expect(result.details).toContain('qux')
    expect(result.isCritical).toBe(true)
  })
})

// ============================================
// Check 3: Infinite Loop
// ============================================

describe('checkInfiniteLoop', () => {
  it('should pass for normal code', async () => {
    const result = await checkInfiniteLoop('const x = 1;')
    expect(result.passed).toBe(true)
  })

  it('should detect while loop with break', async () => {
    const result = await checkInfiniteLoop('while (true) { if (condition) break; }')
    expect(result.passed).toBe(true)
  })

  it('should fail for while loop without exit', async () => {
    const result = await checkInfiniteLoop('while (true) { doSomething(); }')
    expect(result.passed).toBe(false)
    expect(result.isCritical).toBe(true)
  })
})

// ============================================
// Check 4: Dead Code
// ============================================

describe('checkDeadCode', () => {
  it('should detect unreachable code after unconditional return', async () => {
    const result = await checkDeadCode('function test() {\n  return 1;\n  console.log("unreachable");\n}')
    expect(result.passed).toBe(false)
    expect(result.checkId).toBe('dead-code')
  })
})

// ============================================
// Check 5: Complexity Limit
// ============================================

describe('checkComplexityLimit', () => {
  it('should pass for simple code', async () => {
    const result = await checkComplexityLimit('return "hello"')
    expect(result.passed).toBe(true)
  })

  it('should fail for complex code with many branches', async () => {
    const code = `
if (a) {
  if (b && c) {
    for (let i = 0; i < 10; i++) {
      while (x) {
        switch (y) {
          case 1: break;
          case 2: continue;
          default: return;
        }
      }
    }
  } else if (d || e) {
    try { } catch (err) { }
  }
}`.trim()
    const result = await checkComplexityLimit(code, 10)
    expect(result.passed).toBe(false)
    expect(result.details).toContain('超过阈值')
  })

  it('should accept custom threshold', async () => {
    const code = 'if (a) { if (b) {} }'
    const result = await checkComplexityLimit(code, 2)
    expect(result.passed).toBe(false)
  })
})

// ============================================
// Orchestrator: runAudit
// ============================================

describe('runAudit', () => {
  it('should run all 5 checks and return results', async () => {
    const results = await runAudit('const x = 1;', 'ts')
    expect(results.length).toBe(5)
    for (const r of results) {
      expect(r.checkId).toBeDefined()
      expect(r.checkName).toBeDefined()
      expect(typeof r.passed).toBe('boolean')
      expect(r.details).toBeDefined()
    }
  })
})

// ============================================
// Summary: getAuditSummary
// ============================================

describe('getAuditSummary', () => {
  it('should count totals correctly', () => {
    const summary = getAuditSummary([
      { checkId: '1', checkName: 'A', passed: true, isCritical: true, details: '' },
      { checkId: '2', checkName: 'B', passed: false, isCritical: true, details: '' },
      { checkId: '3', checkName: 'C', passed: false, isCritical: false, details: '' },
    ])
    expect(summary.total).toBe(3)
    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(2)
    expect(summary.criticalFailures.length).toBe(1)
  })
})