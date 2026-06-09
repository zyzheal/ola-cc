import type { ContainerMatch, ContainerRuntime } from '../types.js'
import { EXEC_TIMEOUT_MS } from '../constants.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// --- Helpers ---

async function run(bin: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  } catch (err: unknown) {
    // S5: 记录错误但不抛出 — 调用方依赖空字符串表示不可用
    if (err instanceof Error && 'stderr' in err) {
      // execFile errors include stderr for debugging
    }
    return ''
  }
}

async function isCommandAvailable(bin: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const cmd = platform === 'win32' ? 'where' : 'which'
  try {
    await execFileAsync(cmd, [bin], { timeout: 1000 })
    return true
  } catch {
    return false
  }
}

// --- Container Runtime Registry ---

const runtimes: ContainerRuntime[] = []
let initialized = false

export function registerRuntime(rt: ContainerRuntime): void {
  runtimes.push(rt)
}

/** I6: 延迟初始化 — 首次调用 resolveContainer/findContainerHostPID 时注册默认运行时 */
function ensureInitialized(): void {
  if (initialized) return
  initialized = true
  registerRuntime(createDockerLikeRuntime('docker', 'docker'))
  registerRuntime(createDockerLikeRuntime('podman', 'podman'))
  registerRuntime(createDockerLikeRuntime('nerdctl', 'nerdctl'))
  registerRuntime(k8sRuntime)
}

export async function resolveContainer(query: string, exact: boolean): Promise<ContainerMatch | null> {
  ensureInitialized()
  for (const rt of runtimes) {
    const avail = await rt.available()
    if (!avail) continue
    const containers = await rt.list()
    for (const c of containers) {
      if (matchContainer(c, query, exact)) return c
    }
  }
  return null
}

export async function findContainerHostPID(containerId: string): Promise<number | null> {
  ensureInitialized()
  for (const rt of runtimes) {
    const avail = await rt.available()
    if (!avail) continue
    const pid = await rt.hostPID(containerId)
    if (pid) return pid
  }
  return null
}

function matchContainer(c: ContainerMatch, query: string, exact: boolean): boolean {
  const target = exact ? query : query.toLowerCase()
  const fields = [c.id, c.name, c.image, c.composeService].filter(Boolean)
  for (const field of fields) {
    const source = exact ? field! : field!.toLowerCase()
    if (exact ? source === target : source.includes(target)) return true
  }
  return false
}

// --- Docker-like Runtime (shared for Docker, Podman, nerdctl) ---

function createDockerLikeRuntime(name: string, bin: string): ContainerRuntime {
  return {
    name,
    async available() { return isCommandAvailable(bin) },
    async list() {
      // 使用 JSON 输出格式，避免分隔符歧义
      const output = await run(bin, ['ps', '--format', '{{json .}}', '--no-trunc'])
      if (!output) return []
      const containers: ContainerMatch[] = []
      for (const line of output.split('\n')) {
        try {
          const data = JSON.parse(line)
          containers.push({
            id: data.ID || data.id || '',
            name: data.Names || data.name || '',
            image: data.Image || data.image || '',
            command: data.Command || '',
            state: data.State || data.Status || '',
            status: data.Status || '',
            ports: data.Ports || '',
            labels: parseLabels(data.Labels || ''),
            composeProject: extractLabel(data.Labels || '', 'com.docker.compose.project'),
            composeService: extractLabel(data.Labels || '', 'com.docker.compose.service'),
            health: healthFromStatus(data.Status || ''),
            runtime: name,
          })
        } catch {
          // skip malformed lines
        }
      }
      return containers
    },
    async hostPID(id: string) {
      // docker inspect --format '{{.State.Pid}}' <id>
      const output = await run(bin, ['inspect', '--format', '{{.State.Pid}}', id])
      const pid = Number(output)
      return isNaN(pid) || pid <= 0 ? null : pid
    },
  }
}

function parseLabels(labelStr: string): Record<string, string> {
  const labels: Record<string, string> = {}
  if (!labelStr) return labels
  for (const pair of labelStr.split(',')) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx > 0) {
      labels[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim()
    }
  }
  return labels
}

function extractLabel(labelStr: string, key: string): string | undefined {
  const labels = parseLabels(labelStr)
  return labels[key] || undefined
}

function healthFromStatus(status: string): 'healthy' | 'unhealthy' | 'starting' | 'none' {
  if (status.includes('(healthy)')) return 'healthy'
  if (status.includes('(unhealthy)')) return 'unhealthy'
  if (status.includes('(health: starting)')) return 'starting'
  return 'none'
}

// --- Kubernetes Runtime ---

const k8sRuntime: ContainerRuntime = {
  name: 'kubernetes',
  async available() {
    return isCommandAvailable('kubectl')
  },
  async list() {
    const output = await run('kubectl', ['get', 'pods', '--all-namespaces', '-o', 'json'])
    if (!output) return []
    try {
      const data = JSON.parse(output)
      const containers: ContainerMatch[] = []
      for (const pod of data.items || []) {
        const namespace = pod.metadata?.namespace || ''
        const podName = pod.metadata?.name || ''
        for (const container of pod.spec?.containers || []) {
          containers.push({
            id: `${namespace}/${podName}/${container.name}`,
            name: `${podName}/${container.name}`,
            image: container.image || '',
            command: (container.command || []).join(' '),
            state: pod.status?.phase || '',
            status: pod.status?.phase || '',
            ports: '',
            labels: pod.metadata?.labels || {},
            health: 'none',
            runtime: 'kubernetes',
          })
        }
      }
      return containers
    } catch {
      return []
    }
  },
  async hostPID(_id: string) {
    // K8s 不直接暴露宿主 PID
    return null
  },
}

// 默认运行时通过 ensureInitialized() 延迟注册，避免模块导入时执行子进程检测
