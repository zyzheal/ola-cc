// src/tools/GrokTool/GrokAnalyzer.ts
// File discovery + LLM batch analysis + two-phase optimization

import { existsSync, mkdirSync, realpathSync } from 'fs'
import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { extname, join, resolve } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { logForDebugging } from '../../utils/debug.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { GrokError, type GraphData } from './GrokTypes.js'
import { computeFileFingerprint } from './GrokAssembler.js'
import type { GraphStore, NodeMetadata } from '../../services/graph/GraphStore.js'

// ============================================================
// Prompt sanitization
// ============================================================

function sanitizeForPrompt(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 500)
}

// ============================================================
// Constants + Agent system prompts
// ============================================================

const GROK_VENDOR_DIR = join(homedir(), '.ola-cc', 'vendor', 'grok')

export const AGENT_SYSTEM_PROMPTS = {
  scanner: `You are a project scanner. Your job is to:
1. Discover all source files in the project
2. Detect programming languages and frameworks
3. Identify project structure and entry points

CRITICAL: You MUST respond with valid JSON only. Do NOT return natural language.

Output JSON: { files: string[], languages: string[], frameworks: string[], entryPoints: string[] }`,

  analyzer: `You are a code analyzer. You receive AST metadata (nodes and edges) extracted by tree-sitter.
Your job is to:
1. Analyze the provided symbols and relationships
2. Infer semantic meaning and architectural roles
3. Generate concise summaries

CRITICAL: You MUST respond with valid JSON only. Do NOT return natural language.

Output JSON: { symbols: Symbol[], relationships: Relationship[] }

Symbol: { name, kind, file, line, signature, summary }
Relationship: { from, to, type }`,

  architecture: `You are an architecture analyzer. Your job is to:
1. Identify architectural layers (API, Service, Data, UI, Utility)
2. Detect design patterns
3. Map module dependencies

CRITICAL: You MUST respond with valid JSON only. Do NOT return natural language.

Output JSON: { layers: Layer[], patterns: Pattern[], dependencies: Dependency[] }

Layer: { name, modules: string[] }
Pattern: { name, location: string }
Dependency: { from, to, type }`,

  tour: `You are a tour builder. Your job is to:
1. Create guided learning paths through the codebase
2. Order modules by dependency and complexity
3. Generate clear, concise descriptions

CRITICAL: You MUST respond with valid JSON only. Do NOT ask questions or return natural language.

Output JSON: { tours: Tour[] }

Tour: { name, description, steps: Step[] }
Step: { file, description, estimatedMinutes }`,

  review: `You are a graph reviewer. Your job is to:
1. Validate the knowledge graph for completeness
2. Check for missing relationships
3. Verify node and edge consistency

CRITICAL: You MUST respond with valid JSON only. Do NOT return natural language.

Output JSON: { valid: boolean, issues: Issue[], suggestions: string[] }

Issue: { type, location, message }`,
}

// ============================================================
// GrokAnalyzer Class
// ============================================================

export type GrokTaskType = 'primary' | 'fast'

export class GrokAnalyzer {
  private vendorDir: string
  private projectRoot: string
  private LLM_TIMEOUT = 120_000
  private client: Anthropic | null = null
  private model: string = 'claude-sonnet-4-20250514'
  private modelFast: string = 'claude-sonnet-4-20250514'
  private graphStore: GraphStore | null
  private fileToNodesCache: Map<string, Set<string>> | null = null
  private fileToNodesCacheLoadedAt = 0

  constructor(projectRoot: string, vendorDir?: string, graphStore?: GraphStore) {
    this.projectRoot = projectRoot
    this.vendorDir = vendorDir || GROK_VENDOR_DIR
    this.graphStore = graphStore ?? null
  }

  /**
   * 根据任务类型选择模型
   * - 'primary': 高质量模型（analyzer/architecture）
   * - 'fast': 低成本模型（tour/review/scanner）
   */
  getModelForTask(taskType: GrokTaskType = 'primary'): string {
    return taskType === 'fast' ? this.modelFast : this.model
  }

  // ============================================================
  // Source management
  // ============================================================

  /**
   * Ensure vendor directory exists for caching.
   * Analysis is fully local (GraphStore + GrokAnalyzer + tree-sitter) — no external repo needed.
   */
  async ensureGrokSource(): Promise<string> {
    const sourceDir = resolve(this.vendorDir, 'understand-anything')
    if (!existsSync(this.vendorDir)) {
      mkdirSync(this.vendorDir, { recursive: true })
    }
    return sourceDir
  }

  // ============================================================
  // LLM infrastructure
  // ============================================================

  /**
   * 获取或创建 Anthropic 客户端（惰性初始化）
   * 使用项目 provider 体系检测当前环境
   */
  private getClient(): Anthropic {
    if (!this.client) {
      const provider = getAPIProvider()
      logForDebugging(`[grok] Using API provider: ${provider}`)

      if (provider === 'openai') {
        // OpenAI 兼容模式：使用 OPENAI_BASE_URL + OPENAI_API_KEY
        const baseURL = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE
        const apiKey = process.env.OPENAI_API_KEY || 'sk-placeholder'
        this.client = new Anthropic({ baseURL, apiKey })
      } else if (provider === 'bedrock' || provider === 'vertex' || provider === 'foundry') {
        // 非直连 provider：优先使用 OpenAI 兼容代理（如 LiteLLM / vLLM）
        const proxyUrl = process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE
        if (proxyUrl) {
          logForDebugging(`[grok] Provider ${provider} detected, using OpenAI proxy: ${proxyUrl}`)
          this.client = new Anthropic({ baseURL: proxyUrl, apiKey: process.env.OPENAI_API_KEY || 'sk-placeholder' })
        } else {
          // 无代理：降级为直连，用户需确保 ANTHROPIC_API_KEY 可用
          logForDebugging(`[grok] Provider ${provider} detected, no proxy configured. Falling back to direct Anthropic API.`)
          this.client = new Anthropic()
        }
      } else {
        this.client = new Anthropic()
      }
    }
    // 每次调用刷新 model，支持运行时切换
    this.model = process.env.OLA_CC_GROK_MODEL || process.env.ANTHROPIC_MODEL || process.env.OLA_CC_MODEL_SONNET || 'claude-sonnet-4-20250514'
    this.modelFast = process.env.OLA_CC_GROK_MODEL_FAST || this.model
    return this.client
  }

  /**
   * 轻量级 Agent 调用 — 使用流式 API 减少首字节等待时间
   */
  private async callAgent(prompt: string, systemPrompt: string, modelOverride?: string): Promise<string> {
    const client = this.getClient()
    const model = modelOverride || this.model

    try {
      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      })

      const response = await stream.finalMessage()
      const textBlock = response.content.find(block => block.type === 'text')
      return textBlock ? textBlock.text : ''
    } catch (error) {
      if (error instanceof Error && (error.message.includes('429') || /\brate[\s_-]?limit/i.test(error.message))) {
        throw new GrokError(
          'LLM_RATE_LIMIT',
          'agent',
          'API rate limit exceeded',
          true,
          'Wait 60 seconds and try again'
        )
      }
      throw error
    }
  }

  /**
   * 带超时和重试的 Agent 调用（public for GrokTourBuilder）
   */
  async callAgentWithTimeout(prompt: string, systemPrompt: string, maxRetries: number = 2, modelOverride?: string): Promise<string> {
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 先创建超时 Promise 并捕获 timer 引用，确保 finally 中可清理
      let timer: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GrokError(
          'LLM_TIMEOUT',
          'agent',
          `LLM call timed out after ${this.LLM_TIMEOUT / 1000}s`,
          true,
          'Try with smaller scope or check API status'
        )), this.LLM_TIMEOUT)
      })

      try {
        const result = await Promise.race([
          this.callAgent(prompt, systemPrompt, modelOverride),
          timeoutPromise,
        ])
        if (timer) clearTimeout(timer)
        return result
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (timer) clearTimeout(timer)

        // 只对超时和限流错误重试
        const isRetryable = error instanceof GrokError &&
          (error.code === 'LLM_TIMEOUT' || error.code === 'LLM_RATE_LIMIT')
        if (!isRetryable || attempt >= maxRetries) {
          throw error
        }

        // 指数退避：2s, 4s
        const delay = Math.min(2000 * Math.pow(2, attempt), 8000)
        logForDebugging(`[grok] LLM call failed (${error instanceof GrokError ? error.code : 'unknown'}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    throw lastError || new GrokError('LLM_FAILED', 'agent', 'All retry attempts failed', true)
  }

  // ============================================================
  // File discovery
  // ============================================================

  /**
   * 发现项目中的源文件
   */
  async discoverFiles(projectPath?: string, scope?: string): Promise<string[]> {
    const basePath = resolve(this.projectRoot, scope || projectPath || '')
    // 路径穿越防护：使用 realpathSync 规范化路径，防止 symlink 或 .. 绕过
    let normalizedBase: string
    let normalizedRoot: string
    try {
      normalizedBase = realpathSync(basePath)
      normalizedRoot = realpathSync(this.projectRoot)
    } catch {
      throw new GrokError('INVALID_SCOPE', 'scanner', 'Scope path does not exist', false)
    }
    if (!normalizedBase.startsWith(normalizedRoot + '/') && normalizedBase !== normalizedRoot) {
      throw new GrokError('INVALID_SCOPE', 'scanner', 'Scope must be within project root', false)
    }
    const EXCLUDE_DIRS = new Set([
      'node_modules', '.git', '.understand-anything', 'dist', 'build',
      '.next', '__pycache__', '.cache', 'vendor', '.turbo', '.nx',
      'test', 'tests', '__tests__', 'spec', 'specs', 'e2e',
      'fixtures', 'mocks', '__mocks__', 'stories', '.storybook',
      'coverage', '.nyc_output', 'tmp', 'temp',
    ])
    const INCLUDE_EXTS = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
      '.cpp', '.c', '.h', '.hpp', '.rb', '.php', '.swift', '.kt',
      '.vue', '.svelte', '.md', '.json', '.yaml', '.yml', '.toml',
    ])

    const files: string[] = []
    const walk = async (dir: string, depth: number = 0): Promise<void> => {
      if (depth > 20) return
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (EXCLUDE_DIRS.has(entry.name)) continue
          const fullPath = resolve(dir, entry.name)
          if (entry.isDirectory()) {
            await walk(fullPath, depth + 1)
          } else if (INCLUDE_EXTS.has(extname(entry.name).toLowerCase())) {
            files.push(fullPath)
          }
        }
      } catch (e) {
        // 跳过无权限的目录，记录警告
        logForDebugging(`[grok] Skipping directory (permission denied): ${dir} — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await walk(basePath)
    logForDebugging(`[grok] Discovered ${files.length} files in ${basePath}`)
    return files
  }

  /**
   * 检测文件变更：对比当前文件与图谱中存储的指纹
   * 兼容旧格式 (mtime+size) 和新格式 (hash+size)
   * @returns { changed, added, removed, unchanged }
   */
  detectChanges(
    currentFiles: string[],
    storedFingerprints: Record<string, { hash?: string; size?: number; mtime?: number }>
  ): { changed: string[]; added: string[]; removed: string[]; unchanged: string[] } {
    const currentSet = new Set(currentFiles)
    const storedSet = new Set(Object.keys(storedFingerprints))

    const changed: string[] = []
    const added: string[] = []
    const removed: string[] = []
    const unchanged: string[] = []

    // 检查当前文件：新增或修改
    for (const file of currentFiles) {
      if (!storedSet.has(file)) {
        added.push(file)
      } else {
        const current = computeFileFingerprint(file)
        const stored = storedFingerprints[file]
        if (!current) {
          changed.push(file)
        } else if ('hash' in stored && 'hash' in current) {
          // 新格式：直接比较 hash
          if (current.hash !== stored.hash) {
            changed.push(file)
          } else {
            unchanged.push(file)
          }
        } else {
          // 旧格式或格式不匹配：标记为变更（强制重新分析）
          changed.push(file)
        }
      }
    }

    // 检查已删除文件
    for (const file of Object.keys(storedFingerprints)) {
      if (!currentSet.has(file)) {
        removed.push(file)
      }
    }

    logForDebugging(`[grok] Change detection: ${changed.length} changed, ${added.length} added, ${removed.length} removed, ${unchanged.length} unchanged`)
    return { changed, added, removed, unchanged }
  }

  // ============================================================
  // Batch analysis
  // ============================================================

  /**
   * 并行分析文件批次
   */
  async analyzeFilesBatch(
    files: string[],
    batchSize: number = 10,
    maxParallel: number = 3,
    onProgress?: (progress: number) => void
  ): Promise<Record<string, unknown>[]> {
    // Two-phase optimization: use AST metadata from GraphStore when available
    const useMetadata = this.graphStore !== null
    if (useMetadata) {
      logForDebugging(`[grok] Using two-phase optimization: AST metadata → LLM`)
      // Metadata mode sends ~300 bytes/file instead of full source — use larger batches
      // Only boost if user hasn't customized (default batchSize is 10)
      if (batchSize <= 10) batchSize = 50
      if (maxParallel <= 2) maxParallel = 5
    }

    // 内联 chunkArray
    const batches: string[][] = []
    for (let i = 0; i < files.length; i += batchSize) {
      batches.push(files.slice(i, i + batchSize))
    }

    const results: Record<string, unknown>[] = []
    const totalBatches = batches.length
    let completedBatches = 0
    let nextBatchIndex = 0
    let currentConcurrency = maxParallel
    let consecutiveRateLimits = 0

    // Producer-consumer queue with adaptive concurrency
    const processBatch = async (batch: string[]): Promise<void> => {
      try {
        const prompt = useMetadata ? this.buildMetadataPrompt(batch) : this.buildFileAnalyzerPrompt(batch)
        const result = await this.callAgentWithTimeout(prompt, AGENT_SYSTEM_PROMPTS.analyzer)
        results.push(...this.parseAnalysisResult(result))
        consecutiveRateLimits = 0
        // Gradually restore concurrency on success
        if (currentConcurrency < maxParallel) {
          currentConcurrency = Math.min(currentConcurrency + 1, maxParallel)
        }
      } catch (error) {
        const isRateLimit = error instanceof GrokError && error.code === 'LLM_RATE_LIMIT'
        if (isRateLimit) {
          consecutiveRateLimits++
          // Back off concurrency on rate limits
          currentConcurrency = Math.max(1, Math.floor(currentConcurrency * 0.5))
          logForDebugging(`[grok] Rate limited, reducing concurrency to ${currentConcurrency}`)
        } else {
          logForDebugging(`[grok] Batch analysis failed: ${error}`)
        }
      }
      completedBatches++
      onProgress?.(Math.round((completedBatches / totalBatches) * 100))
    }

    // Run batches with adaptive concurrency
    while (nextBatchIndex < totalBatches) {
      const activeBatches: Promise<void>[] = []
      for (let j = 0; j < currentConcurrency && nextBatchIndex < totalBatches; j++) {
        activeBatches.push(processBatch(batches[nextBatchIndex++]))
      }
      await Promise.allSettled(activeBatches)

      // If rate limited, wait before next wave
      if (consecutiveRateLimits > 0) {
        const backoffMs = Math.min(2000 * consecutiveRateLimits, 10000)
        logForDebugging(`[grok] Rate limit backoff: waiting ${backoffMs}ms`)
        await new Promise(resolve => setTimeout(resolve, backoffMs))
      }
    }

    return results
  }

  /**
   * 清理文件路径，防止 LLM 提示注入
   * 用反引号包裹路径，转义内部反引号
   */
  sanitizeFilePath(path: string): string {
    return '`' + path.replace(/`/g, '\\`') + '`'
  }

  /**
   * 构建 file→nodeIds 索引，避免 O(N*M) 全量扫描
   */
  private buildFileToNodesIndex(): Map<string, Set<string>> {
    const store = this.graphStore
    // Invalidate cache if store reloaded
    if (this.fileToNodesCache && store && store.loadedAt !== this.fileToNodesCacheLoadedAt) {
      this.fileToNodesCache = null
    }
    if (this.fileToNodesCache) return this.fileToNodesCache
    const index = new Map<string, Set<string>>()
    if (!store) return index
    for (const [nodeId, meta] of store.nodeMeta) {
      const file = meta.file
      if (!index.has(file)) index.set(file, new Set())
      index.get(file)!.add(nodeId)
    }
    this.fileToNodesCache = index
    this.fileToNodesCacheLoadedAt = store.loadedAt
    return index
  }

  /**
   * 从 GraphStore 获取文件的 AST 元数据（Phase 1 优化）
   * 返回每个文件的节点和边信息，~5-8KB/文件，远小于原始源码
   */
  private getFileMetadata(files: string[]): Map<string, { nodes: NodeMetadata[]; edges: Array<{ from: string; to: string; type: string }> }> {
    const result = new Map<string, { nodes: NodeMetadata[]; edges: Array<{ from: string; to: string; type: string }> }>()
    if (!this.graphStore) return result

    const fileToNodes = this.buildFileToNodesIndex()

    for (const file of files) {
      // Normalize path: make relative to projectRoot
      const relFile = file.startsWith(this.projectRoot)
        ? file.slice(this.projectRoot.length + 1)
        : file

      const fileEdges: Array<{ from: string; to: string; type: string }> = []

      // O(1) lookup via index instead of O(N) scan
      const fileNodeIds = fileToNodes.get(relFile) ?? fileToNodes.get(file) ?? new Set<string>()
      const fileNodes = [...fileNodeIds].map(id => this.graphStore!.nodeMeta.get(id)!).filter(Boolean)

      // Collect edges where source is a node in this file
      for (const [from, outMap] of this.graphStore.adjacency) {
        if (!fileNodeIds.has(from)) continue
        for (const [to, edges] of outMap) {
          for (const edge of edges) {
            fileEdges.push({ from, to, type: edge.type })
          }
        }
      }

      if (fileNodes.length > 0) {
        result.set(file, { nodes: fileNodes, edges: fileEdges })
      }
    }

    return result
  }

  /**
   * 构建基于 AST 元数据的 file-analyzer 提示词（Phase 2 优化）
   * 发送元数据给 LLM 而非原始源码，节省 token 并提供精确信息
   */
  buildMetadataPrompt(files: string[]): string {
    const metadata = this.getFileMetadata(files)

    const fileSections = files.map(f => {
      const meta = metadata.get(f)
      if (!meta) {
        return `### ${this.sanitizeFilePath(f)}\n(No AST metadata available — file not indexed by codegraph)`
      }

      const nodeSummary = meta.nodes.map(n =>
        `  - ${n.kind}: ${sanitizeForPrompt(n.name)}${n.signature ? ` (${sanitizeForPrompt(n.signature)})` : ''} [L${n.line}]${n.is_exported ? ' [exported]' : ''}${n.is_async ? ' [async]' : ''}`
      ).join('\n')

      const edgeSummary = meta.edges.slice(0, 50).map(e =>
        `  - ${sanitizeForPrompt(e.from)} → ${sanitizeForPrompt(e.to)} (${e.type})`
      ).join('\n')

      return `### ${this.sanitizeFilePath(f)}
**Nodes** (${meta.nodes.length}):
${nodeSummary || '  (none)'}
**Edges** (${meta.edges.length}${meta.edges.length > 50 ? ', showing first 50' : ''}):
${edgeSummary || '  (none)'}`
    }).join('\n\n')

    return `Analyze the following files based on their AST metadata (nodes and edges extracted by tree-sitter).

${fileSections}

For each file, provide:
1. Semantic summary: What is this file's purpose? What module/layer does it belong to?
2. Key relationships: What are the most important dependencies and call chains?
3. Architectural role: Is this a controller, service, utility, model, etc.?
4. Quality signals: Any code smells, missing abstractions, or complexity concerns?

Output JSON array of analysis results.`
  }

  /**
   * 构建 file-analyzer 提示词（降级模式：无 GraphStore 时使用）
   */
  buildFileAnalyzerPrompt(files: string[]): string {
    return `Analyze the following files and extract symbols, relationships, and summaries:

${files.map(f => `- ${this.sanitizeFilePath(f)}`).join('\n')}

For each file, identify:
1. Functions, classes, types, interfaces (symbols)
2. Import/export relationships
3. Function calls and dependencies
4. Brief summary of purpose

Output JSON array of analysis results.`
  }

  /**
   * 解析分析结果（自动剥离 LLM markdown code fence）
   * 只剥离字符串首尾的 code fence，不处理中间嵌套的
   */
  parseAnalysisResult(result: string): Record<string, unknown>[] {
    try {
      // Strip BOM, leading/trailing whitespace
      let cleaned = result.replace(/^\uFEFF/, '').trim()
      // Strip ALL code fences (opening and closing, anywhere in the string)
      // Handles ```json, ```JSON, ``` json, plain ```, with \r\n
      cleaned = cleaned.replace(/^```(?:\s*(?:json|JSON|Json))?[\s\r\n]*/i, '')
      cleaned = cleaned.replace(/[\s\r\n]*```[\s\S]*$/, '')
      cleaned = cleaned.trim()

      if (!cleaned) return []

      // Try direct parse first
      try {
        const parsed = JSON.parse(cleaned)
        return Array.isArray(parsed) ? parsed : [parsed]
      } catch {
        // Fallback: extract first JSON array (non-greedy) from the response
        const arrayMatch = cleaned.match(/(\[[\s\S]*\])/)
        if (arrayMatch) {
          try {
            const parsed = JSON.parse(arrayMatch[1]!)
            return Array.isArray(parsed) ? parsed : [parsed]
          } catch { /* fall through */ }
        }
        // Fallback: extract first JSON object (non-greedy)
        const objMatch = cleaned.match(/(\{[\s\S]*\})/)
        if (objMatch) {
          try {
            const parsed = JSON.parse(objMatch[1]!)
            return Array.isArray(parsed) ? parsed : [parsed]
          } catch { /* fall through */ }
        }
        // Last resort: try to fix common truncation (missing closing brackets)
        const fixable = cleaned.replace(/,\s*$/, '').replace(/(\{|\[)[\s\S]*$/, (m) => {
          // Close any unclosed brackets
          let depth = 0
          for (const ch of m) {
            if (ch === '{' || ch === '[') depth++
            if (ch === '}' || ch === ']') depth--
          }
          return m + (depth > 0 ? ']'.repeat(Math.ceil(depth / 2)) : '')
        })
        try {
          const parsed = JSON.parse(fixable)
          return Array.isArray(parsed) ? parsed : [parsed]
        } catch { /* give up */ }

        throw new Error('No valid JSON found')
      }
    } catch {
      const preview = result.slice(0, 200)
      logForDebugging(`[grok] Failed to parse analysis result: ${preview}`)
      return []
    }
  }

  // ============================================================
  // Pipeline step execution
  // ============================================================

  /**
   * 执行单个 Pipeline 步骤（带超时、解析、错误处理）
   */
  async runPipelineStep(
    stage: string,
    prompt: string,
    systemPrompt: string,
    reportProgress: (stage: string, progress: number) => void,
    errors: GrokError[],
    taskType?: GrokTaskType
  ): Promise<Record<string, unknown>> {
    reportProgress(stage, 0)
    const modelOverride = taskType ? this.getModelForTask(taskType) : undefined
    // Periodic progress ticks during LLM call — send incrementing progress
    // so the ProgressBar renders visually (0% = dots animation, >0% = bar)
    let tickProgress = 0
    const tickInterval = setInterval(() => {
      tickProgress = Math.min(tickProgress + 5, 95)
      reportProgress(stage, tickProgress)
    }, 2000)
    try {
      const response = await this.callAgentWithTimeout(prompt, systemPrompt, 2, modelOverride)
      clearInterval(tickInterval)
      const result = this.parseAnalysisResult(response)[0] || {}
      reportProgress(stage, 100)
      return result
    } catch (error) {
      clearInterval(tickInterval)
      const code = `${stage.toUpperCase()}_FAILED`
      errors.push(error instanceof GrokError ? error : new GrokError(code, stage, String(error), true))
      reportProgress(stage, 100)
      return {}
    }
  }
}
