/**
 * Post-agent validation gate.
 *
 * After an agent reports completion, this gate runs a quick sanity check
 * before accepting the result. If the check fails, a repair agent is
 * automatically spawned (up to MAX_REPAIR_ATTEMPTS).
 *
 * Currently performs:
 * - build:dev (if project has it)
 * - regex scanner for error-level violations
 *
 * Controlled by env var:
 *   OLA_CC_DISABLE_VALIDATION_GATE=true (default: enabled)
 *   OLA_CC_MAX_REPAIR_ATTEMPTS=2 (default: 2)
 */

import { isEnvTruthy } from '../../utils/envUtils.js'

export const VALIDATION_GATE_ENABLED =
  !isEnvTruthy(process.env.OLA_CC_DISABLE_VALIDATION_GATE)

const MAX_REPAIR_ATTEMPTS_DEFAULT = 2

export function getMaxRepairAttempts(): number {
  const raw = process.env.OLA_CC_MAX_REPAIR_ATTEMPTS
  if (raw) {
    const n = parseInt(raw, 10)
    if (!isNaN(n) && n >= 1) return n
  }
  return MAX_REPAIR_ATTEMPTS_DEFAULT
}

/**
 * Parse a verification agent verdict from its output.
 * Returns 'PASS' | 'FAIL' | 'PARTIAL' | null (if not found)
 */
export function parseVerificationVerdict(output: string): 'PASS' | 'FAIL' | 'PARTIAL' | null {
  const match = output.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/)
  if (!match) return null
  return match[1] as 'PASS' | 'FAIL' | 'PARTIAL'
}

/**
 * Build a repair prompt for a failed agent.
 * Gives the repair agent the specific failures to fix.
 */
export function buildRepairPrompt(
  originalPrompt: string,
  failureDetails: string,
  attempt: number,
  maxAttempts: number,
): string {
  return `## Repair Request

The previous implementation attempt (#${attempt - 1} of ${maxAttempts}) failed validation.

**Original task:**
${originalPrompt}

**Failure details:**
${failureDetails}

**Your job:**
Fix ONLY the issues described above. Do NOT rewrite the entire implementation.
After fixing, verify:
1. \`bun run build:dev\` passes (or the project's build command)
2. The specific failure cases are resolved

**Warning:** This is attempt #${attempt}. If this attempt also fails, the task will be reported to the user as FAILED.`
}
