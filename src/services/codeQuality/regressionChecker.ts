/**
 * Static regression checker for post-code-change verification.
 *
 * After agents modify code, this tool verifies that existing functionality
 * hasn't broken by performing static analysis on imports, exports, and
 * function signatures. It does NOT require running the application.
 *
 * Workflow:
 *   1. Detect changed files via git diff
 *   2. Extract public API surface (exports) from changed files
 *   3. Check that imports from other files still resolve
 *   4. Check that exports haven't been removed
 *   5. Check that function signatures haven't changed incompatibly
 *
 * Usage:
 *   const findings = await runRegressionCheck()          // auto-detect changed files
 *   const findings = await runRegressionCheck('/my/dir') // specific cwd
 */

import { exec } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import * as ts from 'typescript'

const execAsync = promisify(exec)

// -- Types

export interface RegressionFinding {
  file: string
  type: 'broken-import' | 'removed-export' | 'changed-signature' | 'missing-dependency'
  message: string
  severity: 'error' | 'warning'
}

export interface ExportInfo {
  name: string
  kind: 'function' | 'class' | 'const' | 'interface' | 'type' | 'enum' | 'variable'
  paramCount?: number
  hasDefaultExport?: boolean
}

// -- Utilities

function shouldExcludeFile(filePath: string): boolean {
  const excludes = [
    /\/node_modules\//,
    /\/\.(git|next|output|cache|vite|dist)\//,
    /\.d\.ts$/,
    /\.test\.(ts|tsx)$/,
    /\.spec\.(ts|tsx)$/,
  ]
  return excludes.some(p => p.test(filePath))
}

async function readFile(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf-8')
  }
  catch {
    return null
  }
}

/**
 * Run a git command and return stdout.
 */
async function runGit(args: string, cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${args}`, { cwd, maxBuffer: 10 * 1024 * 1024 })
    return stdout.trim()
  }
  catch {
    return ''
  }
}

/**
 * Parse a TypeScript file and return its SourceFile.
 */
function parseSourceFile(filePath: string, content: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

// -- Step 1: Detect changed files

/**
 * Get the list of changed .ts/.tsx files from git diff.
 */
export async function getChangedFiles(cwd: string = process.cwd()): Promise<string[]> {
  // Try staged + unstaged changes first
  let diffOutput = await runGit('diff --name-only HEAD', cwd)
  if (!diffOutput) {
    // No uncommitted changes; check if there are recent commits
    diffOutput = await runGit('diff --name-only HEAD~1 HEAD', cwd)
  }
  if (!diffOutput) {
    return []
  }

  return diffOutput
    .split('\n')
    .map(f => f.trim())
    .filter(f => f.length > 0)
    .filter(f => /\.(ts|tsx)$/.test(f))
    .filter(f => !shouldExcludeFile(f))
    .map(f => resolve(cwd, f))
}

// -- Step 2: Extract exports from a file

/**
 * Extract exported functions, classes, constants, etc. from a TypeScript file.
 */
export function extractExports(filePath: string, content: string): ExportInfo[] {
  const source = parseSourceFile(filePath, content)
  const exports: ExportInfo[] = []
  const seen = new Set<string>()

  function addExport(info: ExportInfo) {
    if (!seen.has(info.name)) {
      seen.add(info.name)
      exports.push(info)
    }
  }

  function visit(node: ts.Node) {
    // export function foo(...)
    if (ts.isFunctionDeclaration(node) && node.name) {
      const hasExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      if (hasExport) {
        const hasDefault = node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)
        if (hasDefault) {
          addExport({
            name: 'default',
            kind: 'function',
            paramCount: node.parameters.length,
            hasDefaultExport: true,
          })
        }
        else {
          addExport({
            name: node.name.text,
            kind: 'function',
            paramCount: node.parameters.length,
          })
        }
      }
    }

    // export class Foo
    if (ts.isClassDeclaration(node) && node.name) {
      const hasExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      if (hasExport) {
        const hasDefault = node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)
        if (hasDefault) {
          addExport({
            name: 'default',
            kind: 'class',
            hasDefaultExport: true,
          })
        }
        else {
          addExport({
            name: node.name.text,
            kind: 'class',
          })
        }
      }
    }

    // export const/let/var
    if (ts.isVariableStatement(node)) {
      const hasExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      if (hasExport) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            addExport({
              name: decl.name.text,
              kind: 'const',
              paramCount: undefined,
            })
          }
        }
      }
    }

    // export interface Foo
    if (ts.isInterfaceDeclaration(node)) {
      const hasExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      if (hasExport) {
        addExport({
          name: node.name.text,
          kind: 'interface',
        })
      }
    }

    // export type Foo
    if (ts.isTypeAliasDeclaration(node)) {
      const hasExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      if (hasExport) {
        addExport({
          name: node.name.text,
          kind: 'type',
        })
      }
    }

    // export enum Foo
    if (ts.isEnumDeclaration(node)) {
      const hasExport = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      if (hasExport) {
        addExport({
          name: node.name.text,
          kind: 'enum',
        })
      }
    }

    // export default (expression form: export default someExpression)
    if (ts.isExportAssignment(node) && node.isExportEquals !== true) {
      addExport({
        name: 'default',
        kind: 'variable',
        hasDefaultExport: true,
      })
    }

    // export { foo, bar }
    if (ts.isExportDeclaration(node) && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          // spec.name is the exported name (what other files will import)
          // spec.propertyName is the original name (only different if aliased)
          const exportedName = spec.name.text
          addExport({ name: exportedName, kind: 'variable' })
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(source, visit)
  return exports
}

// -- Step 3: Extract imports from a file

export interface ImportInfo {
  /** Local binding names (what the importing file uses) */
  localNames: string[]
  /** Exported names from the source module (what we import as) */
  exportedNames: string[]
  modulePath: string
  isDefaultImport: boolean
  isNamespaceImport: boolean
}

/**
 * Extract all imports from a TypeScript file.
 */
export function extractImports(filePath: string, content: string): ImportInfo[] {
  const source = parseSourceFile(filePath, content)
  const imports: ImportInfo[] = []

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath = node.moduleSpecifier.text
      const localNames: string[] = []
      const exportedNames: string[] = []
      let isDefaultImport = false
      let isNamespaceImport = false

      if (node.importClause) {
        // Default import: import Foo from ...
        if (node.importClause.name) {
          localNames.push(node.importClause.name.text)
          exportedNames.push('default')
          isDefaultImport = true
        }
        // Named + namespace
        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            for (const spec of node.importClause.namedBindings.elements) {
              // spec.name is the local binding name (what the importing file uses)
              // spec.propertyName is the original export name (only for aliased imports)
              const localName = spec.name.text
              const exportedName = spec.propertyName ? spec.propertyName.text : spec.name.text
              localNames.push(localName)
              exportedNames.push(exportedName)
            }
          }
          if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            localNames.push(node.importClause.namedBindings.name.text)
            exportedNames.push('*')
            isNamespaceImport = true
          }
        }
      }

      imports.push({ localNames, exportedNames, modulePath, isDefaultImport, isNamespaceImport })
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(source, visit)
  return imports
}

// -- Step 4: Resolve import target

/**
 * Given an import module path and the importing file, resolve to the actual file.
 * Handles relative imports (./*, ../*) and node_modules.
 */
function resolveImportPath(
  modulePath: string,
  importingFile: string,
  rootDir: string,
): string | null {
  // Relative imports
  if (modulePath.startsWith('.')) {
    const dir = dirname(importingFile)
    const candidates = [
      join(dir, modulePath),
      join(dir, modulePath) + '.ts',
      join(dir, modulePath) + '.tsx',
      join(dir, modulePath, 'index.ts'),
      join(dir, modulePath, 'index.tsx'),
    ]
    for (const c of candidates) {
      const normalized = resolve(c)
      try {
        // We use sync stat for simplicity in resolution
        // In practice these are fast filesystem checks
      }
      catch {
        continue
      }
      // Return the first candidate that looks like it could exist
      // We'll verify existence in the caller
      return normalized
    }
    // Return the base resolved path even if file doesn't exist
    // (the caller will check)
    return resolve(dir, modulePath)
  }

  // Package imports (node_modules) — we can't easily resolve these statically,
  // but we can check if the package directory exists
  const nodeModulesPath = join(rootDir, 'node_modules', modulePath)
  const indexTs = join(nodeModulesPath, 'index.ts')
  const indexTsx = join(nodeModulesPath, 'index.tsx')
  const pkgMain = join(nodeModulesPath, 'index.js')

  for (const p of [nodeModulesPath, indexTs, indexTsx, pkgMain]) {
    try {
      return p
    }
    catch {
      continue
    }
  }

  // Can't resolve node_modules imports — assume they're fine
  return null
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  }
  catch {
    return false
  }
}

// -- Step 5: Check imports against changed exports

/**
 * For each changed file, scan all other project files for imports
 * that reference the changed file's exports. Check if any imported
 * name is no longer exported.
 */
async function checkBrokenImports(
  changedFiles: string[],
  rootDir: string,
): Promise<RegressionFinding[]> {
  const findings: RegressionFinding[] = []

  // Build a map of "resolved path" -> current exports for each changed file
  const changedExportsMap = new Map<string, Set<string>>()
  for (const file of changedFiles) {
    const content = await readFile(file)
    if (content === null) continue

    const exports = extractExports(file, content)
    const exportNames = new Set(exports.map(e => e.name))
    changedExportsMap.set(file, exportNames)
  }

  // Walk all .ts/.tsx files in src/ and check their imports
  const allSourceFiles = await collectSourceFiles(rootDir)

  for (const sourceFile of allSourceFiles) {
    if (changedFiles.includes(sourceFile)) continue

    const content = await readFile(sourceFile)
    if (content === null) continue

    const imports = extractImports(sourceFile, content)

    for (const imp of imports) {
      // Resolve the import to a changed file
      const resolvedPath = resolveImportPath(imp.modulePath, sourceFile, rootDir)
      if (!resolvedPath) continue

      // Check if this resolved path matches any changed file
      const matchingChangedFile = changedFiles.find(cf => {
        // Compare with and without extensions
        const cfNoExt = cf.replace(/\.(ts|tsx)$/, '')
        const resolvedNoExt = resolvedPath.replace(/\.(ts|tsx)$/, '')
        return cfNoExt === resolvedNoExt || cf === resolvedPath
      })

      if (!matchingChangedFile) continue

      const exportedNames = changedExportsMap.get(matchingChangedFile)
      if (!exportedNames) continue

      // Check if any imported specifier is no longer exported
      for (let i = 0; i < imp.exportedNames.length; i++) {
        const exportedName = imp.exportedNames[i]
        if (exportedName === 'default' || exportedName === '*') continue
        if (!exportedNames.has(exportedName)) {
          const localName = imp.localNames[i]
          const relSource = relative(rootDir, sourceFile)
          const display = localName !== exportedName ? `${localName} (exported as "${exportedName}")` : exportedName
          findings.push({
            file: relSource,
            type: 'broken-import',
            message: `Import "${display}" from "${imp.modulePath}" is no longer exported (changed file: ${relative(rootDir, matchingChangedFile)})`,
            severity: 'error',
          })
        }
      }
    }
  }

  return findings
}

// -- Step 6: Check that exports still exist (vs. a baseline)

/**
 * Compare exports between the current state and git HEAD to detect removed exports.
 */
async function checkRemovedExports(
  changedFiles: string[],
  rootDir: string,
): Promise<RegressionFinding[]> {
  const findings: RegressionFinding[] = []

  for (const file of changedFiles) {
    const relPath = relative(rootDir, file)
    const content = await readFile(file)
    if (content === null) continue

    // Get current exports
    const currentExports = extractExports(file, content)
    const currentNames = new Set(currentExports.map(e => e.name))

    // Get HEAD (committed) exports via git show
    const headContent = await runGit(`show HEAD:${relPath}`, rootDir)
    if (!headContent) continue

    const headExports = extractExports(file, headContent)
    const headNames = new Set(headExports.map(e => e.name))

    // Check for removed exports
    for (const name of headNames) {
      if (!currentNames.has(name)) {
        // Find the kind of the removed export
        const removed = headExports.find(e => e.name === name)
        findings.push({
          file: relPath,
          type: 'removed-export',
          message: `Export "${name}" (${removed?.kind ?? 'unknown'}) was removed from ${relPath}`,
          severity: 'error',
        })
      }
    }

    // Check for changed function signatures (param count changed)
    for (const current of currentExports) {
      if (current.kind !== 'function' || current.paramCount === undefined) continue
      const head = headExports.find(e => e.name === current.name && e.kind === 'function')
      if (head && head.paramCount !== undefined && head.paramCount !== current.paramCount) {
        findings.push({
          file: relPath,
          type: 'changed-signature',
          message: `Function "${current.name}" parameter count changed from ${head.paramCount} to ${current.paramCount} in ${relPath}`,
          severity: 'warning',
        })
      }
    }
  }

  return findings
}

// -- Step 7: Check for missing dependencies in imports

/**
 * Check that all relative imports in changed files resolve to actual files.
 */
async function checkMissingDependencies(
  changedFiles: string[],
  rootDir: string,
): Promise<RegressionFinding[]> {
  const findings: RegressionFinding[] = []

  for (const file of changedFiles) {
    const content = await readFile(file)
    if (content === null) continue

    const imports = extractImports(file, content)

    for (const imp of imports) {
      if (!imp.modulePath.startsWith('.')) continue

      const resolvedBase = resolveImportPath(imp.modulePath, file, rootDir)
      if (!resolvedBase) {
        const relPath = relative(rootDir, file)
        findings.push({
          file: relPath,
          type: 'missing-dependency',
          message: `Cannot resolve import "${imp.modulePath}" in ${relPath}`,
          severity: 'error',
        })
        continue
      }

      // Check all possible file extensions
      const candidates = [
        resolvedBase,
        resolvedBase + '.ts',
        resolvedBase + '.tsx',
        join(resolvedBase, 'index.ts'),
        join(resolvedBase, 'index.tsx'),
      ]

      const exists = await Promise.all(candidates.map(c => fileExists(c)))
      if (!exists.some(Boolean)) {
        const relPath = relative(rootDir, file)
        findings.push({
          file: relPath,
          type: 'missing-dependency',
          message: `Import "${imp.modulePath}" does not resolve to any file in ${relPath}`,
          severity: 'error',
        })
      }
    }
  }

  return findings
}

// -- File collection

/**
 * Collect all .ts/.tsx files under src/ directory.
 */
async function collectSourceFiles(rootDir: string): Promise<string[]> {
  const results: string[] = []
  const srcDir = join(rootDir, 'src')

  async function walk(dir: string) {
    let entries: fs.Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    }
    catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (shouldExcludeFile(fullPath + '/')) continue
        await walk(fullPath)
      }
      else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !shouldExcludeFile(fullPath)) {
        results.push(fullPath)
      }
    }
  }

  await walk(srcDir)
  return results
}

// -- Main API

/**
 * Run a full regression check on changed files.
 *
 * Detects changed files via git, then checks:
 *   - Broken imports: other files importing exports that no longer exist
 *   - Removed exports: exports that existed before the change but are gone now
 *   - Changed signatures: function parameter counts that changed
 *   - Missing dependencies: imports that don't resolve to any file
 *
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns Array of regression findings
 */
export async function runRegressionCheck(
  cwd: string = process.cwd(),
): Promise<RegressionFinding[]> {
  const allFindings: RegressionFinding[] = []

  // Step 1: Detect changed files
  const changedFiles = await getChangedFiles(cwd)
  if (changedFiles.length === 0) {
    return allFindings
  }

  // Step 2: Check broken imports (other files importing from changed files)
  const brokenImportFindings = await checkBrokenImports(changedFiles, cwd)
  allFindings.push(...brokenImportFindings)

  // Step 3: Check removed exports (comparing against git HEAD)
  const removedExportFindings = await checkRemovedExports(changedFiles, cwd)
  allFindings.push(...removedExportFindings)

  // Step 4: Check changed signatures
  // (already included in checkRemovedExports)

  // Step 5: Check missing dependencies in changed files
  const missingDepFindings = await checkMissingDependencies(changedFiles, cwd)
  allFindings.push(...missingDepFindings)

  // Sort by file, then type, then message
  allFindings.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    if (a.type !== b.type) return a.type.localeCompare(b.type)
    return a.message.localeCompare(b.message)
  })

  return allFindings
}
