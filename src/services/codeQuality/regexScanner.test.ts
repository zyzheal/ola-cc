import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getAvailableChecks, runQualityScan } from './regexScanner.js'

// -- Test helpers
// Files must be under src/ to match the default check globs (src/**/*.ts)

const TEST_DIR = join(process.cwd(), 'src', '.test-scan-temp')

async function writeTestFile(name: string, content: string): Promise<string> {
  const path = join(TEST_DIR, name)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content)
  return path
}

async function removeTestFiles() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
  }
  catch {
    // Ignore
  }
}

// -- Tests

describe('getAvailableChecks', () => {
  it('returns all 15 check definitions', () => {
    const checks = getAvailableChecks()
    expect(checks.length).toBe(15)
  })

  it('each check has required fields', () => {
    const checks = getAvailableChecks()
    for (const c of checks) {
      expect(c.name).toBeDefined()
      expect(c.severity).toBeDefined()
      expect(c.message).toBeDefined()
      expect(c.globs.length).toBeGreaterThan(0)
    }
  })

  it('check names are unique', () => {
    const checks = getAvailableChecks()
    const names = checks.map(c => c.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })
})

describe('runQualityScan', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true })
  })

  afterEach(async () => {
    await removeTestFiles()
  })

  it('returns empty results for clean code', async () => {
    await writeTestFile('clean.ts', 'const x = 1\nexport default x\n')
    const results = await runQualityScan({
      paths: [join(TEST_DIR, '*.ts')],
      checks: [],
    })
    expect(results.length).toBe(0)
  })

  it('detects console.log', async () => {
    const path = await writeTestFile('console.ts', 'console.log("hello")\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['console-log'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('console-log')
    expect(results[0].severity).toBe('warning')
    expect(results[0].line).toBe(1)
  })

  it('detects empty catch block', async () => {
    const path = await writeTestFile('emptyCatch.ts', 'try { throw new Error() } catch (e) {}\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['empty-catch-block'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('empty-catch-block')
    expect(results[0].severity).toBe('error')
  })

  it('detects direct process.env access without fallback', async () => {
    const path = await writeTestFile('env.ts', 'const key = process.env.API_KEY\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['direct-process-env'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('direct-process-env')
    expect(results[0].severity).toBe('info')
  })

  it('does not flag process.env with ?? fallback', async () => {
    const path = await writeTestFile('envOk.ts', 'const key = process.env.API_KEY ?? "default"\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['direct-process-env'],
    })
    expect(results.length).toBe(0)
  })

  it('detects hardcoded hex colors', async () => {
    const path = await writeTestFile('color.tsx', 'const bg = "#FF5733"\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['hardcoded-hex-color'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('hardcoded-hex-color')
    expect(results[0].severity).toBe('warning')
  })

  it('detects magic numbers', async () => {
    const path = await writeTestFile('magic.ts', 'setTimeout(fn, 86400000)\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['magic-number'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('magic-number')
    expect(results[0].severity).toBe('info')
  })

  it('does not flag magic numbers with nearby comments', async () => {
    const path = await writeTestFile('commented.ts', 'setTimeout(fn, 86400000) // one day in ms\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['magic-number'],
    })
    expect(results.length).toBe(0)
  })

  it('detects unhandled fetch', async () => {
    const path = await writeTestFile('unhandledFetch.ts', 'const res = fetch("/api/data")\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['unhandled-fetch'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('unhandled-fetch')
    expect(results[0].severity).toBe('error')
  })

  it('detects unhandled Promise', async () => {
    const path = await writeTestFile('unhandledPromise.ts', 'const p = new Promise((resolve) => resolve(1))\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['unhandled-promise'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('unhandled-promise')
    expect(results[0].severity).toBe('error')
  })

  it('excludes test files from console-log check', async () => {
    const path = await writeTestFile('feature.test.ts', 'console.log("debug in test")\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['console-log'],
    })
    expect(results.length).toBe(0)
  })

  it('filters checks by name', async () => {
    await writeTestFile('multi.ts', 'console.log("hi")\nconst x = process.env.A\n')
    const results = await runQualityScan({
      paths: [join(TEST_DIR, 'multi.ts')],
      checks: ['console-log'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('console-log')
  })

  it('results are sorted by file, line, column', async () => {
    const path = await writeTestFile('sort.ts', [
      'const key = process.env.A',
      'const key2 = process.env.B',
      'const key3 = process.env.C',
    ].join('\n'))
    const results = await runQualityScan({
      paths: [path],
      checks: ['direct-process-env'],
    })
    expect(results.length).toBe(3)
    expect(results[0].line).toBe(1)
    expect(results[1].line).toBe(2)
    expect(results[2].line).toBe(3)
  })

  it('returns fix suggestions for checks that have them', async () => {
    const path = await writeTestFile('fix.ts', 'console.log("hi")\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['console-log'],
    })
    expect(results.length).toBe(1)
    expect(results[0].fix).toBeDefined()
    expect(results[0].fix).toContain('logging')
  })

  // -- New checks (8)

  it('detects unused imports', async () => {
    const path = await writeTestFile('unused.ts', 'import { something } from "some-lib";\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['unused-import'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('unused-import')
    expect(results[0].severity).toBe('info')
  })

  it('detects any type usage', async () => {
    const path = await writeTestFile('anyType.ts', 'const x: any = 1\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['any-type'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('any-type')
    expect(results[0].severity).toBe('warning')
  })

  it('does not flag :any in a comment', async () => {
    const path = await writeTestFile('anyComment.ts', '// TODO: any value works\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['any-type'],
    })
    expect(results.length).toBe(0)
  })

  it('detects console.error in source code', async () => {
    const path = await writeTestFile('error.ts', 'console.error("fail")\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['console-error'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('console-error')
    expect(results[0].severity).toBe('warning')
  })

  it('detects async function without await', async () => {
    const path = await writeTestFile('noAwait.ts', 'async function foo() { return 1 }\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['missing-await'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('missing-await')
    expect(results[0].severity).toBe('warning')
  })

  it('does not flag async function that has await', async () => {
    const path = await writeTestFile('hasAwait.ts', 'async function foo() { await bar() }\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['missing-await'],
    })
    expect(results.length).toBe(0)
  })

  it('detects TODO comments', async () => {
    const path = await writeTestFile('todo.ts', '// TODO: fix this later\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['todo-comment'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('todo-comment')
    expect(results[0].severity).toBe('info')
  })

  it('detects TODO in block comments', async () => {
    const path = await writeTestFile('todoBlock.ts', '/* TODO: refactor */\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['todo-comment'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('todo-comment')
  })

  it('detects debugger statements', async () => {
    const path = await writeTestFile('debug.ts', 'function foo() { debugger; }\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['debug-breakpoint'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('debug-breakpoint')
    expect(results[0].severity).toBe('error')
  })

  it('detects eval() calls', async () => {
    const path = await writeTestFile('eval.ts', 'const x = eval("1+1")\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['eval-call'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('eval-call')
    expect(results[0].severity).toBe('error')
  })

  it('detects innerHTML assignment', async () => {
    const path = await writeTestFile('inner.tsx', 'el.innerHTML = "<div>hi</div>"\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['inner-html'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('inner-html')
    expect(results[0].severity).toBe('warning')
  })

  it('does not flag innerHTML in comment', async () => {
    const path = await writeTestFile('innerComment.tsx', '// set .innerHTML = something\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['inner-html'],
    })
    expect(results.length).toBe(0)
  })
})

describe('edge cases', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true })
  })

  afterEach(async () => {
    await removeTestFiles()
  })

  it('handles nonexistent files gracefully', async () => {
    const results = await runQualityScan({
      paths: [join(TEST_DIR, 'does-not-exist.ts')],
      checks: [],
    })
    expect(results).toEqual([])
  })

  it('hex color in comment is excluded', async () => {
    const path = await writeTestFile('commentedColor.tsx', '// TODO: use color #FF5733\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['hardcoded-hex-color'],
    })
    expect(results.length).toBe(0)
  })

  it('empty catch with whitespace/newlines is detected', async () => {
    const path = await writeTestFile('emptyCatchNewlines.ts', 'try { x() } catch (e) {\n\n}\n')
    const results = await runQualityScan({
      paths: [path],
      checks: ['empty-catch-block'],
    })
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('empty-catch-block')
  })
})
