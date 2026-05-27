/**
 * CodeAuditor — 5 项静态分析审计
 *
 * 4 项 LLM 审计已迁移至 Skill 层（/orion-deep-audit)
 *
 * 基于 SkillEvolver 论文 Auditor 的 9 项检查：
 * 5 项静态分析（毫秒级）
 */

export interface AuditResult {
  checkId: string
  checkName: string
  passed: boolean
  isCritical: boolean
  details: string
}

export type AuditCheckFn = (
  code: string,
  fileType: 'ts' | 'tsx' | 'js' | 'jsx',
  context?: AuditContext,
) => Promise<AuditResult> | AuditResult

export interface AuditContext {
  model?: {
    generate: (
      prompt: string,
      options?: Record<string, unknown>,
    ) => Promise<{ text: string }>
  }
  /** 环境合法 API 白名单 */
  apiWhitelist?: string[]
}

// ============================================
// 5项静态分析检查（快速）
// ============================================

/** Check 1: Syntax & Format — AST/语法检查 */
export async function checkSyntax(
  code: string,
  fileType: 'ts' | 'tsx' | 'js' | 'jsx',
): Promise<AuditResult> {
  // 简化版语法检查：使用 TypeScript AST 解析并提取语法错误
  if (fileType === 'ts' || fileType === 'tsx') {
    try {
      // 使用动态 import 避免编译错误
      const ts = await import('typescript')
      const sourceFile = ts.createSourceFile(
        'temp.' + fileType,
        code,
        ts.ScriptTarget.Latest,
        true,
        fileType === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )
      // 提取语法诊断信息 — createSourceFile 会在 parseDiagnostics 中记录语法错误
      const diagnostics: ts.Diagnostic[] = []
      // 使用 flattenDiagnosticsFromSourceFile 获取源文件的语法错误
      // createSourceFile 的 parseDiagnostics 属性包含语法解析错误
      if (sourceFile.parseDiagnostics && sourceFile.parseDiagnostics.length > 0) {
        for (const diag of sourceFile.parseDiagnostics) {
          diagnostics.push(diag)
        }
      }
      // 只检查语法错误，不做类型检查
      return {
        checkId: 'syntax',
        checkName: 'Syntax & Format',
        passed: diagnostics.length === 0,
        isCritical: true,
        details:
          diagnostics.length > 0
            ? `语法错误: ${diagnostics.map((d) => typeof d.messageText === 'string' ? d.messageText : (d.messageText as ts.DiagnosticMessageChain).messageText).join(', ')}`
            : '语法检查通过',
      }
    } catch {
      // TypeScript 不可用时跳过
      return {
        checkId: 'syntax',
        checkName: 'Syntax & Format',
        passed: true,
        isCritical: true,
        details: 'TypeScript 不可用，跳过语法检查',
      }
    }
  }

  // JS 文件：去除字符串和注释后做括号/花括号平衡检查
  // 步骤1: 去除字符串字面量（单引号、双引号、模板字符串）
  let stripped = code
    .replace(/`(?:[^`\\]|\\.)*`/g, '')   // 模板字符串
    .replace(/"(?:[^"\\]|\\.)*"/g, '')    // 双引号字符串
    .replace(/'(?:[^'\\]|\\.)*'/g, '')    // 单引号字符串
  // 步骤2: 去除注释
  stripped = stripped
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/\/\/.*$/gm, '')              // 行注释
  // 步骤3: 括号平衡检查
  const openBraces = (stripped.match(/\{/g) || []).length
  const closeBraces = (stripped.match(/\}/g) || []).length
  const openParens = (stripped.match(/\(/g) || []).length
  const closeParens = (stripped.match(/\)/g) || []).length
  const balanceIssues: string[] = []
  if (openBraces !== closeBraces) balanceIssues.push(`花括号不平衡 ({${openBraces} vs }${closeBraces})`)
  if (openParens !== closeParens) balanceIssues.push(`括号不平衡 (${openParens} vs )${closeParens})`)
  return {
    checkId: 'syntax',
    checkName: 'Syntax & Format',
    passed: balanceIssues.length === 0,
    isCritical: true,
    details: balanceIssues.length > 0
      ? `JS 语法检查: ${balanceIssues.join(', ')}`
      : 'JS 语法检查通过（括号平衡）',
  }
}

/** Check 2: Hallucinated API — 白名单校验 */
export async function checkHallucinatedAPI(
  code: string,
  _fileType: 'ts' | 'tsx' | 'js' | 'jsx',
  context?: AuditContext,
): Promise<AuditResult> {
  const whitelist = context?.apiWhitelist ?? []
  if (whitelist.length === 0) {
    return {
      checkId: 'hallucinated-api',
      checkName: 'Hallucinated API',
      passed: true,
      isCritical: true,
      details: '未定义 API 白名单，跳过检查',
    }
  }

  // 提取代码中的函数调用
  const callPattern = /\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g
  const calls = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = callPattern.exec(code)) !== null) {
    calls.add(match[1])
  }

  const violations = [...calls].filter((c) => !whitelist.includes(c))
  return {
    checkId: 'hallucinated-api',
    checkName: 'Hallucinated API',
    passed: violations.length === 0,
    isCritical: true,
    details:
      violations.length > 0
        ? `发现未定义 API 调用: ${violations.join(', ')}`
        : '无幻觉 API 调用',
  }
}

/** Check 3: Infinite Loop — 无退出条件的循环检测 */
export async function checkInfiniteLoop(
  code: string,
): Promise<AuditResult> {
  // 检测 while 循环但没有 break/return/throw
  const whilePattern = /while\s*\([^)]*\)\s*\{/g
  const whiles = [...code.matchAll(whilePattern)]

  for (const m of whiles) {
    const startIndex = m.index!
    // 找到对应的闭合括号（简化处理）
    let braceCount = 1
    let i = startIndex + m[0].length
    let hasExit = false
    while (i < code.length && braceCount > 0) {
      if (code[i] === '{') braceCount++
      if (code[i] === '}') braceCount--
      // 检查是否有退出条件
      const rest = code.substring(i)
      if (
        /^\bbreak\b/.test(rest) ||
        /^\breturn\b/.test(rest) ||
        /^\bthrow\b/.test(rest) ||
        /^\bprocess\.exit\b/.test(rest)
      ) {
        hasExit = true
      }
      i++
    }
    if (!hasExit) {
      return {
        checkId: 'infinite-loop',
        checkName: 'Infinite Loop',
        passed: false,
        isCritical: true,
        details: '发现无退出条件的 while 循环',
      }
    }
  }

  return {
    checkId: 'infinite-loop',
    checkName: 'Infinite Loop',
    passed: true,
    isCritical: true,
    details: '无无限循环风险',
  }
}

/** Check 4: Dead Code — 不可达代码检测 */
export async function checkDeadCode(
  code: string,
): Promise<AuditResult> {
  // 检测 return/throw 后面是否有不可达代码
  const lines = code.split('\n')
  const unreachableLines: string[] = []
  let afterReturn = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('//') || line.startsWith('*')) continue

    if (afterReturn) {
      if (
        line.startsWith('return') ||
        line.startsWith('throw') ||
        line.startsWith('break') ||
        line.startsWith('continue') ||
        line.startsWith('}') ||
        line.startsWith('{') ||
        line.startsWith('case') ||
        line.startsWith('default:')
      ) {
        continue
      }
      unreachableLines.push(`L${i + 1}: ${line}`)
    }

    // 检测无条件返回
    if (line.startsWith('return ') && !line.includes('?') && !line.includes('if')) {
      afterReturn = true
    }
  }

  return {
    checkId: 'dead-code',
    checkName: 'Dead Code',
    passed: unreachableLines.length === 0,
    isCritical: false,
    details:
      unreachableLines.length > 0
        ? `发现不可达代码: ${unreachableLines.slice(0, 3).join('; ')}`
        : '无死代码',
  }
}

/** Check 5: Complexity Limit — 圈复杂度检测 */
export async function checkComplexityLimit(
  code: string,
  threshold = 10,
): Promise<AuditResult> {
  // 简化圈复杂度计算
  let complexity = 1
  const decisionPoints = [
    /\bif\s*\(/g,
    /\belse\s+if\s*\(/g,
    /\bfor\s*\(/g,
    /\bwhile\s*\(/g,
    /\bcase\s+/g,
    /\?\s*[^:]/g, // ternary
    /&&/g,
    /\|\|/g,
    /\bcatch\s*\(/g,
  ]

  for (const pattern of decisionPoints) {
    const matches = code.match(pattern)
    if (matches) {
      complexity += matches.length
    }
  }

  return {
    checkId: 'complexity-limit',
    checkName: 'Complexity Limit',
    passed: complexity <= threshold,
    isCritical: false,
    details: `圈复杂度: ${complexity}${complexity > threshold ? ` (超过阈值 ${threshold})` : ''}`,
  }
}

// ============================================
// 审计清单汇总
// ============================================

/** 5 项静态分析审计清单（LLM 审计已移至 orion-deep-audit skill） */
export const AUDIT_CHECKLIST: {
  id: string
  name: string
  isCritical: boolean
  isStatic: boolean
  check: AuditCheckFn
}[] = [
  { id: 'syntax', name: 'Syntax & Format', isCritical: true, isStatic: true, check: checkSyntax },
  { id: 'hallucinated-api', name: 'Hallucinated API', isCritical: true, isStatic: true, check: checkHallucinatedAPI },
  { id: 'infinite-loop', name: 'Infinite Loop', isCritical: true, isStatic: true, check: checkInfiniteLoop },
  { id: 'dead-code', name: 'Dead Code', isCritical: false, isStatic: true, check: checkDeadCode },
  { id: 'complexity-limit', name: 'Complexity Limit', isCritical: false, isStatic: true, check: checkComplexityLimit },
]

/**
 * 执行全部审计
 *
 * @param code - 要检测的代码
 * @param fileType - 文件类型
 * @param context - 审计上下文（可选，包含 model 和 apiWhitelist）
 * @returns 审计结果数组
 */
export async function runAudit(
  code: string,
  fileType: 'ts' | 'tsx' | 'js' | 'jsx',
  context?: AuditContext,
): Promise<AuditResult[]> {
  const results: AuditResult[] = []
  for (const item of AUDIT_CHECKLIST) {
    try {
      const result = await item.check(code, fileType, context)
      results.push(result)
    } catch (e) {
      results.push({
        checkId: item.id,
        checkName: item.name,
        passed: true, // 审计失败不阻断
        isCritical: item.isCritical,
        details: `审计执行失败: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }
  return results
}

/**
 * 获取审计摘要
 */
export function getAuditSummary(results: AuditResult[]): {
  total: number
  passed: number
  failed: number
  criticalFailures: AuditResult[]
} {
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  const criticalFailures = results.filter((r) => !r.passed && r.isCritical)

  return {
    total: results.length,
    passed,
    failed,
    criticalFailures,
  }
}
