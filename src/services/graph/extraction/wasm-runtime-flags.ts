/**
 * WASM runtime flags -- workaround for the V8 turboshaft WASM Zone OOM.
 *
 * tree-sitter grammars are large WebAssembly modules. On Node >= 22 the V8
 * "turboshaft" optimizing WASM compiler can exhaust its per-compilation Zone
 * arena while compiling these grammars on a background thread.
 *
 * `--liftoff-only` forces every WASM module to the Liftoff baseline compiler
 * and never runs turboshaft, which eliminates the crash.
 *
 * This is a Node.js V8 workaround. Bun does not need it but we preserve
 * compatibility for Node.js execution paths.
 */

import { spawnSync } from 'child_process'

/**
 * The V8 flag(s) that keep tree-sitter grammar compilation off the turboshaft
 * optimizing tier.
 */
export const WASM_RUNTIME_FLAGS: readonly string[] = ['--liftoff-only']

/**
 * Env var set on the relaunched child so a detection slip can never cause an
 * infinite re-exec loop.
 */
const RELAUNCH_GUARD_ENV = 'OLA_CC_WASM_RELAUNCHED'

/**
 * Env var carrying the host PID across the re-exec.
 */
export const HOST_PPID_ENV = 'OLA_CC_HOST_PPID'

/** True when every required WASM runtime flag is already present in execArgv. */
export function process_has_wasm_runtime_flags(
  execArgv: readonly string[] = process.execArgv
): boolean {
  return WASM_RUNTIME_FLAGS.every((flag) => execArgv.includes(flag))
}

/**
 * Build the argv for re-execing node with the WASM runtime flags.
 */
export function build_relaunch_argv(
  scriptPath: string,
  scriptArgs: readonly string[],
  execArgv: readonly string[] = process.execArgv
): string[] {
  const preserved = execArgv.filter((arg) => !WASM_RUNTIME_FLAGS.includes(arg))
  return [...WASM_RUNTIME_FLAGS, ...preserved, scriptPath, ...scriptArgs]
}

/**
 * If the current process is missing the WASM runtime flags, re-exec it once
 * with them and exit with the child's status. No-op when flags are already
 * present, when already relaunched, or when disabled via OLA_CC_NO_RELAUNCH.
 */
export function relaunch_with_wasm_runtime_flags_if_needed(scriptPath: string): void {
  if (process_has_wasm_runtime_flags()) return
  if (process.env[RELAUNCH_GUARD_ENV]) return
  if (process.env.OLA_CC_NO_RELAUNCH) return

  const argv = build_relaunch_argv(scriptPath, process.argv.slice(2))
  const result = spawnSync(process.execPath, argv, {
    stdio: 'inherit',
    env: { ...process.env, [RELAUNCH_GUARD_ENV]: '1', [HOST_PPID_ENV]: String(process.ppid) },
    windowsHide: true,
  })

  if (result.error) {
    return
  }
  process.exit(result.status ?? (result.signal ? 1 : 0))
}

// ============================================================
// Backward-compatible camelCase aliases
// ============================================================

/** @deprecated Use process_has_wasm_runtime_flags */
export const processHasWasmRuntimeFlags = process_has_wasm_runtime_flags
/** @deprecated Use build_relaunch_argv */
export const buildRelaunchArgv = build_relaunch_argv
/** @deprecated Use relaunch_with_wasm_runtime_flags_if_needed */
export const relaunchWithWasmRuntimeFlagsIfNeeded = relaunch_with_wasm_runtime_flags_if_needed
