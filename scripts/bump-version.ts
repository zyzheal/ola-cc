#!/usr/bin/env bun
/**
 * 版本升级脚本
 *
 * 原子化处理版本升级流程：
 *   1. 检查是否有未提交的修改
 *   2. 更新 package.json 版本号
 *   3. 重新构建产物（确保 dist/ 中版本一致）
 *   4. 创建 git commit + tag
 *
 * 用法:
 *   bun run ./scripts/bump-version.ts 0.3.2        # 升级到指定版本
 *   bun run ./scripts/bump-version.ts patch         # 自动递增 patch (0.3.1 -> 0.3.2)
 *   bun run ./scripts/bump-version.ts minor         # 自动递增 minor (0.3.1 -> 0.4.0)
 *   bun run ./scripts/bump-version.ts major         # 自动递增 major (0.3.1 -> 1.0.0)
 */

import { $ } from 'bun'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const rootPkgPath = join(process.cwd(), 'package.json')
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'))
const currentVersion = rootPkg.version

function parseVersion(v: string): { major: number; minor: number; patch: number } {
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) throw new Error(`Invalid version: ${v}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function bumpVersion(current: string, target: string): string {
  const { major, minor, patch } = parseVersion(current)

  if (target === 'patch') return `${major}.${minor}.${patch + 1}`
  if (target === 'minor') return `${major}.${minor + 1}.0`
  if (target === 'major') return `${major + 1}.0.0`

  // Explicit version
  if (/^\d+\.\d+\.\d+$/.test(target)) return target

  throw new Error(`Invalid version target: "${target}". Use major, minor, patch, or a specific version like 0.3.2`)
}

async function main() {
  const args = process.argv.slice(2)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: bun run ./scripts/bump-version.ts <version>

Version targets:
  patch    Increment patch (0.3.1 -> 0.3.2)
  minor    Increment minor (0.3.1 -> 0.4.0)
  major    Increment major (0.3.1 -> 1.0.0)
  X.Y.Z    Set specific version (0.3.2)

Current version: ${currentVersion}`)
    process.exit(0)
  }

  const targetArg = args[0]!
  const newVersion = bumpVersion(currentVersion, targetArg)

  console.log(`\n=== Version Bump ===`)
  console.log(`Current:  ${currentVersion}`)
  console.log(`New:      ${newVersion}\n`)

  // Step 1: Check for uncommitted changes
  console.log('[1/4] Checking for uncommitted changes...')
  const statusResult = await $`git status --porcelain`.quiet()
  if (statusResult.stdout.trim()) {
    console.warn('WARNING: You have uncommitted changes. They will be included in the version bump commit.')
    console.warn(statusResult.stdout)
    const { confirm } = await import('bun:prompt').then(m => m.confirm || (() => Promise.resolve(true)))
    // Continue anyway since we can't easily prompt in non-interactive mode
  }

  // Step 2: Update package.json
  console.log('[2/4] Updating package.json...')
  rootPkg.version = newVersion
  writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n')

  // Step 3: Rebuild dist artifacts to ensure version consistency
  console.log('[3/4] Rebuilding dist artifacts...')

  if (existsSync(join(process.cwd(), 'dist', 'publish'))) {
    console.log('  Rebuilding publish bundle...')
    const buildPublish = Bun.spawn({
      cmd: ['bun', 'run', './scripts/build-publish.ts', '--publish'],
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await buildPublish.exited
    if (buildPublish.exitCode !== 0) {
      console.error('  ERROR: build-publish.ts failed, rolling back')
      rootPkg.version = currentVersion
      writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n')
      process.exit(1)
    }
  }

  if (existsSync(join(process.cwd(), 'dist', 'publish-bin', 'darwin-arm64'))) {
    console.log('  Rebuilding binary packages...')
    // Rebuild wrapper to update version in optionalDependencies
    const buildBin = Bun.spawn({
      cmd: ['bun', 'run', './scripts/build-publish-bin.ts', '--only-wrapper'],
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await buildBin.exited
    if (buildBin.exitCode !== 0) {
      console.error('  ERROR: build-publish-bin.ts failed, rolling back')
      rootPkg.version = currentVersion
      writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n')
      process.exit(1)
    }
  }

  // Step 4: Commit and tag
  console.log('[4/4] Creating commit and tag...')

  // Stage changed files
  await $`git add package.json`
  // Stage dist files that were modified
  await $`git add dist/`.quiet()

  // Create commit
  await $`git commit -m "chore: bump version to ${newVersion}"`

  // Create tag
  const tagName = `v${newVersion}`
  // Delete existing tag if it exists locally
  const tagExists = await $`git tag -l ${tagName}`.quiet()
  if (tagExists.stdout.trim()) {
    await $`git tag -d ${tagName}`
  }
  await $`git tag ${tagName}`

  console.log(`\n=== Done ===`)
  console.log(`Version bumped to ${newVersion}`)
  console.log(`Commit:  ${tagName}`)
  console.log(`\nTo push:\n  git push origin HEAD && git push origin ${tagName}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
