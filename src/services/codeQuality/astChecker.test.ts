import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { getAvailableASTChecks, runASTCheck } from './astChecker.js'

// -- Test helpers

const TEST_DIR = join(process.cwd(), 'src', '.test-ast-temp')

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

describe('getAvailableASTChecks', () => {
  it('returns all 5 check definitions', () => {
    const checks = getAvailableASTChecks()
    expect(checks.length).toBe(5)
  })

  it('each check has required fields', () => {
    const checks = getAvailableASTChecks()
    for (const c of checks) {
      expect(c.name).toBeDefined()
      expect(c.severity).toBeDefined()
      expect(c.message).toBeDefined()
      expect(c.globs.length).toBeGreaterThan(0)
    }
  })

  it('check names are unique', () => {
    const checks = getAvailableASTChecks()
    const names = checks.map(c => c.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })
})

describe('runASTCheck', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true })
  })

  afterEach(async () => {
    await removeTestFiles()
  })

  // --- unused-variable ---

  it('detects unused variable', async () => {
    const path = await writeTestFile('unused.ts', 'const unusedVar = 42;\nconst used = 1;\nconsole.log(used);\n')
    const results = await runASTCheck([path], ['unused-variable'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('unused-variable')
    expect(results[0].message).toContain('unusedVar')
  })

  it('does not flag underscore-prefixed variable', async () => {
    const path = await writeTestFile('underscore.ts', 'const _unusedVar = 42;\n')
    const results = await runASTCheck([path], ['unused-variable'])
    expect(results.length).toBe(0)
  })

  // --- unused-import ---

  it('detects unused import', async () => {
    const path = await writeTestFile('unusedImport.ts', 'import { unusedFn } from "some-lib";\n')
    const results = await runASTCheck([path], ['unused-import'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('unused-import')
    expect(results[0].severity).toBe('warning')
  })

  it('does not flag used import', async () => {
    const path = await writeTestFile('usedImport.ts', 'import { something } from "some-lib";\nsomething();\n')
    const results = await runASTCheck([path], ['unused-import'])
    expect(results.length).toBe(0)
  })

  // --- magic-number ---

  it('detects magic numbers', async () => {
    const path = await writeTestFile('magic.ts', 'setTimeout(fn, 86400000);\n')
    const results = await runASTCheck([path], ['magic-number'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('magic-number')
    expect(results[0].severity).toBe('info')
  })

  it('does not flag magic numbers in const declaration', async () => {
    const path = await writeTestFile('magicOk.ts', 'const MS_PER_DAY = 86400000;\n')
    const results = await runASTCheck([path], ['magic-number'])
    expect(results.length).toBe(0)
  })

  // --- unreachable-code ---

  it('detects unreachable code after return', async () => {
    const path = await writeTestFile('unreachable.ts', 'function foo() { return 1; console.log("dead"); }\n')
    const results = await runASTCheck([path], ['unreachable-code'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('unreachable-code')
    expect(results[0].severity).toBe('warning')
  })

  it('does not flag code in else branch after return in if', async () => {
    const path = await writeTestFile('elseBranch.ts', 'function foo(x: number) { if (x > 0) { return 1; } else { return 2; } console.log("after"); }\n')
    const results = await runASTCheck([path], ['unreachable-code'])
    expect(results.length).toBe(0)
  })

  // --- implicit-any ---

  it('detects explicit any type', async () => {
    const path = await writeTestFile('any.ts', 'function foo(x: any) { return x; }\n')
    const results = await runASTCheck([path], ['implicit-any'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('implicit-any')
    expect(results[0].severity).toBe('warning')
  })

  it('does not flag implicit any (only explicit)', async () => {
    const path = await writeTestFile('noAny.ts', 'function foo(x) { return x; }\n')
    const results = await runASTCheck([path], ['implicit-any'])
    expect(results.length).toBe(0)
  })

  // --- Filtering ---

  it('runs all checks when checks array is empty', async () => {
    const path = await writeTestFile('multi.ts', 'const unused = 1;\nimport { unusedFn } from "x";\n')
    const results = await runASTCheck([path], [])
    expect(results.length).toBeGreaterThan(0)
    const checks = results.map(r => r.check)
    expect(checks).toContain('unused-import')
  })

  it('filters by specific check name', async () => {
    const path = await writeTestFile('filter.ts', 'const x = 1;\n')
    const results = await runASTCheck([path], ['unused-import'])
    expect(results.length).toBe(0)
  })

  // --- Edge Cases ---

  it('handles nonexistent files gracefully', async () => {
    const results = await runASTCheck([join(TEST_DIR, 'does-not-exist.ts')], [])
    expect(results).toEqual([])
  })

  it('excludes test files', async () => {
    const path = await writeTestFile('test.test.ts', 'const x: any = 1;\nimport { unused } from "x";\n')
    const results = await runASTCheck([path], ['unused-import', 'implicit-any'])
    expect(results.length).toBe(0)
  })

  it('results are sorted by file, line, column', async () => {
    const path = await writeTestFile('sort.ts', [
      'const unusedA = 1;',
      'const unusedB = 2;',
      'const unusedC = 3;',
    ].join('\n'))
    const results = await runASTCheck([path], ['unused-variable'])
    expect(results.length).toBe(3)
    expect(results[0].line).toBeLessThan(results[1].line)
    expect(results[1].line).toBeLessThan(results[2].line)
  })
})
