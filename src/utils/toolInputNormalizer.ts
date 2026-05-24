/**
 * Tool input normalizer for cross-provider model compatibility.
 *
 * Non-Claude models (Qwen, Llama, etc.) frequently emit tool parameters
 * with incorrect types or field names. This module provides a preprocessor
 * that runs BEFORE Zod validation to fix common issues:
 *
 * 1. Stringified JSON → parsed arrays/objects
 *    e.g. `"[]"` → `[]`, `"{}"` → `{}`
 *
 * 2. Wrong scalar types
 *    e.g. `"30000"` (string) → `30000` (number)
 *
 * 3. Boolean coercions
 *    e.g. `"true"` (string) → `true` (boolean), `"false"` → `false`
 *
 * 4. Null/undefined handling
 *    e.g. `null` → `undefined` for optional fields
 *
 * 5. Field name aliases
 *    e.g. `content` → `old_string` for certain tools
 *
 * This runs in addition to the per-tool `normalizeToolInput` in api.ts
 * (which handles field name mappings) — this module handles TYPE coercion
 * that applies universally.
 */

/**
 * Try to parse a string value as JSON. Returns the parsed value if it
 * looks like a JSON array or object, otherwise returns the original string.
 */
function tryParseJsonString(value: string): unknown {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }
  return value
}

/**
 * Coerce a value to the expected type based on the target type hint.
 * This is a best-effort coercion — if it can't be done safely, the
 * original value is returned unchanged.
 */
function coerceValue(value: unknown, targetType: string): unknown {
  if (value === null) {
    return undefined
  }

  switch (targetType) {
    case 'number': {
      if (typeof value === 'number') return value
      if (typeof value === 'string') {
        const num = Number(value)
        if (!Number.isNaN(num)) return num
      }
      if (typeof value === 'boolean') return value ? 1 : 0
      break
    }
    case 'integer': {
      if (typeof value === 'number') return Math.floor(value)
      if (typeof value === 'string') {
        const num = parseInt(value, 10)
        if (!Number.isNaN(num)) return num
      }
      if (typeof value === 'boolean') return value ? 1 : 0
      break
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') {
        if (value.toLowerCase() === 'true') return true
        if (value.toLowerCase() === 'false') return false
        if (value === '1') return true
        if (value === '0') return false
      }
      if (typeof value === 'number') {
        return value !== 0
      }
      break
    }
    case 'string': {
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value)
      }
      if (Array.isArray(value) || (value && typeof value === 'object')) {
        return JSON.stringify(value)
      }
      break
    }
    case 'array': {
      if (Array.isArray(value)) return value
      if (typeof value === 'string') {
        return tryParseJsonString(value)
      }
      break
    }
    case 'object': {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value
      }
      if (typeof value === 'string') {
        return tryParseJsonString(value)
      }
      break
    }
  }

  return value
}

/**
 * Recursively normalize an input object, attempting to coerce values
 * to match the expected schema shape. This is intentionally heuristic —
 * we don't have the full Zod schema here (that's the caller's job),
 * but we can fix the most common type errors from non-Claude models.
 *
 * Strategy:
 * - For each key-value pair, check if the value is a stringified JSON
 * - If so, parse it
 * - For known tool parameter names with expected types, coerce explicitly
 */
export function normalizeToolInputTypes(
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    return input as Record<string, unknown>
  }

  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    if (value === null) {
      // Convert null to undefined so Zod optional() works correctly
      result[key] = undefined
      continue
    }

    if (typeof value === 'string') {
      // Check for stringified JSON in array/object fields
      const parsed = tryParseJsonString(value)
      if (parsed !== value) {
        // Successfully parsed as JSON — use the parsed value
        if (Array.isArray(parsed)) {
          // Recursively normalize array items
          result[key] = parsed.map((item) =>
            item && typeof item === 'object' && !Array.isArray(item)
              ? normalizeToolInputTypes(item as Record<string, unknown>)
              : item,
          )
        } else if (parsed && typeof parsed === 'object') {
          result[key] = normalizeToolInputTypes(parsed as Record<string, unknown>)
        } else {
          result[key] = parsed
        }
        continue
      }

      // Check for known numeric parameters — coerce strings to numbers
      if (isNumericParameter(key)) {
        const num = Number(value)
        if (!Number.isNaN(num)) {
          result[key] = num
          continue
        }
      }

      // Check for known boolean parameters — coerce strings to booleans
      if (isBooleanParameter(key)) {
        if (value.toLowerCase() === 'true') {
          result[key] = true
          continue
        }
        if (value.toLowerCase() === 'false') {
          result[key] = false
          continue
        }
      }
    }

    // Recursively normalize nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = normalizeToolInputTypes(value as Record<string, unknown>)
      continue
    }

    result[key] = value
  }

  return result
}

/**
 * Known tool parameter names that should be numbers.
 * This is a heuristic based on common tool schemas.
 */
function isNumericParameter(key: string): boolean {
  const numericKeys = new Set([
    // BashTool
    'timeout',
    // FileReadTool
    'offset',
    'limit',
    'maxLines',
    'max_lines',
    // Generic position/line
    'line',
    'line_number',
    'start_line',
    'end_line',
    // TaskOutputTool
    'wait_up_to',
    'waitUpTo',
    'task_id',
    'taskId',
    // Network/ports
    'port',
    // Array/list indices
    'index',
    'count',
    'depth',
    'retries',
    // GrepTool context lines
    '-B',
    '-A',
    '-C',
    'context',
    'head_limit',
  ])
  return numericKeys.has(key)
}

/**
 * Known tool parameter names that should be booleans.
 */
function isBooleanParameter(key: string): boolean {
  const booleanKeys = new Set([
    // BashTool
    'run_in_background',
    // FileEditTool
    'replace_all',
    'replaceAll',
    // TaskOutputTool
    'block',
    // File operations
    'recursive',
    'is_meta',
    'isMeta',
    // Display
    'verbose',
    'force',
    'dry_run',
    'dryRun',
    'include_hidden',
    'includeHidden',
    'show_line_numbers',
    'showLineNumbers',
    // GrepTool
    '-n',
    '-i',
    // GlobTool
    'case_sensitive',
  ])
  return booleanKeys.has(key)
}
