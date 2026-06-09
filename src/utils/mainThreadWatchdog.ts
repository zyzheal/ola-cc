/**
 * Main thread watchdog: runs in a worker thread to detect when the main
 * thread is stuck in a synchronous loop. The worker sends heartbeat
 * requests to the main thread; if the main thread doesn't respond within
 * a timeout, the worker logs a diagnostic message.
 *
 * Usage: import and call startMainThreadWatchdog() from the main thread.
 * Set OLA_CC_CPU_DEBUG=1 to enable.
 */

import { parentPort, Worker } from 'worker_threads'
import { appendFileSync } from 'fs'

const WATCHDOG_INTERVAL_MS = 2000
const WATCHDOG_TIMEOUT_MS = 3000

let _worker: Worker | null = null
let _lastHeartbeatAck = Date.now()
let _logFile: string | null = null

function log(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  if (_logFile) {
    try {
      appendFileSync(_logFile, line)
    } catch {}
  }
  process.stderr.write(line)
}

export function startMainThreadWatchdog(logFile?: string): void {
  if (process.env.OLA_CC_CPU_DEBUG !== '1') return
  _logFile = logFile ?? process.env.OLA_CC_CPU_LOG_FILE ?? null

  // Create a minimal worker that pings the main thread
  const workerCode = `
    const { parentPort } = require('worker_threads');
    let lastAck = Date.now();
    let pending = false;

    parentPort.on('message', (msg) => {
      if (msg === 'ack') {
        lastAck = Date.now();
        pending = false;
      }
    });

    setInterval(() => {
      if (pending) {
        const elapsed = Date.now() - lastAck;
        if (elapsed > ${WATCHDOG_TIMEOUT_MS}) {
          parentPort.postMessage({ type: 'stuck', elapsed });
        }
      } else {
        pending = true;
        parentPort.postMessage({ type: 'ping' });
      }
    }, ${WATCHDOG_INTERVAL_MS});
  `

  try {
    _worker = new Worker(workerCode, { eval: true })

    _worker.on('message', (msg: { type: string; elapsed?: number }) => {
      if (msg.type === 'ping') {
        // Main thread is responsive — send ack
        _lastHeartbeatAck = Date.now()
        _worker?.postMessage('ack')
      } else if (msg.type === 'stuck') {
        log(`[WATCHDOG] Main thread stuck for ${msg.elapsed}ms! Possible synchronous infinite loop.`)
        // Try to get a stack trace (this runs on the main thread, which is stuck,
        // so we can't get a live stack — but we can log the last known state)
        log(`[WATCHDOG] Last heartbeat ack: ${new Date(_lastHeartbeatAck).toISOString()}`)
      }
    })

    _worker.on('error', (err) => {
      log(`[WATCHDOG] Worker error: ${err.message}`)
    })

    log('[WATCHDOG] Main thread watchdog started')
  } catch (err) {
    log(`[WATCHDOG] Failed to start: ${(err as Error).message}`)
  }
}

export function stopMainThreadWatchdog(): void {
  if (_worker) {
    _worker.terminate()
    _worker = null
  }
}
