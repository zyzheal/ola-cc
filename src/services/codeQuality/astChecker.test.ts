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
  it('returns all 20 check definitions', () => {
    const checks = getAvailableASTChecks()
    expect(checks.length).toBe(20)
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

  // --- Frontend Checks ---

  it('detects hardcoded hex colors in JSX', async () => {
    const path = await writeTestFile('color.tsx', '<div style={{ color: "#FF5733" }} />\n')
    const results = await runASTCheck([path], ['hardcoded-color'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('hardcoded-color')
    expect(results[0].severity).toBe('warning')
  })

  it('does not flag hex colors outside JSX', async () => {
    const path = await writeTestFile('nonJsx.ts', 'const c = "#FF5733"\n')
    const results = await runASTCheck([path], ['hardcoded-color'])
    expect(results.length).toBe(0)
  })

  it('detects missing design token usage', async () => {
    const path = await writeTestFile('token.tsx', '<div style={{ background: "#1890ff" }} />\n')
    const results = await runASTCheck([path], ['missing-design-token'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('missing-design-token')
  })

  it('detects Form without validation rules', async () => {
    const path = await writeTestFile('form.tsx', '<Form><Input /></Form>\n')
    const results = await runASTCheck([path], ['form-without-validation'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('form-without-validation')
    expect(results[0].severity).toBe('error')
  })

  it('does not flag Form with rules prop', async () => {
    const path = await writeTestFile('formValid.tsx', '<Form rules={rules}><Input /></Form>\n')
    const results = await runASTCheck([path], ['form-without-validation'])
    expect(results.length).toBe(0)
  })

  it('detects async function without try-catch', async () => {
    const path = await writeTestFile('async.ts', 'async function fetchData() { const res = await fetch("/api"); return res; }\n')
    const results = await runASTCheck([path], ['async-without-try-catch'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('async-without-try-catch')
    expect(results[0].severity).toBe('error')
  })

  it('does not flag async function with try-catch', async () => {
    const path = await writeTestFile('asyncOk.ts', 'async function fetchData() { try { const res = await fetch("/api"); return res; } catch (e) { console.error(e); } }\n')
    const results = await runASTCheck([path], ['async-without-try-catch'])
    expect(results.length).toBe(0)
  })

  it('detects async arrow function without try-catch', async () => {
    const path = await writeTestFile('asyncArrow.ts', 'const fn = async () => { await fetch("/api"); };\n')
    const results = await runASTCheck([path], ['async-without-try-catch'])
    expect(results.length).toBe(1)
  })

  it('detects Button with async onClick but no loading state', async () => {
    const path = await writeTestFile('button.tsx', '<Button onClick={async () => { await submit() }}>Submit</Button>\n')
    const results = await runASTCheck([path], ['missing-loading-state'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('missing-loading-state')
    expect(results[0].severity).toBe('warning')
  })

  it('does not flag Button with loading prop', async () => {
    const path = await writeTestFile('buttonOk.tsx', '<Button loading={loading} onClick={async () => { await submit() }}>Submit</Button>\n')
    const results = await runASTCheck([path], ['missing-loading-state'])
    expect(results.length).toBe(0)
  })

  it('detects List without Empty component', async () => {
    const path = await writeTestFile('list.tsx', '<List dataSource={items} renderItem={item => <List.Item>{item.name}</List.Item>} />\n')
    const results = await runASTCheck([path], ['empty-state-missing'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('empty-state-missing')
    expect(results[0].severity).toBe('info')
  })

  it('detects mutation async function without success feedback', async () => {
    const path = await writeTestFile('mutation.ts', 'async function saveData() { await api.post("/save", data); }\n')
    const results = await runASTCheck([path], ['success-feedback-missing'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('success-feedback-missing')
    expect(results[0].severity).toBe('warning')
  })

  it('does not flag mutation with message.success', async () => {
    const path = await writeTestFile('mutationOk.ts', 'async function saveData() { await api.post("/save", data); message.success("Saved"); }\n')
    const results = await runASTCheck([path], ['success-feedback-missing'])
    expect(results.length).toBe(0)
  })

  // --- Backend Checks ---

  it('detects DB query without tenant_id filter', async () => {
    const path = await writeTestFile('query.ts', 'const items = await db.users.findMany();\n')
    const results = await runASTCheck([path], ['missing-tenant-filter'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('missing-tenant-filter')
    expect(results[0].severity).toBe('error')
  })

  it('does not flag DB query with where clause', async () => {
    const path = await writeTestFile('queryOk.ts', 'const items = await db.users.findMany({ where: { tenant_id: 1 } });\n')
    const results = await runASTCheck([path], ['missing-tenant-filter'])
    expect(results.length).toBe(0)
  })

  it('detects list endpoint without pagination', async () => {
    const path = await writeTestFile('route.ts', 'app.get("/api/users/list", (req, res) => { const users = db.query("SELECT * FROM users"); res.json(users); });\n')
    const results = await runASTCheck([path], ['missing-pagination'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('missing-pagination')
    expect(results[0].severity).toBe('warning')
  })

  it('detects error without code prefix', async () => {
    const path = await writeTestFile('error.ts', 'throw new Error("Something went wrong");\n')
    const results = await runASTCheck([path], ['error-code-inconsistent'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('error-code-inconsistent')
    expect(results[0].severity).toBe('info')
  })

  it('does not flag error with code prefix', async () => {
    const path = await writeTestFile('errorOk.ts', 'throw new Error("E001: Something went wrong");\n')
    const results = await runASTCheck([path], ['error-code-inconsistent'])
    expect(results.length).toBe(0)
  })

  it('detects Promise without catch', async () => {
    const path = await writeTestFile('promise.ts', 'new Promise((resolve) => resolve(1));\n')
    const results = await runASTCheck([path], ['unhandled-rejection'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('unhandled-rejection')
    expect(results[0].severity).toBe('error')
  })

  it('does not flag Promise with .catch()', async () => {
    const path = await writeTestFile('promiseOk.ts', 'new Promise((resolve) => resolve(1)).catch(e => console.error(e));\n')
    const results = await runASTCheck([path], ['unhandled-rejection'])
    expect(results.length).toBe(0)
  })

  it('detects POST endpoint without input validation', async () => {
    const path = await writeTestFile('post.ts', 'app.post("/api/users", (req, res) => { db.save(req.body); res.json({ ok: true }); });\n')
    const results = await runASTCheck([path], ['missing-input-validation'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('missing-input-validation')
    expect(results[0].severity).toBe('warning')
  })

  it('detects SQL injection via string concatenation', async () => {
    const path = await writeTestFile('sql.ts', 'const sql = "SELECT * FROM users WHERE id = " + userId;\n')
    const results = await runASTCheck([path], ['sql-injection-risk'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('sql-injection-risk')
    expect(results[0].severity).toBe('error')
  })

  it('detects SQL injection via template literal', async () => {
    const path = await writeTestFile('sqlTemplate.ts', 'const sql = `SELECT * FROM users WHERE id = ${userId}`;\n')
    const results = await runASTCheck([path], ['sql-injection-risk'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('sql-injection-risk')
  })

  it('detects mutation without audit log', async () => {
    const path = await writeTestFile('audit.ts', 'function createUser(user: User) { db.insert(user); return user; }\n')
    const results = await runASTCheck([path], ['missing-audit-log'])
    expect(results.length).toBe(1)
    expect(results[0].check).toBe('missing-audit-log')
    expect(results[0].severity).toBe('info')
  })

  it('does not flag mutation with audit logging', async () => {
    const path = await writeTestFile('auditOk.ts', 'function createUser(user: User) { db.insert(user); audit.log("created user", user.id); return user; }\n')
    const results = await runASTCheck([path], ['missing-audit-log'])
    expect(results.length).toBe(0)
  })

  // --- Common Checks ---

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
    // The "console.log after if/else" is reachable, so no flag for the else branch content
    // The unreachable check should flag the console.log after the if/else if both branches return
    expect(results.length).toBe(0)
  })

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
    const path = await writeTestFile('multi.ts', 'async function foo() { await bar(); };\nimport { unused } from "x";\n')
    const results = await runASTCheck([path], [])
    // Should include async-without-try-catch and unused-import
    expect(results.length).toBeGreaterThan(0)
    const checks = results.map(r => r.check)
    expect(checks).toContain('unused-import')
  })

  it('filters by specific check name', async () => {
    const path = await writeTestFile('filter.ts', 'async function foo() { await bar(); }\n')
    const results = await runASTCheck([path], ['unused-import'])
    expect(results.length).toBe(0) // No imports in this file
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
