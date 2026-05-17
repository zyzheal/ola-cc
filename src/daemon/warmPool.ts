// Warm Spare Pool - maintains pre-spawned worker processes for fast session startup

import { spawn, type ChildProcess } from 'child_process'
import { feature } from 'bun:bundle'
import type { WarmWorkerAssign, WarmWorkerAck } from './protocol.js'
import { logForDebugging } from '../utils/debug'

const DEFAULT_WARM_POOL_SIZE = feature('DEV_FULL') ? 2 : 0

interface WarmWorker {
  pid: number
  process: ChildProcess
  createdAt: number
  assignedSessions: number
}

class WarmPool {
  private idleWorkers: WarmWorker[] = []
  private targetSize: number
  private replenishing = new Set<number>()

  constructor(targetSize: number = DEFAULT_WARM_POOL_SIZE) {
    this.targetSize = targetSize
  }

  getTargetSize(): number {
    return this.targetSize
  }

  setTargetSize(size: number): void {
    this.targetSize = size
    if (size > this.idleWorkers.length + this.replenishing.size) {
      this.replenish()
    }
  }

  getIdleCount(): number {
    return this.idleWorkers.length
  }

  getStatus(): { targetSize: number; idle: number; replenishing: number } {
    return {
      targetSize: this.targetSize,
      idle: this.idleWorkers.length,
      replenishing: this.replenishing.size,
    }
  }

  /**
   * Initialize the pool by spawning warm workers up to the target size.
   * Called during daemon startup.
   */
  async initialize(): Promise<void> {
    if (this.targetSize <= 0) return
    await this.replenish()
  }

  /**
   * Acquire an idle warm worker from the pool.
   * Returns null if no workers are available.
   */
  acquireWorker(): WarmWorker | null {
    // Clean up dead workers
    let cleanedUp = false
    this.idleWorkers = this.idleWorkers.filter(w => {
      if (w.process.exitCode !== null || w.process.signalCode !== null) {
        this.replenishing.delete(w.pid)
        cleanedUp = true
        return false
      }
      return true
    })

    const worker = this.idleWorkers.shift()
    if (!worker) return null

    // If we cleaned up dead workers and pool is below target, replenish asynchronously
    if (cleanedUp && this.idleWorkers.length < this.targetSize && this.targetSize > 0) {
      this.replenish().catch(err => {
        logForDebugging(`[warm-pool] post-acquire replenish failed: ${err}`)
      })
    }

    logForDebugging(
      `[warm-pool] acquired worker (PID: ${worker.pid}), pool now has ${this.idleWorkers.length} idle`,
    )
    return worker
  }

  /**
   * Assign work to a warm worker via IPC.
   */
  async assignWork(worker: WarmWorker, work: WarmWorkerAssign): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const timeout = setTimeout(() => {
        worker.process.off('message', handleMessage)
        logForDebugging('[warm-pool] assign work timed out')
        resolve(false)
      }, 5000)

      const handleMessage = (data: unknown) => {
        const msg = data as WarmWorkerAck | { type: string }
        if (msg.type === 'work_ack' && (msg as WarmWorkerAck).sessionId === work.sessionId) {
          clearTimeout(timeout)
          worker.process.off('message', handleMessage)
          worker.assignedSessions++
          resolve(true)
        }
      }

      worker.process.on('message', handleMessage)
      worker.process.send!(work)
    })
  }

  /**
   * Replenish the pool by spawning new workers up to target size.
   */
  async replenish(): Promise<void> {
    const needed = this.targetSize - this.idleWorkers.length - this.replenishing.size
    if (needed <= 0) return

    logForDebugging(`[warm-pool] replenishing: need ${needed} workers`)

    const promises: Promise<void>[] = []
    for (let i = 0; i < needed; i++) {
      promises.push(this.spawnWarmWorker())
    }
    // Use allSettled so a single worker failure doesn't block pool initialization
    await Promise.allSettled(promises)
  }

  private async spawnWarmWorker(): Promise<void> {
    const workerId = 'warm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)

    const child = spawn(
      process.execPath,
      ['--warm-worker', workerId],
      {
        detached: true,
        stdio: ['ipc', 'pipe', 'pipe'],
      },
    )

    if (!child.pid || !child.send) {
      // IPC not available, skip warm pool for this worker
      if (child.pid) this.replenishing.delete(child.pid)
      child.kill()
      return
    }

    const worker: WarmWorker = {
      pid: child.pid,
      process: child,
      createdAt: Date.now(),
      assignedSessions: 0,
    }

    this.replenishing.add(child.pid)

    child.on('exit', () => {
      this.replenishing.delete(worker.pid)
      // Remove from idle if still there
      this.idleWorkers = this.idleWorkers.filter(w => w.pid !== worker.pid)
      logForDebugging(`[warm-pool] warm worker exited (PID: ${worker.pid})`)
      // Auto-replenish if we're below target
      if (this.targetSize > 0) {
        this.replenish().catch(err => {
          logForDebugging(`[warm-pool] auto-replenish failed: ${err}`)
        })
      }
    })

    // Worker signals readiness by sending 'warm_ready'
    child.on('message', (data: unknown) => {
      const msg = data as { type: string }
      if (msg.type === 'warm_ready') {
        this.replenishing.delete(worker.pid)
        this.idleWorkers.push(worker)
        logForDebugging(
          `[warm-pool] worker ready (PID: ${worker.pid}), pool now has ${this.idleWorkers.length} idle`,
        )
      }
    })

    // Set a timeout in case worker never signals ready
    setTimeout(() => {
      if (this.replenishing.has(worker.pid)) {
        logForDebugging(`[warm-pool] worker slow to start, killing (PID: ${worker.pid})`)
        this.replenishing.delete(worker.pid)
        this.idleWorkers = this.idleWorkers.filter(w => w.pid !== worker.pid)
        try { child.kill('SIGKILL') } catch {}
      }
    }, 10000)
  }

  /**
   * Shut down all workers in the pool.
   */
  async shutdown(): Promise<void> {
    const workers = [...this.idleWorkers]
    this.idleWorkers = []
    for (const worker of workers) {
      try {
        worker.process.kill('SIGTERM')
      } catch {}
    }
    // Wait briefly for graceful exit
    await Promise.allSettled(
      workers.map(w => new Promise<void>(resolve => {
        w.process.on('exit', resolve)
        setTimeout(resolve, 2000)
      })),
    )
  }
}

export { WarmPool, DEFAULT_WARM_POOL_SIZE }
