import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { checkCpuHotspot, logCpuDiag } from 'src/utils/eventLoopWatchdog.js'
import {
  getProjectRoot,
  getSessionId,
  getTotalCostUSD,
} from '../../bootstrap/state.js'
import { getCommand, getSkillToolCommands, hasCommand } from '../../commands.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
  getLanguageSection,
} from '../../constants/prompts.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { query } from '../../query.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { cleanupAgentTracking } from '../../services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import { runQualityScan, type ScanResult } from '../../services/codeQuality/regexScanner.js'
import { runASTCheck } from '../../services/codeQuality/astChecker.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { Command } from '../../types/command.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { AbortError } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from '../../utils/forkedAgent.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../../utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { getMaxToolCalls, resolveAgentTools } from './agentToolUtils.js'
import { type AgentClassification, getClassification } from './agentClassifications.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'
import { BUILT_IN_TEMPLATES, buildAgentPrompt } from './promptTemplate.js'
import { VALIDATION_GATE_ENABLED, parseVerificationVerdict, runTypeCheck, formatTypeCheckSummary, detectTestRunner, runTests, formatTestSummary } from './validationGate.js'

/**
 * Initialize agent-specific MCP servers
 * Agents can define their own MCP servers in their frontmatter that are additive
 * to the parent's MCP clients. These servers are connected when the agent starts
 * and cleaned up when the agent finishes.
 *
 * @param agentDefinition The agent definition with optional mcpServers
 * @param parentClients MCP clients inherited from parent context
 * @returns Merged clients (parent + agent-specific), agent MCP tools, and cleanup function
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  cleanup: () => Promise<void>
}> {
  // If no agent-specific servers defined, return parent clients as-is
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  // When MCP is locked to plugin-only, skip frontmatter MCP servers for
  // USER-CONTROLLED agents only. Plugin, built-in, and policySettings agents
  // are admin-trusted — their frontmatter MCP is part of the admin-approved
  // surface. Blocking them (as the first cut did) breaks plugin agents that
  // legitimately need MCP, contradicting "plugin-provided always loads."
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] Skipping MCP servers: strictPluginOnlyCustomization locks MCP to plugin-only (agent source: ${agentDefinition.source})`,
    )
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
  // Track which clients were newly created (inline definitions) vs. shared from parent
  // Only newly created clients should be cleaned up when the agent finishes
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

    if (typeof spec === 'string') {
      // Reference by name - look up in existing MCP configs
      // This uses the memoized connectToServer, so we may get a shared client
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] MCP server not found: ${spec}`,
          { level: 'warn' },
        )
        continue
      }
    } else {
      // Inline definition as { [name]: config }
      // These are agent-specific servers that should be cleaned up
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Invalid MCP server spec: expected exactly one key`,
          { level: 'warn' },
        )
        continue
      }
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true
    }

    // Connect to the server
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)
    }

    // Fetch tools if connected
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Connected to MCP server '${name}' with ${tools.length} tools`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Failed to connect to MCP server '${name}': ${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // Create cleanup function for agent-specific servers
  // Only clean up newly created clients (inline definitions), not shared/referenced ones
  // Shared clients (referenced by string name) are memoized and used by the parent context
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Error cleaning up MCP server '${client.name}': ${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // Return merged clients (parent + agent-specific) and agent tools
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * Type guard to check if a message from query() is a recordable Message type.
 * Matches the types we want to record: assistant, user, progress, or system compact_boundary.
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  maxToolCalls,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  description,
  transcriptSubdir,
  onQueryProgress,
  onInitProgress,
  maxBudgetUsd,
  maxTokens,
  timeoutSeconds,
  quotaManager,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /** Whether this agent can show permission prompts. Defaults to !isAsync.
   * Set to true for in-process teammates that run async but share the terminal. */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  /** Maximum tool calls allowed for this agent execution.
   * Processed through getMaxToolCalls() which applies env var override and default. */
  maxToolCalls?: number
  /** Preserve toolUseResult on messages for subagents with viewable transcripts */
  preserveToolUseResults?: boolean
  /** Precomputed tool pool for the worker agent. Computed by the caller
   * (AgentTool.tsx) to avoid a circular dependency between runAgent and tools.ts.
   * Always contains the full tool pool assembled with the worker's own permission
   * mode, independent of the parent's tool restrictions. */
  availableTools: Tools
  /** Tool permission rules to add to the agent's session allow rules.
   * When provided, replaces ALL allow rules so the agent only has what's
   * explicitly listed (parent approvals don't leak through). */
  allowedTools?: string[]
  /** Optional callback invoked with CacheSafeParams after constructing the agent's
   * system prompt, context, and tools. Used by background summarization to fork
   * the agent's conversation for periodic progress summaries. */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /** Replacement state reconstructed from a resumed sidechain transcript so
   * the same tool results are re-replaced (prompt cache stability). When
   * omitted, createSubagentContext clones the parent's state. */
  contentReplacementState?: ContentReplacementState
  /** When true, use availableTools directly without filtering through
   * resolveAgentTools(). Also inherits the parent's thinkingConfig and
   * isNonInteractiveSession instead of overriding them. Used by the fork
   * subagent path to produce byte-identical API request prefixes for
   * prompt cache hits. */
  useExactTools?: boolean
  /** Worktree path if the agent was spawned with isolation: "worktree".
   * Persisted to metadata so resume can restore the correct cwd. */
  worktreePath?: string
  /** Original task description from AgentTool input. Persisted to metadata
   * so a resumed agent's notification can show the original description. */
  description?: string
  /** Optional subdirectory under subagents/ to group this agent's transcript
   * with related ones (e.g. workflows/<runId> for workflow subagents). */
  transcriptSubdir?: string
  /** Optional callback fired on every message yielded by query() — including
   * stream_event deltas that runAgent otherwise drops. Use to detect liveness
   * during long single-block streams (e.g. thinking) where no assistant
   * message is yielded for >60s. */
  onQueryProgress?: () => void
  /** Optional callback fired during initialization steps to report progress
   * before the first query() message is yielded. Prevents "Initializing…"
   * from being shown indefinitely by providing intermediate status updates. */
  onInitProgress?: (step: string) => void
  /** Maximum USD cost this agent may incur (0 or omitted = unlimited) */
  maxBudgetUsd?: number
  /** Maximum output tokens this agent may produce (0 or omitted = unlimited) */
  maxTokens?: number
  /** Maximum wall-clock time in seconds (0 or omitted = unlimited) */
  timeoutSeconds?: number
  /** Optional session-level quota manager for cross-agent budget tracking.
   * When provided, quota checks go through the manager's checkQuota() which
   * supports both per-agent and global session budgets. Falls back to raw
   * parameter checks if omitted. */
  quotaManager?: import('../../utils/quota/ResourceQuotaManager.js').ResourceQuotaManager
}): AsyncGenerator<Message, void> {
  // Track subagent usage for feature discovery
  const _initStart = Date.now()
  // _initLog: only active when OLA_CC_CPU_DEBUG=1 to avoid console.error
  // log storm during agent execution (every stream_event would otherwise
  // trigger a synchronous stderr write via console.error).
  const _cpuDebug = process.env.OLA_CC_CPU_DEBUG === '1'
  // Use logCpuDiag to write to file (OLA_CC_CPU_LOG_FILE) or stderr
  // instead of console.error which can break TUI rendering
  const _initLog = _cpuDebug
    ? (step: string) => logCpuDiag(`[AGENT_INIT:${agentDefinition.agentType}] ${step} +${Date.now() - _initStart}ms`)
    : (_step: string) => {}
  _initLog('begin')

  const appState = toolUseContext.getAppState()
  _initLog('getAppState done')
  const permissionMode = appState.toolPermissionContext.mode
  // Always-shared channel to the root AppState store. toolUseContext.setAppState
  // is a no-op when the *parent* is itself an async agent (nested async→async),
  // so session-scoped writes (hooks, bash tasks) must go through this instead.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
  )

  const agentId = override?.agentId ? override.agentId : createAgentId()

  // Route this agent's transcript into a grouping subdirectory if requested
  // (e.g. workflow subagents write to subagents/workflows/<runId>/).
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
  }

  // Register agent in Perfetto trace for hierarchy visualization
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
  }

  // Log API calls path for subagents (ant-only)
  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[Subagent ${agentDefinition.agentType}] API calls: ${getDisplayPath(getDumpPromptsPath(agentId))}`,
    )
  }

  // Handle message forking for context sharing
  // Filter out incomplete tool calls from parent messages to avoid API errors
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]

  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  _initLog('before getUserContext/getSystemContext')
  onInitProgress?.('Preparing context…')
  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])
  _initLog('after getUserContext/getSystemContext')

  // Read-only agents (Explore, Plan) don't act on commit/PR/lint rules from
  // CLAUDE.md — the main agent has full context and interprets their output.
  // Dropping claudeMd here saves ~5-15 Gtok/week across 34M+ Explore spawns.
  // Explicit override.userContext from callers is preserved untouched.
  // Kill-switch defaults true; flip tengu_slim_subagent_claudemd=false to revert.
  const shouldOmitClaudeMd =
    agentDefinition.omitClaudeMd &&
    !override?.userContext &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
  const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitClaudeMd
    ? userContextNoClaudeMd
    : baseUserContext

  // Classification lookup — declared early so shouldOmitGitStatus can reference it.
  // The actual tool filtering happens later (after resolvedTools is computed).
  const classification = getClassification(agentDefinition.agentType)
  let classificationRef: AgentClassification | undefined
  if (classification) {
    classificationRef = classification
  }

  // Explore/Plan are read-only search agents — the parent-session-start
  // gitStatus (up to 40KB, explicitly labeled stale) is dead weight. If they
  // need git info they run `git status` themselves and get fresh data.
  // Saves ~1-3 Gtok/week fleet-wide.
  // Also omit for agents classified as research/planning/review.
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  const shouldOmitGitStatus =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan' ||
    (classificationRef && classificationRef.omitSystemSections?.includes('git-status'))
  const resolvedSystemContext = shouldOmitGitStatus
    ? systemContextNoGit
    : baseSystemContext

  // Override permission mode if agent defines one
  // However, don't override if parent is in bypassPermissions or acceptEdits mode - those should always take precedence
  // For async agents, also set shouldAvoidPermissionPrompts since they can't show UI
  const agentPermissionMode = agentDefinition.permissionMode
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // Override permission mode if agent defines one (unless parent is bypassPermissions, acceptEdits, or auto)
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        feature('TRANSCRIPT_CLASSIFIER') &&
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // Set flag to auto-deny prompts for agents that can't show UI
    // Use explicit canShowPermissionPrompts if provided, otherwise:
    //   - bubble mode: always show prompts (bubbles to parent terminal)
    //   - default: !isAsync (sync agents show prompts, async agents don't)
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // For background agents that can show prompts, await automated checks
    // (classifier, permission hooks) before showing the permission dialog.
    // Since these are background agents, waiting is fine — the user should
    // only be interrupted when automated checks can't resolve the permission.
    // This applies to bubble mode (always) and explicit canShowPermissionPrompts.
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // Scope tool permissions: when allowedTools is provided, use them as session rules.
    // IMPORTANT: Preserve cliArg rules (from SDK's --allowedTools) since those are
    // explicit permissions from the SDK consumer that should apply to all agents.
    // Only clear session-level rules from the parent to prevent unintended leakage.
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // Preserve SDK-level permissions from --allowedTools
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // Use the provided allowedTools as session-level permissions
          session: [...allowedTools],
        },
      }
    }

    // Override effort level if agent defines one
    const effortValue =
      agentDefinition.effort !== undefined
        ? agentDefinition.effort
        : state.effortValue

    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue
    ) {
      return state
    }
    return {
      ...state,
      toolPermissionContext,
      effortValue,
    }
  }

  let resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

  // Apply classification-based tool filtering (context pruning)
  if (classification && !useExactTools) {
    const allowSet = new Set(classification.allowedTools)
    const denySet = new Set(classification.deniedTools ?? [])
    const filteredTools = resolvedTools.filter(t => {
      const name = t.name.toLowerCase()
      // Deny set takes precedence
      if (denySet.has(name)) return false
      // If allowedTools is non-empty, only allow tools in the set
      if (allowSet.size > 0 && !allowSet.has(name)) return false
      return true
    })
    if (filteredTools.length !== resolvedTools.length) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Tool pruning via classification: ${resolvedTools.length} → ${filteredTools.length} tools`,
      )
    }
    resolvedTools = filteredTools
  }

  const additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

  _initLog('before getAgentSystemPrompt')
  const agentSystemPrompt = override?.systemPrompt
    ? override.systemPrompt
    : asSystemPrompt(
        await getAgentSystemPrompt(
          agentDefinition,
          toolUseContext,
          resolvedAgentModel,
          additionalWorkingDirectories,
          resolvedTools,
        ),
      )
  _initLog('after getAgentSystemPrompt')

  // Determine abortController:
  // - Override takes precedence
  // - Async agents get a new unlinked controller (runs independently)
  // - Sync agents share parent's controller
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

  // Execute SubagentStart hooks and collect additional context
  _initLog('before executeSubagentStartHooks')
  onInitProgress?.('Running hooks…')
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }
  _initLog('after executeSubagentStartHooks')

  // Add SubagentStart hook context as a user message (consistent with SessionStart/UserPromptSubmit)
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SubagentStart',
      toolUseID: randomUUID(),
      hookEvent: 'SubagentStart',
    })
    initialMessages.push(contextMessage)
  }

  // Register agent's frontmatter hooks (scoped to agent lifecycle)
  // Pass isAgent=true to convert Stop hooks to SubagentStop (since subagents trigger SubagentStop)
  // Same admin-trusted gate for frontmatter hooks: under ["hooks"] alone
  // (skills/agents not locked), user agents still load — block their
  // frontmatter-hook REGISTRATION here where source is known, rather than
  // blanket-blocking all session hooks at execution time (which would
  // also kill plugin agents' hooks).
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent - converts Stop to SubagentStop
    )
  }

  // Preload skills from agent frontmatter
  _initLog('before skill preloading')
  onInitProgress?.('Loading skills…')
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // Filter valid skills and warn about missing ones
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // Resolve the skill name, trying multiple strategies:
      // 1. Exact match (hasCommand checks name, userFacingName, aliases)
      // 2. Fully-qualified with agent's plugin prefix (e.g., "my-skill" → "plugin:my-skill")
      // 3. Suffix match on ":skillName" for plugin-namespaced skills
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' specified in frontmatter was not found`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' is not a prompt-based skill`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // Load all skill contents concurrently and add to initial messages
    const { formatSkillLoadingMetadata } = await import(
      '../../utils/processUserInput/processSlashCommand.js'
    )
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Preloaded skill '${skillName}'`,
      )

      // Add command-message metadata so the UI shows which skill is loading
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

  // Initialize agent-specific MCP servers (additive to parent's servers)
  _initLog('before initializeAgentMcpServers')
  onInitProgress?.('Connecting to MCP servers…')
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    toolUseContext.options.mcpClients,
  )
  _initLog('after initializeAgentMcpServers')

  // Merge agent MCP tools with resolved agent tools, deduplicating by name.
  // resolvedTools is already deduplicated (see resolveAgentTools), so skip
  // the spread + uniqBy overhead when there are no agent-specific MCP tools.
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools

  // Build agent-specific options
  const agentOptions: ToolUseContext['options'] = {
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    tools: allTools,
    commands: [],
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: resolvedAgentModel,
    // For fork children (useExactTools), inherit thinking config to match the
    // parent's API request prefix for prompt cache hits. For regular
    // sub-agents, disable thinking to control output token costs.
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: toolUseContext.options.mcpResources,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // Fork children (useExactTools path) need querySource on context.options
    // for the recursive-fork guard at AgentTool.tsx call() — it checks
    // options.querySource === 'agent:builtin:fork'. This survives autocompact
    // (which rewrites messages, not context.options). Without this, the guard
    // reads undefined and only the message-scan fallback fires — which
    // autocompact defeats by replacing the fork-boilerplate message.
    ...(useExactTools && { querySource }),
  }

  // Create subagent context using shared helper
  // - Sync agents share setAppState, setResponseLength, abortController with parent
  // - Async agents are fully isolated (but with explicit unlinked abortController)
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    // Sync agents share these callbacks with parent
    shareSetAppState: !isAsync,
    shareSetResponseLength: true, // Both sync and async contribute to response metrics
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // Preserve tool use results for subagents with viewable transcripts (in-process teammates)
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // Expose cache-safe params for background summarization (prompt cache sharing)
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // Record initial messages before the query loop starts, plus the agentType
  // so resume can route correctly when subagent_type is omitted. Both writes
  // are fire-and-forget — persistence failure shouldn't block the agent.
  void recordSidechainTranscript(initialMessages, agentId).catch(_err =>
    logForDebugging(`Failed to record sidechain transcript: ${_err}`),
  )
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(worktreePath && { worktreePath }),
    ...(description && { description }),
  }).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))

  // Track the last recorded message UUID for parent chain continuity
  let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

  // Resource quota: set up timeout circuit breaker if specified
  const agentStartTime = Date.now()
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  if (timeoutSeconds && timeoutSeconds > 0) {
    timeoutTimer = setTimeout(() => {
      logForDebugging(
        `[Agent ${agentDefinition.agentType}] Timeout after ${timeoutSeconds}s, aborting`,
      )
      agentAbortController.abort()
    }, timeoutSeconds * 1000)
  }

  // Capture baseline cost for per-agent budget tracking
  const agentBaselineCost = getTotalCostUSD()
  let agentBudgetExceeded = false

  // Track per-agent output tokens (taskBudget in query() is for API auto-compact,
  // NOT a hard limit — we need our own counter for enforcement)
  let agentOutputTokens = 0

  // Track the last assistant message text for validation gate
  let lastAssistantMessageText = ''

  _initLog('before query() call')
  try {
    for await (const message of query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns ?? 50,
      maxToolCalls: getMaxToolCalls(maxToolCalls),
    })) {
      checkCpuHotspot('runAgent_message_yield')
      _initLog(`first query() message: type=${message.type}`)
      onQueryProgress?.()

      // Accumulate output tokens from stream events
      if (
        message.type === 'stream_event' &&
        message.event.type === 'message_delta' &&
        message.event.delta?.usage?.output_tokens
      ) {
        agentOutputTokens += message.event.delta.usage.output_tokens
      }

      // Resource quota check via manager (if provided) or raw parameters (fallback)
      if (quotaManager) {
        const elapsed = Date.now() - agentStartTime
        const currentCost = getTotalCostUSD()
        const check = quotaManager.checkQuota(agentId, {
          costUsd: currentCost - agentBaselineCost,
          outputTokens: agentOutputTokens,
          elapsedMs: elapsed,
        })
        if (!check.allowed) {
          logForDebugging(
            `[Agent ${agentDefinition.agentType}] Quota exceeded: ${check.reason}`,
          )
          agentBudgetExceeded = true
          agentAbortController.abort()
          break
        }
      } else {
        // Fallback: raw parameter checks (no session-level global budget)
        if (maxBudgetUsd && maxBudgetUsd > 0) {
          const currentCost = getTotalCostUSD()
          const agentCostDelta = currentCost - agentBaselineCost
          if (agentCostDelta >= maxBudgetUsd) {
            logForDebugging(
              `[Agent ${agentDefinition.agentType}] Quota exceeded: budget ($${agentCostDelta.toFixed(4)} >= $${maxBudgetUsd})`,
            )
            agentBudgetExceeded = true
            agentAbortController.abort()
            break
          }
        }

        // Hard output token limit (not taskBudget which only triggers compaction)
        if (maxTokens && maxTokens > 0 && agentOutputTokens >= maxTokens) {
          logForDebugging(
            `[Agent ${agentDefinition.agentType}] Quota exceeded: tokens (${agentOutputTokens} >= ${maxTokens})`,
          )
          agentBudgetExceeded = true
          agentAbortController.abort()
          break
        }
      }

      // Check timeout circuit breaker
      if (timeoutSeconds && timeoutSeconds > 0) {
        const elapsed = Date.now() - agentStartTime
        if (elapsed >= timeoutSeconds * 1000) {
          logForDebugging(
            `[Agent ${agentDefinition.agentType}] Quota exceeded: timeout (${(elapsed / 1000).toFixed(0)}s >= ${timeoutSeconds}s)`,
          )
          break
        }
      }

      // Forward subagent API request starts to parent's metrics display
      // so TTFT/OTPS update during subagent execution.
      if (
        message.type === 'stream_event' &&
        message.event.type === 'message_start' &&
        message.ttftMs != null
      ) {
        toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
        continue
      }

      // Yield attachment messages (e.g., structured_output) without recording them
      if (message.type === 'attachment') {
        // Handle max turns reached signal from query.ts
        if (message.attachment.type === 'max_turns_reached') {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Reached max turns limit (${message.attachment.maxTurns})`,
          )
          break
        }
        // Handle max tool calls reached signal from query.ts
        if (message.attachment.type === 'max_tool_calls_reached') {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Reached max tool calls limit (${message.attachment.maxToolCalls})`,
          )
          agentBudgetExceeded = true
          // Yield the attachment so it's recorded in agentMessages.
          // finalizeAgentTool uses this to set terminationReason = 'budget_exhausted'.
          yield message
          break
        }
        yield message
        continue
      }

      if (isRecordableMessage(message)) {
        // Record only the new message with correct parent (O(1) per message)
        await recordSidechainTranscript(
          [message],
          agentId,
          lastRecordedUuid,
        ).catch(err =>
          logForDebugging(`Failed to record sidechain transcript: ${err}`),
        )
        if (message.type !== 'progress') {
          lastRecordedUuid = message.uuid
        }
        // Track last assistant message text for validation gate
        if (message.type === 'assistant' && message.message?.content) {
          const content = message.message.content
          if (typeof content === 'string') {
            lastAssistantMessageText = content
          } else if (Array.isArray(content)) {
            const textBlocks = content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text: string }) => b.text)
              .join('\n')
            if (textBlocks) lastAssistantMessageText = textBlocks
          }
        }
        yield message
      }
    }

    if (agentBudgetExceeded) {
      logForDebugging(
        `[Agent ${agentDefinition.agentType}] Terminated: exceeded resource quota`,
      )
      // Don't throw AbortError — budget exceeded is a normal termination,
      // not a user cancellation. The agent's transcript is already recorded.
    } else if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // Run callback if provided (only built-in agents have callbacks)
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }

    // --- Validation Gate ---
    // After the agent completes, optionally check if the output looks like
    // it successfully completed. Only for implementation/general agents.
    //
    // Order: Verdict → TypeCheck → RegexScan
    // TypeCheck is WARNING-level (reports but doesn't block).
    if (
      VALIDATION_GATE_ENABLED &&
      !agentBudgetExceeded &&
      !agentAbortController.signal.aborted &&
      lastAssistantMessageText
    ) {
      const classification = getClassification(agentDefinition.agentType)
      const agentClass = classification?.class
      const shouldValidate =
        agentClass === 'implementation' ||
        agentClass === 'general' ||
        !classification // unclassified agents are treated as general

      if (shouldValidate) {
        const verdict = parseVerificationVerdict(lastAssistantMessageText)

        if (verdict === 'FAIL' || verdict === 'PARTIAL') {
          // Agent self-reported failure — yield a summary so the caller
          // can spawn the verification agent with this context.
          yield {
            type: 'tool_use_summary',
            uuid: randomUUID(),
            timestamp: Date.now(),
          } as ToolUseSummaryMessage

          logForDebugging(
            `[Agent ${agentDefinition.agentType}] Validation gate: verdict=${verdict} — verification agent recommended`,
          )
        } else {
          logForDebugging(
            `[Agent ${agentDefinition.agentType}] Validation gate: no explicit verdict found (PASS assumed)`,
          )
        }

        // --- Type Check (WARNING-level, doesn't block) ---
        // Run after verdict check, before quality scan.
        // Catches type errors that compilation doesn't catch.
        try {
          const projectRoot = getProjectRoot() || process.cwd()
          const typeCheckResult = await runTypeCheck(projectRoot)

          if (!typeCheckResult.passed) {
            const summary = formatTypeCheckSummary(typeCheckResult)
            logForDebugging(
              `[Agent ${agentDefinition.agentType}] Type check: ${typeCheckResult.errors.length} error(s) found`,
            )
            yield {
              type: 'tool_use_summary',
              uuid: randomUUID(),
              timestamp: Date.now(),
              summary,
            } as ToolUseSummaryMessage
          } else if (typeCheckResult.command) {
            logForDebugging(
              `[Agent ${agentDefinition.agentType}] Type check passed (${typeCheckResult.command})`,
            )
          }
        } catch (typeCheckError) {
          logForDebugging(
            `[Agent ${agentDefinition.agentType}] Type check failed: ${typeCheckError}`,
          )
        }

        // --- Test Execution (WARNING-level, doesn't block) ---
        // Detects and runs the project's test suite after type check.
        // Test failures are logged but don't block the agent.
        try {
          const projectRoot = getProjectRoot() || process.cwd()
          const testRunner = await detectTestRunner(projectRoot)

          if (testRunner) {
            logForDebugging(
              `[Agent ${agentDefinition.agentType}] Running tests: ${testRunner.command} (detected by ${testRunner.detectedBy})`,
            )
            const testResult = await runTests(projectRoot, testRunner.command)

            if (!testResult.passed) {
              const summary = formatTestSummary(
                testResult.passed,
                testResult.output,
                testRunner.command,
              )
              logForDebugging(
                `[Agent ${agentDefinition.agentType}] Tests failed: ${testRunner.command}`,
              )
              yield {
                type: 'tool_use_summary',
                uuid: randomUUID(),
                timestamp: Date.now(),
                summary,
              } as ToolUseSummaryMessage
            } else {
              logForDebugging(
                `[Agent ${agentDefinition.agentType}] Tests passed (${testRunner.command})`,
              )
            }
          }
        } catch (testError) {
          logForDebugging(
            `[Agent ${agentDefinition.agentType}] Test execution failed: ${testError}`,
          )
        }
      }
    }

    // --- Post-Completion Quality Scan ---
    // After implementation/general agents complete, automatically scan for
    // common code quality issues. Only runs when the agent finished normally
    // (not aborted or budget-exceeded).
    if (
      !agentBudgetExceeded &&
      !agentAbortController.signal.aborted &&
      process.env.OLA_CC_AST_CHECK !== '0'
    ) {
      const agentClass = classificationRef?.class
      const shouldScan =
        agentClass === 'implementation' ||
        agentClass === 'general' ||
        !classificationRef

      if (shouldScan) {
        try {
          const SCAN_TIMEOUT_MS = 15000
          const scanResults = await Promise.race([
            runQualityScan({
              checks: [],
              paths: [getProjectRoot() ? `src/**/*.{ts,tsx}` : 'src/**/*.{ts,tsx}'],
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Quality scan timeout')), SCAN_TIMEOUT_MS)
            ),
          ]).catch((err) => {
            logForDebugging(`[Agent] Quality scan ${err.message ?? 'timed out'}`)
            return [] as ScanResult[]
          })

          const errorLevelIssues = scanResults.filter(
            (r: ScanResult) => r.severity === 'error',
          )

          if (errorLevelIssues.length > 0) {
            logForDebugging(
              `[Agent ${agentDefinition.agentType}] Quality scan: ${errorLevelIssues.length} error-level issue(s) found`,
            )

            const summary = formatQualityScanSummary(errorLevelIssues)
            yield {
              type: 'tool_use_summary',
              uuid: randomUUID(),
              timestamp: Date.now(),
              summary,
            } as ToolUseSummaryMessage
          } else {
            logForDebugging(
              `[Agent ${agentDefinition.agentType}] Quality scan: no error-level issues found`,
            )
          }
        } catch (scanError) {
          logForDebugging(
            `[Agent ${agentDefinition.agentType}] Quality scan failed: ${scanError}`,
          )
        }

        // --- AST-Level Quality Check ---
        // Run AST-based checks for deeper code quality issues that regex can't catch.
        // Only error-level issues are reported.
        try {
          const projectRoot = getProjectRoot() || process.cwd()
          const AST_TIMEOUT_MS = 15000
          const astResults = await Promise.race([
            runASTCheck([`${projectRoot}/src/**/*.ts`, `${projectRoot}/src/**/*.tsx`]),
            new Promise<ScanResult[]>((resolve) =>
              setTimeout(() => {
                logForDebugging(`[Agent] AST check timed out after ${AST_TIMEOUT_MS}ms`)
                resolve([])
              }, AST_TIMEOUT_MS)
            ),
          ])

          const errorLevelAST = astResults.filter((r: ScanResult) => r.severity === 'error')
          if (errorLevelAST.length > 0) {
            logForDebugging(
              `[Agent ${agentDefinition.agentType}] AST check: ${errorLevelAST.length} error-level issue(s) found`,
              { level: 'warn' },
            )

            const astSummary = `AST-level issues found:\n${errorLevelAST.slice(0, 5).map(r => `  ${r.file}:${r.line} [${r.check}] ${r.message}`).join('\n')}`
            yield {
              type: 'tool_use_summary',
              uuid: randomUUID(),
              timestamp: Date.now(),
              summary: astSummary,
            } as ToolUseSummaryMessage
          }
        } catch (astError) {
          logForDebugging(
            `[Agent ${agentDefinition.agentType}] AST check failed: ${astError}`,
          )
        }
      }
    }
  } finally {
    // Clean up timeout timer if still running
    if (timeoutTimer) {
      clearTimeout(timeoutTimer)
    }
    // Clean up agent-specific MCP servers (runs on normal completion, abort, or error)
    await mcpCleanup()
    // Clean up agent's session hooks
    if (agentDefinition.hooks) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    // Clean up prompt cache tracking state for this agent
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      cleanupAgentTracking(agentId)
    }
    // Release cloned file state cache memory
    agentToolUseContext.readFileState.clear()
    // Release the cloned fork context messages
    initialMessages.length = 0
    // Release perfetto agent registry entry
    unregisterPerfettoAgent(agentId)
    // Release transcript subdir mapping
    clearAgentTranscriptSubdir(agentId)
    // Release this agent's todos entry. Without this, every subagent that
    // called TodoWrite leaves a key in AppState.todos forever (even after all
    // items complete, the value is [] but the key stays). Whale sessions
    // spawn hundreds of agents; each orphaned key is a small leak that adds up.
    rootSetAppState(prev => {
      if (!(agentId in prev.todos)) return prev
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // Kill any background bash tasks this agent spawned. Without this, a
    // `run_in_background` shell loop (e.g. test fixture fake-logs.sh) outlives
    // the agent as a PPID=1 zombie once the main session eventually exits.
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    /* eslint-disable @typescript-eslint/no-require-imports */
    if (feature('MONITOR_TOOL')) {
      const mcpMod =
        require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js')
      mcpMod.killMonitorMcpTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
}

/**
 * Filters out assistant messages with incomplete tool calls (tool uses without results).
 * This prevents API errors when sending messages with orphaned tool calls.
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // Build a set of tool use IDs that have results
  const toolUseIdsWithResults = new Set<string>()

  for (const message of messages) {
    if (message?.type === 'user') {
      const userMessage = message as UserMessage
      const content = userMessage.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolUseIdsWithResults.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // Filter out assistant messages that contain tool calls without results
  return messages.filter(message => {
    if (message?.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        // Check if this assistant message has any tool uses without results
        const hasIncompleteToolCall = content.some(
          block =>
            block.type === 'tool_use' &&
            block.id &&
            !toolUseIdsWithResults.has(block.id),
        )
        // Exclude messages with incomplete tool calls
        return !hasIncompleteToolCall
      }
    }
    // Keep all non-assistant messages and assistant messages without tool calls
    return true
  })
}

async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]> {
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  const settings = getInitialSettings()

  // Determine the base agent prompt
  let agentPrompt: string

  // 1. Check if a built-in template applies (research, review, etc.)
  const template = BUILT_IN_TEMPLATES[agentDefinition.agentType]
  if (template) {
    agentPrompt = buildAgentPrompt(template, {
      agentType: agentDefinition.agentType,
      cwd: getProjectRoot(),
    })
  } else {
    // 2. Fall back to the agent's own getSystemPrompt
    try {
      agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    } catch (_error) {
      agentPrompt = DEFAULT_AGENT_PROMPT
    }
  }

  const prompts = [agentPrompt, getLanguageSection(settings.language)]

  return await enhanceSystemPromptWithEnvDetails(
    prompts,
    resolvedAgentModel,
    additionalWorkingDirectories,
    enabledToolNames,
  )
}

/**
 * Resolve a skill name from agent frontmatter to a registered command name.
 *
 * Plugin skills are registered with namespaced names (e.g., "my-plugin:my-skill")
 * but agents reference them with bare names (e.g., "my-skill"). This function
 * tries multiple resolution strategies:
 *
 * 1. Exact match via hasCommand (name, userFacingName, aliases)
 * 2. Prefix with agent's plugin name (e.g., "my-skill" → "my-plugin:my-skill")
 * 3. Suffix match — find any command whose name ends with ":skillName"
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 1. Direct match
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 2. Try prefixing with the agent's plugin name
  // Plugin agents have agentType like "pluginName:agentName"
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 3. Suffix match — find a skill whose name ends with ":skillName"
  const suffix = `:${skillName}`
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  return null
}

/**
 * Format quality scan results into a human-readable summary for tool_use_summary.
 * Groups issues by file and limits output to avoid overwhelming the caller.
 */
function formatQualityScanSummary(results: ScanResult[]): string {
  const relPath = (fullPath: string) => {
    const root = getProjectRoot() || process.cwd()
    return fullPath.replace(root + '/', '')
  }

  const lines: string[] = [
    `Quality scan found ${results.length} error-level issue(s):`,
    '',
  ]

  // Group by file
  const byFile = new Map<string, ScanResult[]>()
  for (const r of results) {
    const key = relPath(r.file)
    const existing = byFile.get(key) ?? []
    existing.push(r)
    byFile.set(key, existing)
  }

  for (const [file, issues] of byFile) {
    lines.push(`  ${file}:`)
    for (const issue of issues) {
      lines.push(
        `    Line ${issue.line}: [${issue.check}] ${issue.message}${issue.fix ? ` — ${issue.fix}` : ''}`,
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

