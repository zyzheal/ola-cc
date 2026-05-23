/**
 * Worker 中的模拟 ToolUseContext
 * 用于在 Worker 进程内执行压缩时提供必要的上下文
 */
import type { ToolUseContext } from '../../../Tool.js'
import type { AppState } from '../../../state/AppStateStore.js'
import type { FileStateCache } from '../../../utils/fileStateCache.js'
import type { CompactContextSnapshot, CompactProgressEvent } from './types.js'

/**
 * 在 Worker 中创建简化的 ToolUseContext
 * Worker 内的 context 功能受限，主要用于:
 * 1. 调用 compactConversation 需要的 API 调用
 * 2. 基本的进度回调
 */
export function createMockContext(
  snapshot: CompactContextSnapshot,
  onProgress: (event: CompactProgressEvent) => void,
): ToolUseContext {
  // 创建最小化的 AppState（仅包含 compact 需要的部分）
  const mockAppState = createMinimalAppState()

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: snapshot.options.mainLoopModel,
      tools: snapshot.options.tools as any,
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: snapshot.options.isNonInteractiveSession ?? true,
      agentDefinitions: snapshot.options.agentDefinitions as any,
      customSystemPrompt: snapshot.options.customSystemPrompt,
      appendSystemPrompt: snapshot.options.appendSystemPrompt,
      querySource: snapshot.options.querySource as any,
    },
    // Worker 中使用模拟的 AbortController
    abortController: new AbortController(),
    // Worker 中使用空的文件状态缓存
    readFileState: createEmptyFileStateCache(),
    getAppState: () => mockAppState,
    setAppState: () => {}, // Worker 中忽略状态更新
    setAppStateForTasks: () => {},
    // 进度回调通过 IPC 传回主进程
    onCompactProgress: onProgress,
    // 其他回调在 Worker 中忽略或使用空实现
    appendSystemMessage: () => {},
    setStreamMode: () => {},
    setResponseLength: () => {},
    setSDKStatus: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    setInProgressToolUseIDs: () => {},
    setHasInterruptibleToolInProgress: () => {},
    pushApiMetricsEntry: undefined,
    sendOSNotification: () => {},
    nestedMemoryAttachmentTriggers: new Set(),
    loadedNestedMemoryPaths: new Set(),
    dynamicSkillDirTriggers: new Set(),
    discoveredSkillNames: new Set(),
    // 标识这是 Worker 上下文
    isWorkerContext: true,
    agentId: snapshot.agentId,
    agentType: snapshot.agentType,
    messages: [],
  }
}

/**
 * 创建最小化的 AppState
 * 仅包含 compactConversation 可能访问的字段
 */
function createMinimalAppState(): AppState {
  return {
    // 基本状态
    todos: {},
    goal: null,
    goalRuntime: null,
    fileHistory: {
      trackedFiles: new Set(),
      editedFiles: new Set(),
    },
    attribution: {
      attributionQueries: new Map(),
    },
    // 权限上下文
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: false,
    },
    // MCP 配置
    mcp: {
      servers: {},
      clients: [],
      resources: {},
      tools: [],
    },
    // 其他必要字段
    verbose: false,
    sessionId: '',
    conversationId: undefined,
    // 使用默认值
  } as unknown as AppState
}

/**
 * 创建空的文件状态缓存
 */
function createEmptyFileStateCache(): FileStateCache {
  const cache = new Map<string, unknown>()

  return {
    get: (key: string) => cache.get(key),
    set: (key: string, value: unknown) => cache.set(key, value),
    has: (key: string) => cache.has(key),
    delete: (key: string) => cache.delete(key),
    clear: () => cache.clear(),
    size: cache.size,
    keys: () => Array.from(cache.keys()),
    values: () => Array.from(cache.values()),
    entries: () => Array.from(cache.entries()),
    forEach: (callback: (value: unknown, key: string, map: Map<string, unknown>) => void) =>
      cache.forEach((value, key) => callback(value, key, cache)),
  }
}

/**
 * 检查是否为 Worker 上下文
 */
export function isWorkerContext(context: ToolUseContext): boolean {
  return (context as any).isWorkerContext === true
}