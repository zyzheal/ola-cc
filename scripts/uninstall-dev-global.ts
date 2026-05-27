#!/usr/bin/env bun
/**
 * 卸载开发版本全局符号链接
 */

import { unlink, access } from 'node:fs/promises'

const CMD_NAME = 'ola-cc-dev'
const LINK_PATH = `/usr/local/bin/${CMD_NAME}`

try {
  await access(LINK_PATH)
  await unlink(LINK_PATH)
  console.log(`[ola-cc-dev] 已卸载: ${LINK_PATH}`)
  console.log('[ola-cc-dev] 正式版本不受影响')
} catch {
  console.log(`[ola-cc-dev] 未找到符号链接，无需卸载: ${LINK_PATH}`)
}
