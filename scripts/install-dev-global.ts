#!/usr/bin/env bun
/**
 * 一键全局安装开发版本脚本
 *
 * 构建开发版本并全局安装，命令名为 ola-cc-dev，
 * 不会与正式的 ola-cc 或 claude 命令冲突。
 */

import { $ } from 'bun'
import { symlink, readFile, mkdir, unlink, access } from 'node:fs/promises'
import { dirname } from 'node:path'

const CMD_NAME = 'ola-cc-dev'
const PROJECT_ROOT = process.cwd()
const BIN_DIR = '/usr/local/bin'
const DEV_BIN = `${PROJECT_ROOT}/cli-dev`

console.log('[ola-cc-dev] 构建开发版本...')
await $`bun run build:dev`

console.log('[ola-cc-dev] 创建全局符号链接...')
const linkPath = `${BIN_DIR}/${CMD_NAME}`
const shebang = '#!/usr/bin/env node\n'
const binDir = dirname(linkPath)

// 确保 /usr/local/bin 存在
try {
  await access(binDir)
} catch {
  await mkdir(binDir, { recursive: true })
}

// 删除旧链接（如果存在）
try {
  await unlink(linkPath)
  console.log('[ola-cc-dev] 移除旧的符号链接')
} catch {
  // 不存在，忽略
}

await symlink(DEV_BIN, linkPath)

console.log('')
console.log('=== ola-cc-dev 安装完成 ===')
console.log(`构建输出: ${DEV_BIN}`)
console.log(`全局命令: ${linkPath}`)
console.log('')
console.log('使用方式:')
console.log(`  ${CMD_NAME}          # 启动开发版本`)
console.log('')
console.log('与正式版本隔离:')
console.log('  ola-cc-dev           # 开发版（本版本）')
console.log('  ola-cc               # 正式版（如已安装）')
console.log('  claude               # 官方正式版（如已安装）')
console.log('')
console.log('卸载: rm /usr/local/bin/ola-cc-dev')
