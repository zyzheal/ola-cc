/**
 * Core TypeScript AST checker for type safety and syntax validation.
 *
 * Lightweight AST analysis focused on TypeScript-specific issues that
 * cannot be detected with regex: type checking, syntax validation,
 * and structural code analysis.
 *
 * Usage:
 *   const results = await runASTCheck(files, checks)
 *
 * Design:
 *   - Parse with ts.createSourceFile (lightweight, no type checker)
 *   - Walk AST with ts.forEachChild visitor pattern
 *   - Only essential type safety checks, no business logic detection
 */

import { promises as fs } from 'node:fs'
import { join, relative, dirname, basename } from 'node:path'
import * as ts from 'typescript'

// -- Types

export interface ASTCheckResult {
  file: string
  line: number
  column: number
  check: string
  message: string
  severity: 'error' | 'warning' | 'info'
  fix?: string
}

// -- Exclusion Rules

const EXCLUDE_PATTERNS = [
  /\/node_modules\//,
  /\/\.(git|next|output|cache|vite|dist)\//,
  /\.d\.ts$/,
  /\.test\.(ts|tsx)$/,
  /\.spec\.(ts|tsx)$/,
]

function shouldExcludeFile(filePath: string): boolean {
  return EXCLUDE_PATTERNS.some(p => p.test(filePath))
}

// -- Utilities

function indexToLineColumn(source: ts.SourceFile, pos: number): { line: number; column: number } {
  const lineAndChar = source.getLineAndCharacterOfPosition(pos)
  return {
    line: lineAndChar.line + 1,
    column: lineAndChar.character + 1,
  }
}

async function readFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8')
  }
  catch {
    return null
  }
}

function parseSourceFile(filePath: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function makeResult(
  source: ts.SourceFile,
  node: ts.Node,
  check: string,
  message: string,
  severity: 'error' | 'warning' | 'info',
  fix?: string,
): ASTCheckResult {
  const { line, column } = indexToLineColumn(source, node.getStart(source))
  return {
    file: source.fileName,
    line,
    column,
    check,
    message,
    severity,
    fix,
  }
}

// -- Core TypeScript Type Safety Checks --

/**
 * Check 1: Unused variable
 * Detect VariableDeclaration never referenced.
 */
function checkUnusedVariable(
  source: ts.SourceFile,
): ASTCheckResult[] {
  const results: ASTCheckResult[] = []

  // Collect all declared identifiers
  const declared = new Map<string, ts.Identifier>()
  // Collect all referenced identifiers
  const referenced = new Set<string>()

  function collectDeclarations(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text
      if (!declared.has(name)) {
        declared.set(name, node.name)
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const name = node.name.text
      if (!declared.has(name)) {
        declared.set(name, node.name)
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text
      if (!declared.has(name)) {
        declared.set(name, node.name)
      }
    }
    ts.forEachChild(node, collectDeclarations)
  }

  function collectReferences(node: ts.Node) {
    // Identifiers that are NOT the left side of a declaration
    if (ts.isIdentifier(node)) {
      // Check if parent is a variable declaration (this is the declaration, not a reference)
      const parent = node.parent
      if (parent && ts.isVariableDeclaration(parent) && parent.name === node) return
      if (parent && ts.isFunctionDeclaration(parent) && parent.name === node) return
      if (parent && ts.isParameter(parent) && parent.name === node) return
      if (parent && ts.isPropertyDeclaration(parent) && parent.name === node) return
      if (parent && ts.isMethodDeclaration(parent) && parent.name === node) return
      if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return
      if (parent && ts.isShorthandPropertyAssignment(parent)) return
      // Skip imports
      if (parent && ts.isImportSpecifier(parent)) return
      if (parent && ts.isImportClause(parent)) return
      // Skip JSX tags
      if (parent && ts.isJsxOpeningLikeElement(parent)) return
      if (parent && ts.isJsxClosingElement(parent)) return
      referenced.add(node.text)
    }
    ts.forEachChild(node, collectReferences)
  }

  collectDeclarations(source)
  collectReferences(source)

  // Filter: declared but never referenced
  // Skip exports, _, and common patterns
  for (const [name, idNode] of declared) {
    if (!referenced.has(name)) {
      // Skip underscore-prefixed (convention for intentionally unused)
      if (name.startsWith('_')) continue
      // Skip exported
      const declNode = idNode.parent
      if (declNode && ts.isVariableDeclaration(declNode) && declNode.parent &&
          ts.isVariableDeclarationList(declNode.parent) && declNode.parent.parent) {
        const varStmt = declNode.parent.parent
        if (ts.isVariableStatement(varStmt) &&
            varStmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
          continue
        }
      }
      results.push(makeResult(source, idNode, 'unused-variable',
        `Variable "${name}" is declared but never used.`,
        'warning',
        `Remove the variable "${name}" or use it.`,
      ))
    }
  }

  return results
}

/**
 * Check 2: Unused import
 * Detect ImportDeclaration where imported names are never used.
 */
function checkUnusedImport(
  source: ts.SourceFile,
): ASTCheckResult[] {
  const results: ASTCheckResult[] = []
  const referenced = new Set<string>()

  // Collect all references
  function collect(node: ts.Node) {
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      // Skip if this is part of the import itself
      if (parent && ts.isImportSpecifier(parent)) return
      if (parent && ts.isImportClause(parent)) return
      if (parent && ts.isImportDeclaration(parent)) return
      if (parent && ts.isNamespaceImport(parent)) return
      // Skip property names
      if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return
      if (parent && ts.isShorthandPropertyAssignment(parent)) return
      referenced.add(node.text)
    }
    ts.forEachChild(node, collect)
  }

  collect(source)

  // Check each import declaration
  function visitImports(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      if (node.importClause) {
        const clause = node.importClause
        // Default import: import X from ...
        if (clause.name && ts.isIdentifier(clause.name)) {
          if (!referenced.has(clause.name.text) && !clause.name.text.startsWith('_')) {
            results.push(makeResult(source, node, 'unused-import',
              `Import "${clause.name.text}" is never used.`,
              'warning',
              `Remove the import or use "${clause.name.text}".`,
            ))
          }
        }
        // Named imports: import { X, Y } from ...
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const spec of clause.namedBindings.elements) {
              const name = (spec.propertyName ?? spec.name).text
              if (!referenced.has(name) && !name.startsWith('_')) {
                results.push(makeResult(source, spec, 'unused-import',
                  `Import "${name}" is never used.`,
                  'warning',
                  `Remove "${name}" from the import.`,
                ))
              }
            }
          }
          // Namespace import: import * as X from ...
          if (ts.isNamespaceImport(clause.namedBindings)) {
            const name = clause.namedBindings.name.text
            if (!referenced.has(name) && !name.startsWith('_')) {
              results.push(makeResult(source, node, 'unused-import',
                `Namespace import "${name}" is never used.`,
                'warning',
                `Remove the namespace import or use "${name}".`,
              ))
            }
          }
        }
      }
    }
    ts.forEachChild(node, visitImports)
  }

  ts.forEachChild(source, visitImports)
  return results
}

/**
 * Check 3: Magic numbers
 * Detect NumericLiteral with > 3 digits not in a const declaration.
 */
function checkMagicNumbers(
  source: ts.SourceFile,
): ASTCheckResult[] {
  const results: ASTCheckResult[] = []

  function visit(node: ts.Node) {
    if (ts.isNumericLiteral(node)) {
      const text = node.getText(source)
      // Check for numbers with 4+ significant digits (ignoring leading zeros, decimals)
      const digitsOnly = text.replace(/[^0-9]/g, '')
      if (digitsOnly.length < 4) {
        ts.forEachChild(node, visit)
        return
      }

      const value = parseFloat(text)
      // Skip 0, 1, -1, 100, 1000, etc. (common small numbers)
      if (value <= 100 && value >= 0 && Number.isInteger(value)) {
        ts.forEachChild(node, visit)
        return
      }

      // Check if it's in a const/let/var declaration (naming it)
      const parent = node.parent
      let isInDeclaration = false
      if (parent && ts.isVariableDeclaration(parent)) {
        isInDeclaration = true
      }
      // Also skip if it's in a comment on the same line
      if (!isInDeclaration) {
        const { line } = indexToLineColumn(source, node.getStart(source))
        const sourceLines = source.getFullText(source).split('\n')
        if (line > 0 && line <= sourceLines.length) {
          const lineText = sourceLines[line - 1] || ''
          const beforeNum = lineText.slice(0, node.getStart(source) - source.getFullText(source).indexOf(node.getText(source)))
          if (/\/\/|\/\*/.test(beforeNum)) {
            ts.forEachChild(node, visit)
            return
          }
        }
      }

      if (!isInDeclaration) {
        results.push(makeResult(source, node, 'magic-number',
          `Magic number ${text}. Consider defining a named constant.`,
          'info',
          `Define a const with a descriptive name (e.g., const TIMEOUT_MS = ${text}).`,
        ))
      }
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(source, visit)
  return results
}

/** Check if a statement is an empty statement (`;`) */
function isEmptyStatement(stmt: ts.Statement): boolean {
  return stmt.kind === ts.SyntaxKind.EmptyStatement
}

/** Check if a statement is `process.exit(...)` */
function isProcessExitCall(stmt: ts.Statement): boolean {
  if (!ts.isExpressionStatement(stmt)) return false
  const expr = stmt.expression
  if (!ts.isCallExpression(expr)) return false
  const callee = expr.expression
  if (!ts.isPropertyAccessExpression(callee)) return false
  return ts.isIdentifier(callee.expression) &&
         callee.expression.text === 'process' &&
         callee.name.text === 'exit'
}

/**
 * Check 4: Unreachable code
 * Detect code after return/throw that's not in else/if.
 */
function checkUnreachableCode(
  source: ts.SourceFile,
): ASTCheckResult[] {
  const results: ASTCheckResult[] = []

  function visitBlockStatements(node: ts.Node) {
    if (ts.isBlock(node)) {
      const statements = node.statements
      for (let i = 0; i < statements.length - 1; i++) {
        const stmt = statements[i]
        // Check if this statement unconditionally terminates
        const terminates = ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt) ||
                          isProcessExitCall(stmt)

        if (terminates) {
          const nextStmt = statements[i + 1]
          // Skip if next is a label or empty statement
          if (ts.isLabeledStatement(nextStmt) || isEmptyStatement(nextStmt)) continue
          // Skip if next is a function/class declaration (hoisted)
          if (ts.isFunctionDeclaration(nextStmt) || ts.isClassDeclaration(nextStmt) ||
              ts.isInterfaceDeclaration(nextStmt) || ts.isTypeAliasDeclaration(nextStmt)) continue
          // Skip if next statement is an if/else after return (dead code in else branch is ok)
          results.push(makeResult(source, nextStmt, 'unreachable-code',
            'Code after return/throw is unreachable.',
            'warning',
            'Remove or restructure the code. This statement will never execute.',
          ))
        }
      }
    }
    ts.forEachChild(node, visitBlockStatements)
  }

  ts.forEachChild(source, visitBlockStatements)
  return results
}

/**
 * Check 5: Implicit any
 * Detect parameters or return types that resolve to 'any' (explicit :any).
 * Note: Without the type checker, we can only detect explicit :any annotations.
 */
function checkImplicitAny(
  source: ts.SourceFile,
): ASTCheckResult[] {
  const results: ASTCheckResult[] = []

  function visit(node: ts.Node) {
    // Explicit : any
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      // Check parent to determine context
      const parent = node.parent
      if (parent && ts.isParameter(parent) && ts.isIdentifier(parent.name)) {
        results.push(makeResult(source, node, 'implicit-any',
          `Parameter "${(parent.name as ts.Identifier).text}" has explicit 'any' type.`,
          'warning',
          `Replace 'any' with a specific type for "${(parent.name as ts.Identifier).text}".`,
        ))
      }
      else if (parent && ts.isVariableDeclaration(parent)) {
        results.push(makeResult(source, node, 'implicit-any',
          'Variable declared with explicit "any" type.',
          'warning',
          'Replace "any" with a more specific type or use "unknown".',
        ))
      }
      else if (parent && ts.isTypeReferenceNode(parent)) {
        // Already handled by the any keyword
      }
      else {
        results.push(makeResult(source, node, 'implicit-any',
          'Explicit "any" type used.',
          'warning',
          'Replace "any" with a more specific type.',
        ))
      }
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(source, visit)
  return results
}

// -- Check Registry

type ASTCheckFn = (source: ts.SourceFile) => ASTCheckResult[]

interface ASTCheckDef {
  name: string
  fn: ASTCheckFn
  globs: string[]
  severity: 'error' | 'warning' | 'info'
  message: string
}

const AST_CHECKS: ASTCheckDef[] = [
  {
    name: 'unused-variable',
    fn: checkUnusedVariable,
    globs: ['**/*.{ts,tsx}'],
    severity: 'warning',
    message: 'Variable declared but never used.',
  },
  {
    name: 'unused-import',
    fn: checkUnusedImport,
    globs: ['**/*.{ts,tsx}'],
    severity: 'warning',
    message: 'Import declared but never used.',
  },
  {
    name: 'magic-number',
    fn: checkMagicNumbers,
    globs: ['**/*.{ts,tsx}'],
    severity: 'info',
    message: 'Magic number detected. Consider defining a named constant.',
  },
  {
    name: 'unreachable-code',
    fn: checkUnreachableCode,
    globs: ['**/*.{ts,tsx}'],
    severity: 'warning',
    message: 'Code after return/throw is unreachable.',
  },
  {
    name: 'implicit-any',
    fn: checkImplicitAny,
    globs: ['**/*.{ts,tsx}'],
    severity: 'warning',
    message: 'Explicit "any" type used. Consider a more specific type.',
  },
]

// -- Glob matching (reuse pattern from regexScanner)

function matchGlob(pattern: string, filePath: string): boolean {
  const p = pattern.replace(/\\/g, '/')
  const f = filePath.replace(/\\/g, '/')

  // Split pattern into segments: brace groups (already regex) and non-brace (needs conversion)
  const segments: string[] = []
  let last = 0
  const braceRe = /\{([^}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = braceRe.exec(p)) !== null) {
    if (m.index > last) {
      segments.push(escapeGlob(p.slice(last, m.index)))
    }
    segments.push(`(${m[1].replace(/,/g, '|')})`)
    last = m.index + m[0].length
  }
  if (last < p.length) {
    segments.push(escapeGlob(p.slice(last)))
  }

  return new RegExp(`^${segments.join('')}$`).test(f)
}

/** Convert a glob segment (no braces) to regex */
function escapeGlob(s: string): string {
  // Escape regex metacharacters (except * and ?)
  let r = s.replace(/[.+^$()[\]\\]/g, '\\$&')
  r = r.replace(/\*\*\//g, '(.+/)?')
  r = r.replace(/\*/g, '[^/]*')
  r = r.replace(/\?/g, '[^/]')
  return r
}

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  }
  catch {
    return []
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (shouldExcludeFile(fullPath + '/')) continue
      results.push(...await walkDir(fullPath))
    }
    else if (entry.isFile()) {
      results.push(fullPath)
    }
  }

  return results
}

async function resolveGlobPattern(pattern: string): Promise<string[]> {
  if (pattern.startsWith('/')) {
    try {
      const stat = await fs.stat(pattern)
      if (stat.isFile()) return [pattern]
      if (stat.isDirectory()) {
        const files = await walkDir(pattern)
        return files.filter(f => !shouldExcludeFile(f))
      }
    }
    catch {
      return []
    }
  }

  const root = process.cwd()
  const prefixMatch = pattern.match(/^([^{*]+)/)
  const prefix = prefixMatch ? prefixMatch[1] : '.'
  const searchDir = join(root, prefix)

  const allFiles = await walkDir(searchDir)
  const relFiles = allFiles.map(f => relative(root, f).replace(/\\/g, '/'))
  return relFiles.filter(f => matchGlob(pattern, f)).map(f => join(root, f))
}

function resolvePaths(paths: string[]): string[] {
  if (paths.length > 0) return paths
  return ['src/**/*.{ts,tsx}']
}

function resolveChecks(checks: string[]): ASTCheckDef[] {
  if (checks.length === 0) return AST_CHECKS
  const names = new Set(checks)
  return AST_CHECKS.filter(c => names.has(c.name))
}

// -- Core Scan Logic

function getApplicableChecks(
  filePath: string,
  checks: ASTCheckDef[],
): ASTCheckDef[] {
  const relPath = relative(process.cwd(), filePath).replace(/\\/g, '/')
  return checks.filter(check =>
    check.globs.some(g => matchGlob(g, relPath)),
  )
}

async function scanFile(
  filePath: string,
  checks: ASTCheckDef[],
): Promise<ASTCheckResult[]> {
  const content = await readFile(filePath)
  if (content === null) return []

  const results: ASTCheckResult[] = []
  const applicableChecks = getApplicableChecks(filePath, checks)
  if (applicableChecks.length === 0) return []

  let source: ts.SourceFile
  try {
    source = parseSourceFile(filePath, content)
  }
  catch {
    return []
  }

  for (const check of applicableChecks) {
    if (shouldExcludeFile(filePath)) continue
    try {
      const findings = check.fn(source)
      results.push(...findings)
    }
    catch {
      // Skip files that fail a specific check
    }
  }

  return results
}

/**
 * Run AST-based code quality checks over the specified file paths.
 *
 * @param filePaths - Array of file paths or glob patterns to scan.
 * @param checks - Array of check names to run. Empty array runs all 5 checks.
 * @returns Array of AST check results sorted by file, line, column.
 */
export async function runASTCheck(
  filePaths: string[],
  checks: string[] = [],
): Promise<ASTCheckResult[]> {
  const checkDefs = resolveChecks(checks)
  const paths = filePaths.length > 0 ? filePaths : ['src/**/*.{ts,tsx}']

  // Collect all matching files
  const fileSet = new Set<string>()
  for (const pattern of paths) {
    const files = await resolveGlobPattern(pattern)
    for (const f of files) {
      if (!shouldExcludeFile(f)) {
        fileSet.add(f)
      }
    }
  }

  const allResults: ASTCheckResult[] = []
  for (const file of fileSet) {
    const results = await scanFile(file, checkDefs)
    allResults.push(...results)
  }

  // Sort by file, then line, then column
  allResults.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    if (a.line !== b.line) return a.line - b.line
    return a.column - b.column
  })

  return allResults
}

/**
 * Return all available AST check definitions.
 */
export function getAvailableASTChecks(): Array<{
  name: string
  severity: 'error' | 'warning' | 'info'
  message: string
  globs: string[]
}> {
  return AST_CHECKS.map(c => ({
    name: c.name,
    severity: c.severity,
    message: c.message,
    globs: c.globs,
  }))
}