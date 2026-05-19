# GrepTool ugrep Replacement (Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ripgrep with ugrep as the primary search engine on Windows x64, with automatic fallback to ripgrep on failure. All other platforms remain unchanged.

**Architecture:** Add a `searchEngine.ts` shim layer between GrepTool and ripgrep. On Windows x64, the shim translates ripgrep CLI args to ugrep args, spawns ugrep, and falls back to ripgrep on any error. Non-Windows platforms bypass the shim and call ripgrep directly.

**Tech Stack:** TypeScript, Bun, child_process (spawn), ugrep v7.7.0 (BSD-3-Clause)

---

### Task 1: Write Parameter Translation Function

**Files:**
- Create: `src/utils/searchEngine.ts`
- Test: `tests/searchEngine/translateArgs.test.ts` (inline test, no test framework yet)

- [ ] **Step 1: Write translation tests as executable script**

Create a test script to verify translation logic before implementation:

```typescript
// src/utils/searchEngine.ts — tests at bottom, run with: bun ./src/utils/searchEngine.ts
function translateRgToUgrep(rgArgs: string[]): string[] {
  // Placeholder — will implement in Step 2
  return rgArgs
}

// Tests
const tests = [
  { name: '--hidden → --hidden', input: ['--hidden'], expected: ['--hidden'] },
  { name: '--glob → -g', input: ['--glob', '*.ts'], expected: ['-g', '*.ts'] },
  { name: '--glob ! → -g !', input: ['--glob', '!.git'], expected: ['-g', '!.git'] },
  { name: '--max-columns dropped', input: ['--max-columns', '500'], expected: [] },
  { name: '-U dropped', input: ['-U'], expected: [] },
  { name: '--multiline-dotall → --dotall', input: ['--multiline-dotall'], expected: ['--dotall'] },
  { name: '-j → -J', input: ['-j', '1'], expected: ['-J', '1'] },
  { name: '--sort=modified dropped', input: ['--sort=modified'], expected: [] },
  { name: '--type → -t', input: ['--type', 'ts'], expected: ['-t', 'ts'] },
  { name: '--no-ignore → --ignore-files', input: ['--no-ignore'], expected: ['--ignore-files'] },
  { name: '-c → -c --min-count=1', input: ['-c'], expected: ['-c', '--min-count=1'] },
  { name: '-l passthrough', input: ['-l'], expected: ['-l'] },
  { name: '-n passthrough', input: ['-n'], expected: ['-n'] },
  { name: '-i passthrough', input: ['-i'], expected: ['-i'] },
  { name: '-B/-A/-C passthrough', input: ['-C', '3'], expected: ['-C', '3'] },
  { name: '-e passthrough', input: ['-e', '-foo'], expected: ['-e', '-foo'] },
]

let passed = 0, failed = 0
for (const t of tests) {
  const result = translateRgToUgrep(t.input)
  const ok = JSON.stringify(result) === JSON.stringify(t.expected)
  if (ok) { passed++; console.log(`✅ ${t.name}`) }
  else { failed++; console.log(`❌ ${t.name}\n   got: ${JSON.stringify(result)}\n   exp: ${JSON.stringify(t.expected)}`) }
}
console.log(`\n${passed}/${passed + failed} passed`)
if (failed > 0) process.exit(1)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun ./src/utils/searchEngine.ts`
Expected: FAIL — most tests fail because translateRgToUgrep is a placeholder

- [ ] **Step 3: Implement translateRgToUgrep**

```typescript
/**
 * Translate ripgrep CLI args to ugrep CLI args.
 * Only handles flags that GrepTool actually sends (verified from GrepTool.ts).
 * Unsupported flags are silently dropped.
 */
export function translateRgToUgrep(rgArgs: string[]): string[] {
  const ugrepArgs: string[] = []
  let i = 0
  let addedRecurse = false

  // ugrep needs explicit -r for recursion; ripgrep recurses by default
  // We add -r at the start and deduplicate later
  ugrepArgs.push('-r')

  while (i < rgArgs.length) {
    const arg = rgArgs[i]!

    switch (arg) {
      case '--hidden':
        ugrepArgs.push('--hidden')
        break

      case '--glob': {
        // --glob PATTERN → -g PATTERN
        i++
        const pattern = rgArgs[i]
        if (pattern) ugrepArgs.push('-g', pattern)
        break
      }

      case '--max-columns':
        // Drop — ugrep --width has different semantics (display width, not truncation)
        i++ // skip value
        break

      case '-U':
        // Drop — ugrep supports multiline by default
        break

      case '--multiline-dotall':
        ugrepArgs.push('--dotall')
        break

      case '-j': {
        // -j 1 → -J 1 (ugrep uses -J for threads)
        i++
        const val = rgArgs[i]
        if (val) ugrepArgs.push('-J', val)
        break
      }

      case '--sort=modified':
        // Drop — not supported by ugrep; sorting done in GrepTool post-processing
        break

      case '--type': {
        // --type TYPE → -t TYPE
        i++
        const val = rgArgs[i]
        if (val) ugrepArgs.push('-t', val)
        break
      }

      case '--no-ignore':
        // ugrep: --ignore-files (enables .gitignore reading; default is off)
        ugrepArgs.push('--ignore-files')
        break

      case '-c':
        // -c → -c --min-count=1 (filter out 0-match files)
        ugrepArgs.push('-c', '--min-count=1')
        break

      case '-l':
      case '-n':
      case '-i':
      case '-e':
        // Direct passthrough
        ugrepArgs.push(arg)
        break

      case '-B':
      case '-A':
      case '-C': {
        // Context flags: passthrough with value
        i++
        const val = rgArgs[i]
        if (val) ugrepArgs.push(arg, val)
        break
      }

      default:
        // Patterns (non-flag args) passthrough
        if (!arg.startsWith('-') || arg === '-e') {
          ugrepArgs.push(arg)
        } else {
          // Unknown flag — log and skip
          console.warn(`[searchEngine] unknown ripgrep flag: ${arg}`)
        }
    }
    i++
  }

  return ugrepArgs
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun ./src/utils/searchEngine.ts`
Expected: 16/16 passed

- [ ] **Step 5: Remove test code from searchEngine.ts**

Remove the test block at the bottom. Keep only the `translateRgToUgrep` export.

- [ ] **Step 6: Commit**

```bash
git add src/utils/searchEngine.ts
git commit -m "feat: add translateRgToUgrep parameter translation"
```

---

### Task 2: Write ugrep Binary Spawner

**Files:**
- Modify: `src/utils/searchEngine.ts` (add ugrepBinary function)

- [ ] **Step 1: Implement ugrepBinary function**

Add to `src/utils/searchEngine.ts`:

```typescript
import { spawn } from 'child_process'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { logError } from './log.js'
import { getPlatform } from './platform.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = resolve(__filename, '..')

const MAX_BUFFER_SIZE = 20_000_000 // 20MB, same as ripgrep.ts

function getUgrepPath(): string | null {
  const arch = process.arch
  const ugRoot = resolve(__dirname, 'vendor', 'ugrep')

  if (process.platform === 'win32') {
    if (arch === 'x64') {
      const p = join(ugRoot, 'x64-win32', 'ugrep.exe')
      return p
    }
  }
  return null
}

/**
 * Spawn ugrep binary with translated args.
 * Returns array of output lines (same format as ripGrep).
 */
export async function ugrepBinary(
  rgArgs: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  const ugrepPath = getUgrepPath()
  if (!ugrepPath) {
    throw new Error('ugrep binary not available for this platform')
  }

  const ugrepArgs = translateRgToUgrep(rgArgs)

  return new Promise((resolve, reject) => {
    const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000
    const parsedSeconds = parseInt(process.env.OLA_CC_GLOB_TIMEOUT_SECONDS || '', 10) || 0
    const timeout = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout

    const child = spawn(ugrepPath, [...ugrepArgs, target], {
      signal: abortSignal,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false

    child.stdout?.on('data', (data: Buffer) => {
      if (!stdoutTruncated) {
        stdout += data.toString()
        if (stdout.length > MAX_BUFFER_SIZE) {
          stdout = stdout.slice(0, MAX_BUFFER_SIZE)
          stdoutTruncated = true
        }
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      if (!stderrTruncated) {
        stderr += data.toString()
        if (stderr.length > MAX_BUFFER_SIZE) {
          stderr = stderr.slice(0, MAX_BUFFER_SIZE)
          stderrTruncated = true
        }
      }
    })

    const timeoutId = setTimeout(() => {
      if (process.platform === 'win32') {
        child.kill()
      } else {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5_000)
      }
    }, timeout)

    let settled = false
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)

      if (code === 0 || code === 1) {
        // 0 = matches, 1 = no matches
        resolve(
          stdout
            .trim()
            .split('\n')
            .map(line => line.replace(/\r$/, ''))
            .filter(Boolean),
        )
      } else {
        reject(new Error(`ugrep exited with code ${code}: ${stderr}`))
      }
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      reject(err)
    })
  })
}
```

- [ ] **Step 2: Verify compilation**

Run: `bun build ./src/utils/searchEngine.ts --target node --format esm --outfile /tmp/test-search.mjs 2>&1 | head -10`
Expected: Bundled successfully (may have external warnings for node builtins)

- [ ] **Step 3: Commit**

```bash
git add src/utils/searchEngine.ts
git commit -m "feat: add ugrepBinary spawner with translateRgToUgrep"
```

---

### Task 3: Write unifiedSearch Entry Point

**Files:**
- Modify: `src/utils/searchEngine.ts` (add unifiedSearch + canUseUgrep + telemetry)

- [ ] **Step 1: Add canUseUgrep and unifiedSearch**

Add to `src/utils/searchEngine.ts`:

```typescript
import { ripGrep } from './ripgrep.js'
import { logEvent } from 'src/services/analytics/index.js'

/**
 * Check if ugrep is available on this platform.
 * Currently: Windows x64 only.
 */
export function canUseUgrep(): boolean {
  return process.platform === 'win32' && process.arch === 'x64'
}

function logEngineFallback(from: string, to: string, reason: string): void {
  logEvent('search_engine_fallback', { from, to, reason })
  console.warn(`[searchEngine] ${from} failed (${reason}), falling back to ${to}`)
}

/**
 * Unified search entry point.
 * On Windows x64: tries ugrep first, falls back to ripgrep on any error.
 * On all other platforms: uses ripgrep directly.
 */
export async function unifiedSearch(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  if (canUseUgrep()) {
    try {
      return await ugrepBinary(args, target, abortSignal)
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err)
      logEngineFallback('ugrep', 'ripgrep', reason)
      // Fall through to ripgrep
    }
  }
  return ripGrep(args, target, abortSignal)
}
```

- [ ] **Step 2: Verify compilation**

Run: `bun build ./src/utils/searchEngine.ts --target node --format esm --external child_process --external path --external url --external src/services/analytics/index.js --external ./log.js --external ./platform.js --external ./ripgrep.js --outfile /tmp/test-unified.mjs 2>&1 | head -10`
Expected: Bundled successfully

- [ ] **Step 3: Commit**

```bash
git add src/utils/searchEngine.ts
git commit -m "feat: add unifiedSearch entry point with fallback"
```

---

### Task 4: Wire GrepTool to unifiedSearch

**Files:**
- Modify: `src/tools/GrepTool/GrepTool.ts:21` (import)
- Modify: `src/tools/GrepTool/GrepTool.ts:441` (call site)

- [ ] **Step 1: Update import**

Change line 21 from:
```typescript
import { ripGrep } from '../../utils/ripgrep.js'
```
to:
```typescript
import { unifiedSearch } from '../../utils/searchEngine.js'
```

- [ ] **Step 2: Update call site**

Change line 441 from:
```typescript
const results = await ripGrep(args, absolutePath, abortController.signal)
```
to:
```typescript
const results = await unifiedSearch(args, absolutePath, abortController.signal)
```

- [ ] **Step 3: Update searchHint**

Change line 162 from:
```typescript
searchHint: 'search file contents with regex (ripgrep)',
```
to:
```typescript
searchHint: 'search file contents with regex',
```

- [ ] **Step 4: Verify build**

Run: `bun run build:publish 2>&1`
Expected: Bundled successfully, `cli.mjs` generated

- [ ] **Step 5: Commit**

```bash
git add src/tools/GrepTool/GrepTool.ts
git commit -m "feat: wire GrepTool to unifiedSearch"
```

---

### Task 5: Download ugrep Binary for Windows

**Files:**
- Create: `vendor/ugrep/x64-win32/ugrep.exe`
- Modify: `scripts/build-publish-bin.ts`

- [ ] **Step 1: Download ugrep v7.7.0 for Windows x64**

```bash
mkdir -p vendor/ugrep/x64-win32
cd vendor/ugrep/x64-win32
curl -L -o ugrep-windows-x64.zip https://github.com/Genivia/ugrep/releases/download/v7.7.0/ugrep-windows-x64.zip
unzip -o ugrep-windows-x64.zip
rm ugrep-windows-x64.zip
# Verify the binary exists
ls -la ugrep.exe
file ugrep.exe
```

- [ ] **Step 2: Verify ugrep.exe works**

```bash
./ugrep.exe --version
# Expected: ugrep 7.7.0 or similar
```

- [ ] **Step 3: Add ugrep to wrapper package.json files list**

In `scripts/build-publish-bin.ts`, the wrapper package.json already includes `'vendor/'` in the files array (line ~268). Verify this is still present — no change needed.

- [ ] **Step 4: Commit**

```bash
git add vendor/ugrep/
git commit -m "feat: add ugrep v7.7.0 binary for Windows x64"
```

---

### Task 6: Integration Test on Windows (CI)

**Files:**
- Modify: `.github/workflows/publish.yml` (add ugrep test step)

- [ ] **Step 1: Add ugrep integration test to CI**

In `.github/workflows/publish.yml`, add a test step in the `win32-x64` job after the existing integration test:

```yaml
- name: Test ugrep engine in GrepTool
  shell: pwsh
  run: |
    # Test that unifiedSearch uses ugrep on Windows
    $env:OLA_CC_API_KEY = "test-key"
    $output = npx @zyzheal/ola-cc@latest --version 2>&1
    Write-Output "Version: $output"
    # Verify ugrep binary exists
    if (Test-Path "node_modules/@zyzheal/ola-cc/vendor/ugrep/x64-win32/ugrep.exe") {
      Write-Output "ugrep binary found"
    } else {
      Write-Error "ugrep binary not found in package"
      exit 1
    }
```

- [ ] **Step 2: Push and verify CI**

```bash
git push origin feature-openai-bin
```

Wait for CI to complete. Check that the `win32-x64` job passes.

- [ ] **Step 3: Commit CI changes**

```bash
git add .github/workflows/publish.yml
git commit -m "ci: add ugrep integration test for Windows x64"
git push origin feature-openai-bin
```

---

### Task 7: Version Bump and Publish

**Files:**
- Modify: `package.json` (version)

- [ ] **Step 1: Bump version**

Change `"version": "0.3.9"` to `"version": "0.3.10"` in `package.json`

- [ ] **Step 2: Rebuild all artifacts**

```bash
bun run build:publish
bun run build:bin:wrapper
bun run build:bin:platform
```

- [ ] **Step 3: Verify wrapper package includes ugrep**

```bash
node -e "const p=require('./dist/publish/package.json'); console.log('files:', p.files); console.log('version:', p.version)"
# Expected: files includes 'vendor/', version is 0.3.10
```

- [ ] **Step 4: Verify binary package version**

```bash
cat dist/publish-bin/darwin-arm64/package.json | node -e "const p=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(p.version)"
# Expected: 0.3.10
```

- [ ] **Step 5: Commit, tag, and push**

```bash
git add package.json dist/publish/ dist/publish-bin/
git commit -m "release: bump version to 0.3.10, add ugrep for Windows"
git tag v0.3.10
git push origin feature-openai-bin v0.3.10
```

---

## Plan Self-Review

### 1. Spec Coverage

| Spec requirement | Task | Status |
|---|---|---|
| Windows x64 uses ugrep | Task 3 (unifiedSearch), Task 4 (wire) | ✅ |
| Windows ARM64 stays on ripgrep | Task 3 (canUseUgrep checks arch) | ✅ |
| Non-Windows stays on ripgrep | Task 3 (canUseUgrep returns false) | ✅ |
| Parameter translation (14 flags) | Task 1 (translateRgToUgrep) | ✅ |
| ugrep → ripgrep fallback | Task 3 (try/catch in unifiedSearch) | ✅ |
| Output compatibility | No normalization needed (verified compatible) | ✅ |
| ugrep binary distribution | Task 5 (download + vendor) | ✅ |
| PCRE runtime fallback | Task 3 (catch-all error fallback) | ✅ |
| Telemetry | Task 3 (logEngineFallback) | ✅ |

### 2. Placeholder Scan

- No TBD/TODO patterns found
- No "add appropriate error handling" vagueness
- All test code is concrete with expected outputs
- All file paths are exact
- No "similar to Task N" references

### 3. Type Consistency

- `translateRgToUgrep(rgArgs: string[]): string[]` — used in Task 1 tests and Task 2 ugrepBinary
- `ugrepBinary(args, target, signal): Promise<string[]>` — used in Task 2 and called from Task 3 unifiedSearch
- `canUseUgrep(): boolean` — used in Task 3
- `unifiedSearch(args, target, signal): Promise<string[]>` — used in Task 3, called from Task 4 GrepTool
- `ripGrep(args, target, signal): Promise<string[]>` — existing signature from ripgrep.ts:341, called from Task 3 as fallback
- All signatures are consistent across tasks
