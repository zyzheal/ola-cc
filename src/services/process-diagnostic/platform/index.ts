import type { PlatformOps } from './types.js'

// 懒加载平台实现，避免非当前平台的代码被加载
let cached: PlatformOps | null = null

export function getPlatformOps(): PlatformOps {
  if (cached) return cached

  const platform = process.platform

  if (platform === 'darwin') {
    cached = require('./darwin.js').default
  } else if (platform === 'linux') {
    cached = require('./linux.js').default
  } else if (platform === 'win32') {
    cached = require('./win32.js').default
  } else if (platform === 'freebsd') {
    cached = require('./freebsd.js').default
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }

  return cached
}

export type { PlatformOps } from './types.js'
