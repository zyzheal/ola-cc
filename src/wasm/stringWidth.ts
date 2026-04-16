/**
 * TypeScript wrapper for the string-width WASM module.
 *
 * Provides the same API as `src/ink/stringWidth.ts` with automatic
 * WASM loading and JS fallback.
 *
 * Usage:
 *   import { stringWidthWasm } from '../wasm/stringWidth'
 *   const width = stringWidthWasm('hello') // 5
 */

import { stringWidth as stringWidthFallback } from '../ink/stringWidth.js'

// WASM module (will be loaded by the bundler)
let wasmModule: typeof import('./pkg/string_width.js') | null = null
let wasmLoaded = false

/**
 * Load the WASM module. Called automatically on first use.
 */
async function loadWasm(): Promise<boolean> {
  if (wasmLoaded) return wasmModule !== null
  try {
    wasmModule = await import('./pkg/string_width.js')
    wasmLoaded = true
    return true
  } catch {
    wasmLoaded = true
    return false
  }
}

/**
 * Synchronous WASM string width calculation.
 * Falls back to JS implementation if WASM is not loaded.
 */
export function stringWidthWasmSync(str: string): number {
  if (wasmModule?.string_width_wasm) {
    return wasmModule.string_width_wasm(str)
  }
  return stringWidthFallback(str)
}

/**
 * Async WASM string width calculation.
 * Ensures WASM is loaded before calling.
 */
export async function stringWidthWasm(str: string): Promise<number> {
  if (!wasmLoaded) {
    await loadWasm()
  }
  return stringWidthWasmSync(str)
}

/**
 * Initialize the WASM module. Call this during app startup
 * if you want to pre-load WASM.
 */
export async function initStringWidthWasm(): Promise<boolean> {
  return loadWasm()
}

/**
 * Check if WASM is available.
 */
export function isWasmAvailable(): boolean {
  return wasmLoaded && wasmModule !== null
}
