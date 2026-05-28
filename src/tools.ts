// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { type Tool, type Tools } from './Tool.js'
import { AgentTool, registerAssembleToolPool } from './tools/AgentTool/AgentTool.js'
import { agentDetectorTool } from './tools/AgentTool/AgentDetectorTool.js'
import { singularityTool } from './tools/SingularityTool/SingularityTool.js'
let codegraphTool: any = null
try { codegraphTool = require('./tools/CodegraphTool/CodegraphTool.js').codegraphTool } catch (e) { console.error('[tools] Failed to load CodegraphTool:', e) }
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { ConfirmDomainAccessTool } from './tools/ConfirmDomainAccessTool.js'
import { DomainPreferencesTool } from './tools/DomainPreferencesTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'
import { BriefTool } from './tools/BriefTool/BriefTool.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
// All tools enabled - no conditional imports
// Use try-catch for tools that may not exist
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
let REPLTool = null
let SleepTool = null
let SendUserFileTool = null
try { REPLTool = require('./tools/REPLTool/REPLTool.js').REPLTool } catch (e) { console.error('[tools] Failed to load REPLTool:', e) }
try { SleepTool = require('./tools/SleepTool/SleepTool.js').SleepTool } catch (e) { console.error('[tools] Failed to load SleepTool:', e) }
const cronTools = [
  require('./tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
  require('./tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
  require('./tools/ScheduleCronTool/CronListTool.js').CronListTool,
]
const RemoteTriggerTool = require('./tools/RemoteTriggerTool/RemoteTriggerTool.js').RemoteTriggerTool
const MonitorTool = require('./tools/MonitorTool/MonitorTool.js').MonitorTool
try { SendUserFileTool = require('./tools/SendUserFileTool/SendUserFileTool.js').SendUserFileTool } catch (e) { console.error('[tools] Failed to load SendUserFileTool:', e) }
// Optional tools that may not exist
let SuggestBackgroundPRTool = null
let PushNotificationTool = null
let SubscribePRTool = null
try { SuggestBackgroundPRTool = require('./tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js').SuggestBackgroundPRTool } catch (e) { console.error('[tools] Failed to load SuggestBackgroundPRTool:', e) }
try { PushNotificationTool = require('./tools/PushNotificationTool/PushNotificationTool.js').PushNotificationTool } catch (e) { console.error('[tools] Failed to load PushNotificationTool:', e) }
try { SubscribePRTool = require('./tools/SubscribePRTool/SubscribePRTool.js').SubscribePRTool } catch (e) { console.error('[tools] Failed to load SubscribePRTool:', e) }
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { TaskOutputTool } from './tools/TaskOutputTool/TaskOutputTool.js'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js'
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool.js'
import { ExitPlanModeV2Tool } from './tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { TestingPermissionTool } from './tools/testing/TestingPermissionTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
import { TungstenTool } from './tools/TungstenTool/TungstenTool.js'
// Lazy require to break circular dependency: tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
const getTeamDeleteTool = () =>
  require('./tools/TeamDeleteTool/TeamDeleteTool.js')
    .TeamDeleteTool as typeof import('./tools/TeamDeleteTool/TeamDeleteTool.js').TeamDeleteTool
const getSendMessageTool = () =>
  require('./tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('./tools/SendMessageTool/SendMessageTool.js').SendMessageTool
/* eslint-enable @typescript-eslint/no-require-imports */
// Force initialization of lazy-loaded tools during module init phase (tools init = sL() in bundle).
// Bun bytecode's TDZ tracking requires require()-accessed modules to be resolved in the startup
// chain (sL()), not deferred to main(). Without this, async subagent contexts can trigger
// "Cannot access 'qq' before initialization" because the runtime doesn't see these modules as
// initialized despite them being loaded by getAllBaseTools() later in main().
getSendMessageTool();
getTeamCreateTool();
getTeamDeleteTool();
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { LSPTool } from './tools/LSPTool/LSPTool.js'
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { ToolSearchTool } from './tools/ToolSearchTool/ToolSearchTool.js'
import { EnterPlanModeTool } from './tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js'
import { ExitWorktreeTool } from './tools/ExitWorktreeTool/ExitWorktreeTool.js'
import { ConfigTool } from './tools/ConfigTool/ConfigTool.js'
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js'
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js'
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js'
import { UpdateGoalTool } from './tools/UpdateGoalTool/UpdateGoalTool.js'
import uniqBy from 'lodash-es/uniqBy.js'
// All tools enabled - no conditional imports
// Use try-catch for tools that may not exist
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const VerifyPlanExecutionTool = require('./tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js').VerifyPlanExecutionTool
const OverflowTestTool = require('./tools/OverflowTestTool/OverflowTestTool.js').OverflowTestTool
let WorkflowTool = null
try {
  require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows()
  WorkflowTool = require('./tools/WorkflowTool/WorkflowTool.js').WorkflowTool
} catch (e) { console.error('[tools] Failed to load WorkflowTool:', e) }
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import type { ToolPermissionContext } from './Tool.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import { REPL_ONLY_TOOLS } from './tools/REPLTool/constants.js'
export { REPL_ONLY_TOOLS }
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from './constants/tools.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const getPowerShellTool = () => {
  return (
    require('./tools/PowerShellTool/PowerShellTool.js') as typeof import('./tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
}
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Platform auto-detection: on Windows, use PowerShellTool; on all other
 * platforms, use BashTool. This prevents the model from seeing both tools
 * and eliminates platform mismatch issues.
 */
function getShellTool() {
  if (process.platform === 'win32') {
    return getPowerShellTool()
  }
  return BashTool
}

/**
 * Predefined tool presets that can be used with --tools flag
 */
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * Get the list of tool names for a given preset
 * All tools are enabled, returns all tool names
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  return tools.map(tool => tool.name)
}

/**
 * Get the complete exhaustive list of all tools
 * All feature flags and environment variable checks have been removed
 */
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    agentDetectorTool,
    singularityTool,
    codegraphTool,
    TaskOutputTool,
    getShellTool(),
    GlobTool,
    GrepTool,
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    ConfirmDomainAccessTool,
    DomainPreferencesTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    ConfigTool,
    TungstenTool,
    TaskCreateTool,
    TaskGetTool,
    TaskUpdateTool,
    TaskListTool,
    OverflowTestTool,
    LSPTool,
    EnterWorktreeTool,
    ExitWorktreeTool,
    getSendMessageTool(),
    getTeamCreateTool(),
    getTeamDeleteTool(),
    VerifyPlanExecutionTool,
    REPLTool,
    WorkflowTool,
    SleepTool,
    ...cronTools,
    RemoteTriggerTool,
    MonitorTool,
    BriefTool,
    SendUserFileTool,
    TestingPermissionTool,
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    ToolSearchTool,
    // Optional tools that may not exist
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    UpdateGoalTool,
  ].filter(Boolean)
}

/**
 * Filters out tools that are blanket-denied by the permission context.
 * A tool is filtered out if there's a deny rule matching its name with no
 * ruleContent (i.e., a blanket deny for that tool).
 *
 * Uses the same matcher as the runtime permission check (step 1a), so MCP
 * server-prefix rules like `mcp__server` strip all tools from that server
 * before the model sees them — not just at call time.
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter(tool => !getDenyRuleForTool(permissionContext, tool))
}

export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // Get all base tools and filter out special tools that get added conditionally
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter(tool => !specialTools.has(tool.name))

  // Filter out tools that are denied by the deny rules
  return filterToolsByDenyRules(tools, permissionContext)
}

/**
 * Assemble the full tool pool for a given permission context and MCP tools.
 *
 * This is the single source of truth for combining built-in tools with MCP tools.
 * Both REPL.tsx (via useMergedTools hook) and runAgent.ts (for coordinator workers)
 * use this function to ensure consistent tool pool assembly.
 *
 * The function:
 * 1. Gets built-in tools via getTools() (respects mode filtering)
 * 2. Filters MCP tools by deny rules
 * 3. Deduplicates by tool name (built-in tools take precedence)
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined, deduplicated array of built-in and MCP tools
 */
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)

  // Filter out MCP tools that are in the deny list
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // Sort each partition for prompt-cache stability, keeping built-ins as a
  // contiguous prefix. The server's claude_code_system_cache_policy places a
  // global cache breakpoint after the last prefix-matched built-in tool; a flat
  // sort would interleave MCP tools into built-ins and invalidate all downstream
  // cache keys whenever an MCP tool sorts between existing built-ins. uniqBy
  // preserves insertion order, so built-ins win on name conflict.
  // Avoid Array.toSorted (Node 20+) — we support Node 18. builtInTools is
  // readonly so copy-then-sort; allowedMcpTools is a fresh .filter() result.
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}

/**
 * Get all tools including both built-in tools and MCP tools.
 *
 * This is the preferred function when you need the complete tools list for:
 * - Tool search threshold calculations (isToolSearchEnabled)
 * - Token counting that includes MCP tools
 * - Any context where MCP tools should be considered
 *
 * Use getTools() only when you specifically need just built-in tools.
 *
 * @param permissionContext - Permission context for filtering built-in tools
 * @param mcpTools - MCP tools from appState.mcp.tools
 * @returns Combined array of built-in and MCP tools
 */
export function getMergedTools(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}

// Register assembleToolPool with AgentTool synchronously after all tool imports are complete.
// Previous setTimeout approach failed in Bun bytecode mode — the callback didn't fire
// before subagent spawn, causing "Cannot access 'qq' before initialization" TDZ errors.
// Synchronous registration is safe here because tools.ts is the leaf of the dependency chain:
// tools.ts → AgentTool.tsx (via import) → ... (no reverse import back to tools.ts)
registerAssembleToolPool(assembleToolPool)
