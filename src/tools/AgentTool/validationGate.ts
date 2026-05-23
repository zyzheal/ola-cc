/**
 * Post-agent validation gate.
 *
 * After an agent reports completion, this gate runs a quick sanity check
 * before accepting the result. If the check fails, a repair agent is
 * automatically spawned (up to MAX_REPAIR_ATTEMPTS).
 *
 * Validation order: Verdict → Build → TypeCheck → Tests → RegexScan
 * Each step runs only if previous passes (except TypeCheck which is WARNING-level).
 * Test failures are logged but don't block the agent (same as regex scan).
 *
 * Controlled by env var:
 *   OLA_CC_DISABLE_VALIDATION_GATE=true (default: enabled)
 *   OLA_CC_MAX_REPAIR_ATTEMPTS=2 (default: 2)
 */

import { exec } from 'node:child_process'
import { accessSync, existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const execAsync = promisify(exec)

export const VALIDATION_GATE_ENABLED =
  !isEnvTruthy(process.env.OLA_CC_DISABLE_VALIDATION_GATE)

const MAX_REPAIR_ATTEMPTS_DEFAULT = 2

export function getMaxRepairAttempts(): number {
  const raw = process.env.OLA_CC_MAX_REPAIR_ATTEMPTS
  if (raw) {
    const n = parseInt(raw, 10)
    if (!isNaN(n) && n >= 1) return n
  }
  return MAX_REPAIR_ATTEMPTS_DEFAULT
}

// -- Test Detection --

/**
 * Result from detectTestRunner.
 */
export interface TestRunnerInfo {
  /** The command to run (e.g., "bun test", "npm test") */
  command: string
  /** How it was detected: "scripts" | "directories" | "files" */
  detectedBy: 'scripts' | 'directories' | 'files'
}

const TEST_DIR_NAMES = ['test', 'tests', '__tests__']
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/

/**
 * Recursively scan for test files up to a reasonable depth.
 */
async function hasTestFiles(dir: string, depth = 0): Promise<boolean> {
  if (depth > 4) return false
  let entries: (import('node:fs').Dirent | string)[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name
    const isFile = typeof entry === 'string' ? false : entry.isFile()
    const isDir = typeof entry === 'string' ? false : entry.isDirectory()

    if (isFile && TEST_FILE_RE.test(name)) return true
    if (isDir && name !== 'node_modules' && name !== '.git') {
      if (await hasTestFiles(join(dir, name), depth + 1)) return true
    }
  }
  return false
}

/**
 * Detect whether the project has tests and return the appropriate test command.
 * Checks in order:
 * 1. package.json scripts.test
 * 2. test/, tests/, __tests__/ directories
 * 3. *.test.ts, *.test.tsx, *.spec.ts, *.spec.tsx files
 *
 * Returns null if no tests are found.
 */
export async function detectTestRunner(cwd: string): Promise<TestRunnerInfo | null> {
  // 1. Check package.json for test script
  const pkgJsonPath = join(cwd, 'package.json')
  if (existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      const testScript = pkgJson.scripts?.test
      if (
        testScript &&
        typeof testScript === 'string' &&
        testScript.trim() !== '' &&
        testScript.trim() !== 'echo "Error: no test specified"' &&
        testScript.trim() !== "echo \"Error: no test specified\""
      ) {
        return { command: testScript.trim(), detectedBy: 'scripts' }
      }
    } catch {
      // package.json parse failure — continue
    }
  }

  // 2. Check for test directories
  for (const dirName of TEST_DIR_NAMES) {
    if (existsSync(join(cwd, dirName))) {
      return { command: 'bun test', detectedBy: 'directories' }
    }
  }

  // 3. Check for test files
  if (await hasTestFiles(cwd)) {
    return { command: 'bun test', detectedBy: 'files' }
  }

  return null
}

// -- Test Execution --

const TEST_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Run the project's test suite.
 *
 * @param cwd - Working directory to run tests in
 * @param testCommand - The test command to execute (from detectTestRunner)
 * @returns { passed: boolean, output: string } — pass/fail and captured output
 */
export async function runTests(
  cwd: string,
  testCommand: string,
): Promise<{ passed: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(testCommand, {
      cwd,
      timeout: TEST_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    const output = (stdout + stderr).trim()
    return { passed: true, output: output || '(no output)' }
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string }
    const output = (
      (error instanceof Error ? error.message : String(error)) +
      '\n' +
      (err.stderr ?? '') +
      '\n' +
      (err.stdout ?? '')
    ).trim()
    return { passed: false, output }
  }
}

/**
 * Format test results into a human-readable summary.
 */
export function formatTestSummary(
  passed: boolean,
  output: string,
  command: string,
): string {
  if (passed) {
    return `Tests passed (${command})`
  }
  const lines = output.split('\n').filter(l => l.trim())
  const first30 = lines.slice(0, 30)
  return `Tests failed (${command}):\n${first30.join('\n')}`
}

/**
 * Parse a verification agent verdict from its output.
 * Returns 'PASS' | 'FAIL' | 'PARTIAL' | null (if not found)
 */
export function parseVerificationVerdict(output: string): 'PASS' | 'FAIL' | 'PARTIAL' | null {
  const match = output.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/)
  if (!match) return null
  return match[1] as 'PASS' | 'FAIL' | 'PARTIAL'
}

/**
 * Build a repair prompt for a failed agent.
 * Gives the repair agent the specific failures to fix.
 */
export function buildRepairPrompt(
  originalPrompt: string,
  failureDetails: string,
  attempt: number,
  maxAttempts: number,
): string {
  return `## Repair Request

The previous implementation attempt (#${attempt - 1} of ${maxAttempts}) failed validation.

**Original task:**
${originalPrompt}

**Failure details:**
${failureDetails}

**Your job:**
Fix ONLY the issues described above. Do NOT rewrite the entire implementation.
After fixing, verify:
1. \`bun run build:dev\` passes (or the project's build command)
2. Tests pass (run \`npm test\` or the project's test command)
3. The specific failure cases are resolved

**Warning:** This is attempt #${attempt}. If this attempt also fails, the task will be reported to the user as FAILED.`
}

// -- Type Checking

const TYPE_CHECK_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes

/**
 * Detect which type-check command is available for the project.
 *
 * Checks in order:
 * 1. package.json scripts (typecheck, type-check, tsc, check)
 * 2. tsconfig.json/jsconfig.json with tsc availability
 * 3. npx tsc --noEmit as fallback
 *
 * Returns { command, available } where available indicates if the command can run.
 */
export function detectTypeChecker(cwd: string): {
  command: string
  available: boolean
  reason?: string
} {
  const pkgJsonPath = join(cwd, 'package.json')
  const hasTsConfig =
    existsSync(join(cwd, 'tsconfig.json')) || existsSync(join(cwd, 'jsconfig.json'))

  // Check package.json for type-check scripts
  if (existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      const scripts = pkgJson.scripts ?? {}

      // Priority order: typecheck > type-check > tsc > check
      const scriptNames = ['typecheck', 'type-check', 'tsc', 'check']
      for (const name of scriptNames) {
        if (scripts[name] && typeof scripts[name] === 'string') {
          return {
            command: `npm run ${name}`,
            available: true,
            reason: `package.json script: ${name}`,
          }
        }
      }
    } catch {
      // package.json parse failure, continue to fallback
    }
  }

  // If no config files, no type checking needed
  if (!hasTsConfig) {
    return {
      command: '',
      available: false,
      reason: 'No tsconfig.json or jsconfig.json found',
    }
  }

  // Check if tsc is available in node_modules/.bin or globally
  const tscLocal = join(cwd, 'node_modules', '.bin', 'tsc')
  const tscLocalExists = existsSync(tscLocal)

  try {
    accessSync(tscLocal, 0o111)
    return {
      command: tscLocal,
      available: true,
      reason: 'tsc found in node_modules/.bin',
    }
  } catch {
    // Not executable, try npx
  }

  if (tscLocalExists) {
    return {
      command: 'npx tsc --noEmit',
      available: true,
      reason: 'tsc exists in node_modules/.bin (using npx)',
    }
  }

  // Final fallback: try npx tsc
  return {
    command: 'npx tsc --noEmit',
    available: true,
    reason: 'fallback to npx tsc --noEmit',
  }
}

/**
 * Run type checking on the project.
 *
 * Executes the detected type-check command, parses output for errors,
 * and returns structured results.
 *
 * Timeout: 3 minutes. Type-check failure is WARNING level (doesn't block).
 */
export async function runTypeCheck(
  cwd: string,
): Promise<{ passed: boolean; errors: string[]; output: string; command: string }> {
  const detector = detectTypeChecker(cwd)

  if (!detector.available || !detector.command) {
    return {
      passed: true,
      errors: [],
      output: 'Type checking skipped: ' + (detector.reason ?? 'no type checker available'),
      command: '',
    }
  }

  try {
    logForDebugging(
      `[ValidationGate] Running type check: ${detector.command} (in ${cwd})`,
    )

    const { stdout, stderr } = await execAsync(detector.command, {
      cwd,
      timeout: TYPE_CHECK_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for output
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    const output = stdout || stderr

    // TypeScript: "Found X error(s)" at the end
    const tsErrorMatch = output.match(/Found (\d+) error\(s?\) in/)
    if (tsErrorMatch && parseInt(tsErrorMatch[1], 10) > 0) {
      const errors = parseTypeScriptErrors(output)
      return {
        passed: false,
        errors,
        output,
        command: detector.command,
      }
    }

    // If no explicit error count, check for error markers
    if (/^\s*\d+/.test(output) || /TS\d+/.test(output) || /error TS/.test(output)) {
      const errors = parseTypeScriptErrors(output)
      if (errors.length > 0) {
        return {
          passed: false,
          errors,
          output,
          command: detector.command,
        }
      }
    }

    return { passed: true, errors: [], output, command: detector.command }
  } catch (err: any) {
    // exec throws on non-zero exit code — that's expected for type errors
    const output = err.stdout || err.stderr || err.message || ''
    const errors = parseTypeScriptErrors(output)

    return {
      passed: false,
      errors: errors.length > 0 ? errors : [output.trim().split('\n').slice(0, 5).join('\n')],
      output,
      command: detector.command,
    }
  }
}

/**
 * Parse TypeScript compiler output to extract individual errors.
 * Handles both tsc and npm/npx wrapped output.
 */
function parseTypeScriptErrors(output: string): string[] {
  const errors: string[] = []
  const lines = output.split('\n')

  let currentError: string[] = []
  let inError = false

  for (const line of lines) {
    // TypeScript error lines match patterns like:
    //   src/file.ts:10:5 - error TS2322: Type 'string' is not assignable to type 'number'.
    // Or:
    //   file.ts(10,5): error TS2322: ...
    const isErrorLine =
      /^\s*(?:.+?:\d+:\d+|\S+\(\d+,\d+\))\s*-?\s*error TS\d+:/.test(line) ||
      /^Found \d+ errors? in /.test(line)

    if (isErrorLine) {
      // Save previous error block
      if (currentError.length > 0) {
        errors.push(currentError.join('\n').trim())
      }
      currentError = [line]
      inError = true
    } else if (inError) {
      // Continuation lines (context arrows like 10 | const x: number = "str")
      if (line.startsWith(' ') || line.startsWith('\t') || /^\d+\s+\|/.test(line)) {
        currentError.push(line)
      } else {
        // End of this error
        if (currentError.length > 0) {
          errors.push(currentError.join('\n').trim())
        }
        currentError = []
        inError = false
      }
    }
  }

  // Flush last error
  if (currentError.length > 0) {
    errors.push(currentError.join('\n').trim())
  }

  // Limit to first 10 errors to avoid overwhelming context
  return errors.slice(0, 10)
}

/**
 * Format type-check results into a human-readable summary.
 */
export function formatTypeCheckSummary(result: {
  passed: boolean
  errors: string[]
  command: string
}): string {
  if (result.passed) {
    return `Type check passed (${result.command})`
  }

  const lines = [
    `Type check failed (${result.command}):`,
    '',
  ]

  for (let i = 0; i < result.errors.length; i++) {
    lines.push(`  ${i + 1}. ${result.errors[i]}`)
    lines.push('')
  }

  if (result.errors.length >= 10) {
    lines.push('  ... (showing first 10 errors)')
  }

  return lines.join('\n')
}
