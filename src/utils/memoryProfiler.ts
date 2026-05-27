/**
 * Memory Profiler — heap snapshot and memory diagnostics for long sessions.
 *
 * Provides:
 * 1. Periodic `process.memoryUsage()` sampling
 * 2. V8 heap snapshot capture on threshold breach (dev build only)
 * 3. Memory growth trend analysis per N turns
 * 4. Proactive compact recommendation signal
 *
 * Gated behind `feature('MEMORY_PROFILER')` — stripped from production builds.
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

// -- Configuration

/** Heap snapshot threshold (RSS > this → snapshot) */
const HEAP_SNAPSHOT_RSS_THRESHOLD_MB = 2_500

/** Sampling interval in turns */
const SAMPLE_INTERVAL_TURNS = 10

/** Growth alert: RSS increase over WINDOW_TURNS exceeds this MB */
const GROWTH_ALERT_MB = 500

/** Growth alert window */
const WINDOW_TURNS = 50

/** Max samples kept in memory */
const MAX_SAMPLES = 200

/** Snapshot throttle: minimum ms between snapshots */
const SNAPSHOT_THROTTLE_MS = 60_000

// -- Types

export interface MemorySample {
  turn: number
  timestamp: number
  rss: number      // MB
  heapTotal: number // MB
  heapUsed: number  // MB
  external: number  // MB
  arrayBuffers: number // MB
}

export interface GrowthAlert {
  type: 'growth'
  message: string
  rssIncreaseMB: number
  turns: number
}

export interface SnapshotEvent {
  type: 'snapshot'
  path: string
  rssMB: number
  reason: string
}

export type MemoryEvent = GrowthAlert | SnapshotEvent

// -- State

const samples: MemorySample[] = []
let turnCounter = 0
let lastSnapshotTime = 0
let loggedHighMemory = false

/** Directory for heap snapshots */
const SNAPSHOT_DIR = join(homedir(), '.ola-cc', 'heap-snapshots')

// -- Sampling

function getMemorySample(turn: number): MemorySample {
  const usage = process.memoryUsage()
  return {
    turn,
    timestamp: Date.now(),
    rss: Math.round(usage.rss / 1024 / 1024 * 100) / 100,
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100,
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100,
    external: Math.round(usage.external / 1024 / 1024 * 100) / 100,
    arrayBuffers: Math.round((usage.arrayBuffers ?? 0) / 1024 / 1024 * 100) / 100,
  }
}

// -- Heap snapshot (dev build only)

async function captureHeapSnapshot(rssMB: number, reason: string): Promise<string | null> {
  const now = Date.now()
  if (now - lastSnapshotTime < SNAPSHOT_THROTTLE_MS) {
    return null // Throttled
  }
  lastSnapshotTime = now

  try {
    // Dynamically import v8 — might not be available in all runtimes
    const v8 = await import('v8')
    if (typeof v8.writeHeapSnapshot !== 'function') return null

    if (!existsSync(SNAPSHOT_DIR)) {
      mkdirSync(SNAPSHOT_DIR, { recursive: true })
    }

    const label = reason.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 40)
    const filename = `heap-${label}-${now}-rss${Math.round(rssMB)}.heapsnapshot`
    const filePath = join(SNAPSHOT_DIR, filename)

    v8.writeHeapSnapshot(filePath)
    return filePath
  } catch {
    return null
  }
}

// -- Logging

function logMemoryEvent(event: MemoryEvent): void {
  const logDir = join(homedir(), '.ola-cc', 'logs')
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }
  const logFile = join(logDir, 'memory-profile.log')

  const line = `[${new Date().toISOString()}] ${JSON.stringify(event)}\n`
  try {
    appendFileSync(logFile, line)
  } catch {
    // Best-effort logging
  }
}

// -- Analysis

function analyzeGrowth(): MemoryEvent | null {
  if (samples.length < 2) return null

  const latest = samples[samples.length - 1]!
  const windowStart = samples.find(s => s.turn >= latest.turn - WINDOW_TURNS)
  if (!windowStart || windowStart === latest) return null

  const rssIncrease = latest.rss - windowStart.rss
  if (rssIncrease > GROWTH_ALERT_MB) {
    return {
      type: 'growth',
      message: `RSS grew ${rssIncrease.toFixed(0)} MB over ${latest.turn - windowStart.turn} turns (${windowStart.rss.toFixed(0)} → ${latest.rss.toFixed(0)} MB)`,
      rssIncreaseMB: Math.round(rssIncrease),
      turns: latest.turn - windowStart.turn,
    }
  }

  return null
}

// -- Public API

/**
 * Record a memory sample and return any detected events.
 * Call once per API turn.
 */
export async function sampleMemory(
  force = false,
): Promise<MemoryEvent[]> {
  if (!force && turnCounter++ % SAMPLE_INTERVAL_TURNS !== 0) {
    return []
  }

  const sample = getMemorySample(samples.length)
  samples.push(sample)

  // Keep samples bounded
  if (samples.length > MAX_SAMPLES) {
    samples.splice(0, samples.length - MAX_SAMPLES)
  }

  const events: MemoryEvent[] = []

  // Check for high RSS → heap snapshot
  if (sample.rss > HEAP_SNAPSHOT_RSS_THRESHOLD_MB && !loggedHighMemory) {
    loggedHighMemory = true
    const snapshotPath = await captureHeapSnapshot(sample.rss, 'high-rss')
    if (snapshotPath) {
      const event: SnapshotEvent = {
        type: 'snapshot',
        path: snapshotPath,
        rssMB: sample.rss,
        reason: `RSS exceeded ${HEAP_SNAPSHOT_RSS_THRESHOLD_MB} MB threshold`,
      }
      events.push(event)
      logMemoryEvent(event)
    }
  }

  // RSS-based snapshot (every 500MB climb)
  if (sample.rss > 1000 && sample.turn > 0) {
    const baseSample = samples[0]!
    const climb = sample.rss - baseSample.rss
    if (climb > 500 && climb % 500 < 50) {
      const snapshotPath = await captureHeapSnapshot(sample.rss, `rss-climb-${Math.round(climb / 500) * 500}`)
      if (snapshotPath) {
        const event: SnapshotEvent = {
          type: 'snapshot',
          path: snapshotPath,
          rssMB: sample.rss,
          reason: `RSS climbed ${Math.round(climb)} MB from baseline`,
        }
        events.push(event)
        logMemoryEvent(event)
      }
    }
  }

  // Growth trend alert
  const growthAlert = analyzeGrowth()
  if (growthAlert) {
    events.push(growthAlert)
    logMemoryEvent(growthAlert)
  }

  return events
}

/**
 * Get the current memory trend summary.
 * Useful for inline diagnostics.
 */
export function getMemorySummary(): string {
  if (samples.length === 0) return 'No samples'

  const latest = samples[samples.length - 1]!
  const first = samples[0]!
  const peak = [...samples].reduce((max, s) => s.rss > max.rss ? s : max, samples[0]!)

  const lines = [
    `Memory (${samples.length} samples across ${latest.turn} turns):`,
    `  RSS:       ${first.rss.toFixed(0)} → ${latest.rss.toFixed(0)} MB (peak ${peak.rss.toFixed(0)} MB)`,
    `  Heap:      ${latest.heapUsed.toFixed(0)}/${latest.heapTotal.toFixed(0)} MB used/total`,
    `  External:  ${latest.external.toFixed(0)} MB`,
    `  Buffers:   ${latest.arrayBuffers.toFixed(0)} MB`,
  ]

  const growth = first.rss > 0
    ? ((latest.rss - first.rss) / first.rss * 100).toFixed(0)
    : '0'
  lines.push(`  Growth:    ${growth}% from baseline`)

  if (loggedHighMemory) {
    lines.push('  ⚠ High memory threshold was breached')
  }

  return lines.join('\n')
}

/**
 * Check if memory pressure suggests proactive compaction.
 * Returns a score 0-1 (0=normal, 1=critical).
 */
export function getMemoryPressure(): number {
  if (samples.length < 2) return 0

  const latest = samples[samples.length - 1]!
  const first = samples[0]!

  if (latest.rss < 500) return 0 // Below 500MB → no pressure

  // Factor 1: absolute RSS (0-0.5)
  const rssFactor = Math.min(latest.rss / 4000, 0.5)

  // Factor 2: growth rate (0-0.3)
  const growthRate = first.rss > 0 ? (latest.rss - first.rss) / first.rss : 0
  const growthFactor = Math.min(growthRate * 0.3, 0.3)

  // Factor 3: heap utilization (0-0.2)
  const heapUtil = latest.heapTotal > 0 ? latest.heapUsed / latest.heapTotal : 0
  const heapFactor = Math.min(heapUtil * 0.2, 0.2)

  return Math.min(rssFactor + growthFactor + heapFactor, 1)
}

/**
 * Reset profiler state (e.g., after compact).
 */
export function resetMemoryProfiler(): void {
  samples.length = 0
  turnCounter = 0
  loggedHighMemory = false
}
