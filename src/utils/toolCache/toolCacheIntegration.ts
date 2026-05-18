import { getToolResultCache, ToolResultCache } from './ToolResultCache.js'

// Tools that are safe to cache (read-only, deterministic output)
const CACHEABLE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'FileReadTool',
])

// Commands considered read-only for Bash tool caching
const READONLY_BASH_COMMANDS = [
  'ls ', 'cat ', 'head ', 'tail ', 'wc ', 'find ',
  'grep ', 'echo ', 'stat ', 'file ', 'du ', 'df ',
  'git status', 'git log', 'git diff', 'git branch',
  'git show', 'git tag', 'git describe',
]

/**
 * Check if a tool call is eligible for caching.
 */
export function isCacheableTool(toolName: string, input: Record<string, unknown>): boolean {
  if (!CACHEABLE_TOOLS.has(toolName)) return false

  // For Bash tool, only cache read-only commands
  if (toolName === 'Bash' || toolName === 'bash') {
    const cmd = (input.command as string) || ''
    return READONLY_BASH_COMMANDS.some(prefix => cmd.startsWith(prefix))
  }

  return true
}

/**
 * Extract file paths from tool input for cache invalidation.
 */
export function extractFilePaths(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const paths: string[] = []

  switch (toolName) {
    case 'Read':
    case 'FileReadTool':
      if (typeof input.path === 'string') paths.push(input.path)
      break
    case 'Glob':
      // Glob reads patterns, results depend on filesystem state
      // We invalidate on any file mutation (no specific path)
      break
    case 'Grep':
      if (typeof input.path === 'string') paths.push(input.path)
      break
  }

  return paths
}

/**
 * Try to get a cached result for a tool call.
 * Returns the cached output string, or null on miss.
 */
export function tryGetCachedToolResult(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  if (!isCacheableTool(toolName, input)) return null

  const key = ToolResultCache.makeKey(toolName, input)
  const cached = getToolResultCache().get(key)

  return cached?.output ?? null
}

/**
 * Store a tool result in the cache.
 */
export function cacheToolResult(
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  ephemeral: boolean = false,
): void {
  if (!isCacheableTool(toolName, input)) return

  const key = ToolResultCache.makeKey(toolName, input)
  const dependsOn = extractFilePaths(toolName, input)

  getToolResultCache().set(key, {
    output,
    dependsOn,
    ephemeral,
  })
}

/**
 * Invalidate cache entries for mutated files.
 * Call this after Edit, Write, or mutating Bash operations.
 */
export function invalidateToolCacheForFiles(paths: string[]): void {
  getToolResultCache().invalidateFiles(paths)
}

/**
 * Clear ephemeral cache entries at end of turn.
 */
export function clearEphemeralToolCache(): void {
  getToolResultCache().clearEphemeral()
}
