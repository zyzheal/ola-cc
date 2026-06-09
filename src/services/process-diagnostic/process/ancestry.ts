import type { PlatformOps } from '../platform/types.js'
import type { ProcessInfo } from '../types.js'
import { MAX_ANCESTRY_DEPTH } from '../constants.js'

/**
 * 构建祖先链: 从目标 PID 向上遍历到 init/launchd/services.exe
 * 返回: [init, ..., parent, target]
 */
export async function resolveAncestry(
  pid: number,
  platform: PlatformOps,
): Promise<ProcessInfo[]> {
  const chain: ProcessInfo[] = []
  const seen = new Set<number>()  // PID 循环检测
  let current = pid
  const initPID = await platform.getInitPID()

  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    // 循环检测：重复 PID 意味着链已闭合，无条件截断
    if (seen.has(current)) break
    seen.add(current)

    // S8: readProcess 失败时返回已收集的部分链
    let proc: ProcessInfo
    try {
      proc = await platform.readProcess(current)
    } catch {
      break
    }
    chain.push(proc)

    if (current === initPID) break

    // 直接使用 proc.ppid，避免额外调用 getParentPID
    const ppid = proc.ppid
    if (ppid === null || ppid === 0 || ppid === undefined) break
    current = ppid
  }

  chain.reverse()  // 使链为 [init, ..., parent, target]
  return chain
}
