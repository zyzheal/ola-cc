// src/tools/GrokTool/GrokManager.ts

import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { createServer } from 'http'
import { homedir } from 'os'
import { extname, resolve } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod/v4'
import { openBrowser } from '../../utils/browser.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { getAPIProvider } from '../../utils/model/providers.js'

// ============================================================
// Types
// ============================================================

export interface GrokGenerateOptions {
  path?: string           // 扫描路径，默认项目根目录
  language?: string       // 输出语言，默认 'en'
  scope?: string          // 子目录范围
  incremental?: boolean   // 增量更新，默认 true
  onProgress?: (stage: string, progress: number) => void  // 进度回调
}

export interface GrokGenerateResult {
  status: 'success' | 'partial' | 'failed'
  nodeCount: number
  edgeCount: number
  domainCount: number
  filePath: string        // knowledge-graph.json 路径
  errors?: GrokError[]    // 部分失败时的错误列表
}

export interface GrokChatResult {
  answer: string
  sources: { file: string; line: number; relevance: number }[]
}

export interface GrokGraphStatus {
  exists: boolean
  nodeCount?: number
  edgeCount?: number
  lastUpdated?: string
  stale?: boolean
}

// ============================================================
// Error Classes
// ============================================================

export class GrokError extends Error {
  constructor(
    public code: string,
    public stage: string,
    message: string,
    public recoverable: boolean,
    public suggestion?: string
  ) {
    super(message)
    this.name = 'GrokError'
  }
}

// 错误类型与建议
export const ERROR_SUGGESTIONS: Record<string, string> = {
  'PARSE_TIMEOUT': '文件过大，建议 --exclude 排除或拆分文件',
  'LLM_RATE_LIMIT': 'API 限流，建议等待 60s 后重试',
  'LLM_TOKEN_BUDGET': 'Token 预算耗尽，建议 --scope 缩小范围',
  'GRAPH_INVALID': '图谱数据损坏，建议 /grok --full 重新生成',
  'SOURCE_CLONE_FAILED': '源码克隆失败，检查网络连接后重试',
}

// ============================================================
// Constants
// ============================================================

const GROK_VENDOR_DIR = '~/.ola-cc/vendor/grok'
const GROK_GRAPH_FILE = '.understand-anything/knowledge-graph.json'
const GROK_CHECKPOINT_DIR = '.understand-anything/checkpoints'

// Agent 超时配置（毫秒）
const AGENT_TIMEOUTS = {
  scanner: 30_000,
  analyzer_batch: 30_000,
  architecture: 60_000,
  tour: 60_000,
  review: 30_000,
  total: 10 * 60_000,  // 10 分钟
}

// Agent 系统提示词（从 Understand-Anything 源码提取）
const AGENT_SYSTEM_PROMPTS = {
  scanner: `You are a project scanner. Your job is to:
1. Discover all source files in the project
2. Detect programming languages and frameworks
3. Identify project structure and entry points

Output JSON: { files: string[], languages: string[], frameworks: string[], entryPoints: string[] }`,

  analyzer: `You are a code analyzer. Your job is to:
1. Parse source files using Tree-sitter
2. Extract symbols (functions, classes, types, interfaces)
3. Analyze semantic meaning and relationships
4. Generate concise summaries

Output JSON: { symbols: Symbol[], relationships: Relationship[] }

Symbol: { name, kind, file, line, signature, summary }
Relationship: { from, to, type }`,

  architecture: `You are an architecture analyzer. Your job is to:
1. Identify architectural layers (API, Service, Data, UI, Utility)
2. Detect design patterns
3. Map module dependencies

Output JSON: { layers: Layer[], patterns: Pattern[], dependencies: Dependency[] }

Layer: { name, modules: string[] }
Pattern: { name, location: string }
Dependency: { from, to, type }`,

  tour: `You are a tour builder. Your job is to:
1. Create guided learning paths through the codebase
2. Order modules by dependency and complexity
3. Generate clear, concise descriptions

Output JSON: { tours: Tour[] }

Tour: { name, description, steps: Step[] }
Step: { file, description, estimatedMinutes }`,

  review: `You are a graph reviewer. Your job is to:
1. Validate the knowledge graph for completeness
2. Check for missing relationships
3. Verify node and edge consistency

Output JSON: { valid: boolean, issues: Issue[], suggestions: string[] }

Issue: { type, location, message }`,
}

// ============================================================
// Configuration Validation
// ============================================================

const GrokConfigSchema = z.object({
  storage: z.enum(['project', 'user']).default('project'),
  portRange: z.string().regex(/^\d{5}-\d{5}$/).default('63000-63100'),
  language: z.string().min(2).max(5).default('en'),
  maxBatch: z.number().int().min(1).max(10).default(5),
  autoUpdate: z.boolean().default(false),
})

type GrokConfig = z.infer<typeof GrokConfigSchema>

/**
 * 从环境变量加载并验证配置
 */
function loadGrokConfig(): GrokConfig {
  const raw = {
    storage: process.env.OLA_CC_GROK_STORAGE,
    portRange: process.env.OLA_CC_GROK_PORT_RANGE,
    language: process.env.OLA_CC_GROK_LANGUAGE,
    maxBatch: process.env.OLA_CC_GROK_MAX_BATCH ? parseInt(process.env.OLA_CC_GROK_MAX_BATCH) : undefined,
    autoUpdate: process.env.OLA_CC_GROK_AUTO_UPDATE === 'true',
  }

  // 移除 undefined 值，让 Zod 使用默认值
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([_, v]) => v !== undefined)
  )

  try {
    return GrokConfigSchema.parse(cleaned)
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n')
      logForDebugging(`[grok] Invalid configuration:\n${issues}`)
      // 使用默认值
      return GrokConfigSchema.parse({})
    }
    throw error
  }
}

// ============================================================
// GrokManager Class
// ============================================================

export class GrokManager {
  private pipelineLock: Promise<void> | null = null
  private _projectRoot: string | null
  private vendorDir: string
  private config: GrokConfig
  private dashboardServer: ReturnType<typeof createServer> | null = null

  /** 惰性获取 projectRoot，适配 worktree 切换 */
  private get projectRoot(): string {
    return this._projectRoot || getCwd()
  }

  constructor(projectRoot?: string) {
    this._projectRoot = projectRoot || null
    this.vendorDir = GROK_VENDOR_DIR.replace('~', homedir())
    this.config = loadGrokConfig()

    logForDebugging(`[grok] Config loaded: ${JSON.stringify(this.config)}`)
  }

  /**
   * 带指数退避的重试机制
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn()
      } catch (error) {
        if (i === maxRetries - 1) throw error
        const delay = baseDelay * Math.pow(2, i)
        logForDebugging(`[grok] Retry ${i + 1}/${maxRetries} after ${delay}ms`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    throw new Error('Unreachable')
  }

  /**
   * 确保 Grok 源码已克隆（带重试）
   * @returns 源码目录路径
   */
  async ensureGrokSource(): Promise<string> {
    const sourceDir = resolve(this.vendorDir, 'understand-anything')

    if (existsSync(sourceDir)) {
      logForDebugging(`[grok] Source already exists at ${sourceDir}`)
      return sourceDir
    }

    mkdirSync(this.vendorDir, { recursive: true })

    return this.retryWithBackoff(async () => {
      logForDebugging(`[grok] Cloning Understand-Anything to ${sourceDir}`)
      try {
        execSync(
          `git clone --depth 1 https://github.com/Lum1104/Understand-Anything.git ${sourceDir}`,
          { stdio: 'pipe', timeout: 120_000 }
        )
        logForDebugging(`[grok] Clone complete`)
        return sourceDir
      } catch (error) {
        throw new GrokError(
          'SOURCE_CLONE_FAILED',
          'clone',
          `Failed to clone source: ${error instanceof Error ? error.message : String(error)}`,
          true,
          'Check network connection and try again'
        )
      }
    })
  }

  /**
   * 更新 Grok 源码
   */
  async updateGrokSource(): Promise<void> {
    const sourceDir = resolve(this.vendorDir, 'understand-anything')

    if (!existsSync(sourceDir)) {
      await this.ensureGrokSource()
      return
    }

    logForDebugging(`[grok] Updating source at ${sourceDir}`)
    try {
      execSync('git pull', { cwd: sourceDir, stdio: 'pipe', timeout: 60_000 })
      logForDebugging(`[grok] Update complete`)
    } catch (error) {
      throw new GrokError(
        'SOURCE_UPDATE_FAILED',
        'update',
        `Failed to update source: ${error instanceof Error ? error.message : String(error)}`,
        true,
        'Try running /grok --update manually'
      )
    }
  }

  // ============================================================
  // 超时配置
  // ============================================================

  private readonly LLM_TIMEOUT = 30_000    // LLM 调用超时 30 秒

  private client: Anthropic | null = null
  private model: string = 'claude-sonnet-4-20250514'

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
        // 非直连 provider：当前 Grok 的轻量调用不支持这些 provider
        // 降级为直连模式，用户需确保 ANTHROPIC_API_KEY 可用
        logForDebugging(`[grok] Provider ${provider} detected but Grok uses direct API. Falling back to firstParty.`)
        this.client = new Anthropic()
      } else {
        this.client = new Anthropic()
      }

      this.model = process.env.ANTHROPIC_MODEL || process.env.OLA_CC_MODEL_SONNET || 'claude-sonnet-4-20250514'
    }
    return this.client
  }

  /**
   * 轻量级 Agent 调用 — 直接使用 Anthropic SDK
   */
  private async callAgent(prompt: string, systemPrompt: string): Promise<string> {
    const client = this.getClient()

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      })

      const textBlock = response.content.find(block => block.type === 'text')
      return textBlock ? textBlock.text : ''
    } catch (error) {
      if (error instanceof Error && error.message.includes('429')) {
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
   * 带超时的 Agent 调用
   */
  private async callAgentWithTimeout(prompt: string, systemPrompt: string): Promise<string> {
    let timer: NodeJS.Timeout
    return Promise.race([
      this.callAgent(prompt, systemPrompt).finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GrokError(
          'LLM_TIMEOUT',
          'agent',
          'LLM call timed out after 30s',
          true,
          'Try with smaller scope or check API status'
        )), this.LLM_TIMEOUT)
      })
    ])
  }

  /**
   * 并行分析文件批次
   */
  private async analyzeFilesBatch(
    files: string[],
    batchSize: number = 25,
    maxParallel: number = 5
  ): Promise<any[]> {
    // 内联 chunkArray
    const batches: string[][] = []
    for (let i = 0; i < files.length; i += batchSize) {
      batches.push(files.slice(i, i + batchSize))
    }

    const results: any[] = []

    for (let i = 0; i < batches.length; i += maxParallel) {
      const parallelBatches = batches.slice(i, i + maxParallel)
      const batchResults = await Promise.allSettled(
        parallelBatches.map(batch =>
          this.callAgentWithTimeout(
            this.buildFileAnalyzerPrompt(batch),
            AGENT_SYSTEM_PROMPTS.analyzer
          )
        )
      )
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(...this.parseAnalysisResult(result.value))
        } else {
          logForDebugging(`[grok] Batch analysis failed: ${result.reason}`)
        }
      }
    }

    return results
  }

  /**
   * 构建 file-analyzer 提示词
   */
  private buildFileAnalyzerPrompt(files: string[]): string {
    return `Analyze the following files and extract symbols, relationships, and summaries:

${files.map(f => `- ${f}`).join('\n')}

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
  private parseAnalysisResult(result: string): any[] {
    try {
      // Strip leading code fence (only at string start)
      let cleaned = result.trim()
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '')
      }
      // Strip trailing code fence (only at string end)
      if (cleaned.endsWith('```')) {
        cleaned = cleaned.replace(/\n?```$/, '')
      }
      cleaned = cleaned.trim()
      const parsed = JSON.parse(cleaned)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      logForDebugging(`[grok] Failed to parse analysis result: ${result.slice(0, 200)}`)
      return []
    }
  }

  /**
   * 发现项目中的源文件
   */
  private async discoverFiles(projectPath?: string, scope?: string): Promise<string[]> {
    const basePath = resolve(this.projectRoot, scope || projectPath || '')
    // 路径穿越防护：scope 不能逃出 projectRoot
    if (!basePath.startsWith(this.projectRoot + '/') && basePath !== this.projectRoot) {
      throw new GrokError('INVALID_SCOPE', 'scanner', 'Scope must be within project root', false)
    }
    const EXCLUDE_DIRS = new Set([
      'node_modules', '.git', '.understand-anything', 'dist', 'build',
      '.next', '__pycache__', '.cache', 'vendor', '.turbo', '.nx',
    ])
    const INCLUDE_EXTS = new Set([
      '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
      '.cpp', '.c', '.h', '.hpp', '.rb', '.php', '.swift', '.kt',
      '.vue', '.svelte', '.md', '.json', '.yaml', '.yml', '.toml',
    ])

    const files: string[] = []
    const walk = (dir: string, depth: number = 0) => {
      if (depth > 20) return
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (EXCLUDE_DIRS.has(entry.name)) continue
          const fullPath = resolve(dir, entry.name)
          if (entry.isDirectory()) {
            walk(fullPath, depth + 1)
          } else if (INCLUDE_EXTS.has(extname(entry.name).toLowerCase())) {
            files.push(fullPath)
          }
        }
      } catch {
        // 跳过无权限的目录
      }
    }
    walk(basePath)
    logForDebugging(`[grok] Discovered ${files.length} files in ${basePath}`)
    return files
  }

  /**
   * 计算文件指纹（SHA-256 content hash + size）
   * 使用内容哈希代替 mtime，避免 git checkout/pull 后 mtime 未变的误判
   */
  private computeFileFingerprint(filePath: string): { hash: string; size: number } | null {
    try {
      const content = readFileSync(filePath)
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
      return { hash, size: content.length }
    } catch {
      return null
    }
  }

  /**
   * 检测文件变更：对比当前文件与图谱中存储的指纹
   * 兼容旧格式 (mtime+size) 和新格式 (hash+size)
   * @returns { changed, added, removed, unchanged }
   */
  private detectChanges(
    currentFiles: string[],
    storedFingerprints: Record<string, any>
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
        const current = this.computeFileFingerprint(file)
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

  /**
   * 组装知识图谱
   * @param changes 增量模式下的变更信息，用于延迟删除旧节点（分析完成后再清理）
   */
  private assembleGraph(
    files: string[],
    scannerResult: any,
    analysisResults: any[],
    architectureResult: any,
    tourResult: any,
    reviewResult: any,
    language: string,
    errors: GrokError[],
    existingGraph?: any,
    changes?: { changed: string[]; added: string[]; removed: string[] }
  ): GrokGenerateResult {
    const domains = new Set<string>()
    let nodes: any[]
    let edges: any[]

    if (existingGraph && changes) {
      // 增量模式：找出哪些文件的分析结果实际存在
      const analyzedFiles = new Set<string>()
      for (const result of analysisResults) {
        for (const sym of (result.symbols || [])) {
          if (sym.file) analyzedFiles.add(sym.file)
        }
      }

      // 只删除有新分析结果的变更文件节点 + 已删除文件节点
      // 如果 LLM 分析失败（analysisResults 为空），保留旧节点防止数据丢失
      const filesToRemove = new Set<string>(changes.removed)
      for (const file of changes.changed) {
        if (analyzedFiles.has(file)) {
          filesToRemove.add(file)
        }
        // 没有分析结果的变更文件 → 保留旧节点
      }

      nodes = (existingGraph.nodes || []).filter((n: any) => !filesToRemove.has(n.file))
      const nodeIdsForFilter = new Set(nodes.map((n: any) => n.id))
      edges = (existingGraph.edges || []).filter((e: any) =>
        nodeIdsForFilter.has(e.from) && nodeIdsForFilter.has(e.to)
      )
    } else {
      nodes = []
      edges = []
    }

    // 从分析结果提取新节点（带去重）
    const existingNodeIds = new Set(nodes.map((n: any) => n.id))
    for (const result of analysisResults) {
      const symbols = result.symbols || []
      for (const sym of symbols) {
        const id = `${sym.file || 'unknown'}:${sym.name || 'unknown'}`
        // 防止节点 ID 碰撞：加索引后缀
        let finalId = id
        let counter = 1
        while (existingNodeIds.has(finalId)) {
          finalId = `${id}#${counter++}`
        }
        existingNodeIds.add(finalId)

        nodes.push({
          id: finalId,
          name: sym.name || 'unknown',
          kind: sym.kind || 'symbol',
          file: sym.file || '',
          line: sym.line || 0,
          signature: sym.signature || '',
          summary: sym.summary || '',
          layer: '',
          domain: '',
        })
      }

      // 提取边（关系）
      const rels = result.relationships || []
      for (const rel of rels) {
        edges.push({
          from: rel.from || '',
          to: rel.to || '',
          type: rel.type || 'relates',
        })
      }
    }

    // 从架构结果分配层
    const layers = architectureResult.layers || []
    for (const layer of layers) {
      const layerName = layer.name || 'unknown'
      const layerModules = layer.modules || []
      for (const node of nodes) {
        if (layerModules.some((m: string) => node.file?.includes(m))) {
          node.layer = layerName
        }
      }
      if (layerName !== 'unknown') domains.add(layerName)
    }

    // 从架构结果添加依赖边
    const deps = architectureResult.dependencies || []
    for (const dep of deps) {
      edges.push({ from: dep.from || '', to: dep.to || '', type: dep.type || 'depends' })
    }

    // 去重边 + 验证两端节点存在
    const nodeIdSet = new Set(nodes.map((n: any) => n.id))
    const edgeKeys = new Set<string>()
    const uniqueEdges = edges.filter(e => {
      if (!e.from || !e.to) return false
      if (!nodeIdSet.has(e.from) || !nodeIdSet.has(e.to)) return false
      const key = `${e.from}->${e.to}:${e.type}`
      if (edgeKeys.has(key)) return false
      edgeKeys.add(key)
      return true
    })

    // 未覆盖文件
    const coveredFiles = new Set(nodes.map((n: any) => n.file).filter(Boolean))
    const uncovered = files.filter(f => !coveredFiles.has(f))

    // 计算文件指纹（用于增量更新）
    const fingerprints: Record<string, { hash: string; size: number }> = {}
    for (const file of files) {
      const fp = this.computeFileFingerprint(file)
      if (fp) fingerprints[file] = fp
    }

    // 原子写入：先写临时文件，再 rename（防止写入中断导致数据损坏）
    const graphDir = resolve(this.projectRoot, '.understand-anything')
    mkdirSync(graphDir, { recursive: true })
    const filePath = resolve(graphDir, 'knowledge-graph.json')
    const tempPath = filePath + '.tmp'

    const graphData = {
      nodes,
      edges: uniqueEdges,
      metadata: {
        lastUpdated: new Date().toISOString(),
        fileCount: files.length,
        languages: scannerResult.languages || [],
        frameworks: scannerResult.frameworks || [],
        layers: layers.map((l: any) => l.name || ''),
        uncovered: uncovered.length,
        tour: tourResult.tours || [],
        review: reviewResult.valid !== undefined ? reviewResult : { valid: true, issues: [], suggestions: [] },
        language,
        errors: errors.map(e => ({ code: e.code, stage: e.stage, message: e.message })),
        fingerprints,
      },
    }

    // 清理残留的 .tmp 文件（上次崩溃遗留）
    try { if (existsSync(tempPath)) unlinkSync(tempPath) } catch { /* ignore */ }

    // 备份旧文件（防损坏恢复）
    const backupPath = filePath + '.backup'
    try { if (existsSync(filePath)) copyFileSync(filePath, backupPath) } catch { /* ignore */ }

    writeFileSync(tempPath, JSON.stringify(graphData, null, 2), 'utf-8')
    renameSync(tempPath, filePath)
    logForDebugging(`[grok] Graph saved: ${nodes.length} nodes, ${uniqueEdges.length} edges → ${filePath}`)

    return {
      status: errors.length > 0 ? 'partial' : 'success',
      nodeCount: nodes.length,
      edgeCount: uniqueEdges.length,
      domainCount: domains.size,
      filePath,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  /**
   * 运行 Agent 流水线生成知识图谱
   */
  async runAgentPipeline(options: GrokGenerateOptions): Promise<GrokGenerateResult> {
    // 并发锁：等待上一次 pipeline 完成
    if (this.pipelineLock) {
      logForDebugging('[grok] Pipeline already running, waiting...')
      await this.pipelineLock
    }

    let releaseLock: () => void
    this.pipelineLock = new Promise<void>(resolve => { releaseLock = resolve })

    try {
      return await this._runPipelineInner(options)
    } finally {
      releaseLock!()
      this.pipelineLock = null
    }
  }

  private async _runPipelineInner(options: GrokGenerateOptions): Promise<GrokGenerateResult> {
    const errors: GrokError[] = []
    const reportProgress = options.onProgress || (() => {})
    const startTime = Date.now()
    const isIncremental = options.incremental !== false

    // Step 1: 发现文件
    reportProgress('scanner', 0)
    const files = await this.discoverFiles(options.path, options.scope)
    if (files.length === 0) {
      return { status: 'failed', nodeCount: 0, edgeCount: 0, domainCount: 0, filePath: '', errors: [new GrokError('NO_FILES', 'scanner', 'No source files found', false)] }
    }

    // 增量模式：检测变更（不提前删除节点，延迟到 assembleGraph 阶段）
    let existingGraph: any = null
    let filesToAnalyze = files
    let isIncrementalRun = false
    let changes: { changed: string[]; added: string[]; removed: string[] } | undefined

    if (isIncremental) {
      const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)
      if (existsSync(graphPath)) {
        try {
          existingGraph = JSON.parse(readFileSync(graphPath, 'utf-8'))
          // 校验图谱结构完整性
          if (!Array.isArray(existingGraph.nodes) || !Array.isArray(existingGraph.edges)) {
            throw new Error('Missing nodes or edges arrays')
          }
          const storedFps = existingGraph.metadata?.fingerprints || {}
          changes = this.detectChanges(files, storedFps)

          // 无变更 → 直接返回现有图谱统计
          if (changes.changed.length === 0 && changes.added.length === 0 && changes.removed.length === 0) {
            logForDebugging('[grok] Incremental: no changes detected, skipping')
            return {
              status: 'success',
              nodeCount: existingGraph.nodes?.length || 0,
              edgeCount: existingGraph.edges?.length || 0,
              domainCount: new Set(existingGraph.nodes?.map((n: any) => n.layer).filter(Boolean)).size,
              filePath: graphPath,
            }
          }

          // 有变更 → 只分析变更+新增文件
          filesToAnalyze = [...changes.changed, ...changes.added]
          isIncrementalRun = true
          logForDebugging(`[grok] Incremental: ${filesToAnalyze.length} files to re-analyze (${changes.changed.length} changed, ${changes.added.length} added, ${changes.removed.length} removed)`)
          // 注意：不在这里删除旧节点！交给 assembleGraph 在新分析完成后统一处理
        } catch (error) {
          // 主文件损坏，尝试读取备份
          const backupPath = graphPath + '.backup'
          if (existsSync(backupPath)) {
            try {
              existingGraph = JSON.parse(readFileSync(backupPath, 'utf-8'))
              if (Array.isArray(existingGraph.nodes) && Array.isArray(existingGraph.edges)) {
                logForDebugging(`[grok] Incremental: main graph corrupted, recovered from backup`)
                const storedFps = existingGraph.metadata?.fingerprints || {}
                changes = this.detectChanges(files, storedFps)
                filesToAnalyze = [...(changes.changed || []), ...(changes.added || [])]
                isIncrementalRun = true
              } else {
                throw new Error('backup also invalid')
              }
            } catch {
              logForDebugging(`[grok] Incremental: backup also corrupted, falling back to full`)
              existingGraph = null
              filesToAnalyze = files
              isIncrementalRun = false
              changes = undefined
            }
          } else {
            logForDebugging(`[grok] Incremental: failed to read existing graph, falling back to full: ${error}`)
            existingGraph = null
            filesToAnalyze = files
            isIncrementalRun = false
            changes = undefined
          }
        }
      }
    }

    // Step 2: Scanner Agent — 语言和框架检测（增量模式跳过，复用已有数据）
    let scannerResult: any = {}
    if (isIncrementalRun && existingGraph?.metadata) {
      // 增量模式：复用已有扫描结果
      scannerResult = {
        languages: existingGraph.metadata.languages || [],
        frameworks: existingGraph.metadata.frameworks || [],
      }
      reportProgress('scanner', 100)
    } else {
      try {
        const scannerResponse = await this.callAgentWithTimeout(
          `Analyze this project and detect languages, frameworks, and entry points.\n\nFiles:\n${files.slice(0, 50).map(f => `- ${f}`).join('\n')}`,
          AGENT_SYSTEM_PROMPTS.scanner
        )
        scannerResult = this.parseAnalysisResult(scannerResponse)[0] || {}
        reportProgress('scanner', 100)
      } catch (error) {
        errors.push(error instanceof GrokError ? error : new GrokError('SCANNER_FAILED', 'scanner', String(error), true))
        reportProgress('scanner', 100)
      }
    }

    // Step 3: File Analyzer Agent — 批量并行分析（增量模式只分析变更文件）
    reportProgress('analyzer', 0)
    let analysisResults: any[] = []
    try {
      analysisResults = await this.analyzeFilesBatch(filesToAnalyze)
      reportProgress('analyzer', 100)
    } catch (error) {
      errors.push(error instanceof GrokError ? error : new GrokError('ANALYZER_FAILED', 'analyzer', String(error), true))
      reportProgress('analyzer', 100)
    }

    // Step 4: Architecture Agent — 架构层分析（增量模式：变更 <20% 文件时复用已有架构）
    reportProgress('architecture', 0)
    let architectureResult: any = {}
    if (isIncrementalRun && existingGraph?.metadata && filesToAnalyze.length < files.length * 0.2) {
      // 增量模式：变更比例小，复用已有架构分析（避免 LLM 重复调用）
      architectureResult = { layers: existingGraph.metadata.layers?.map((l: string) => ({ name: l, modules: [] })) || [], dependencies: [] }
      logForDebugging('[grok] Incremental: reusing existing architecture analysis')
      reportProgress('architecture', 100)
    } else {
      try {
        const archResponse = await this.callAgentWithTimeout(
          `Analyze the architecture of this project.\n\nFiles: ${files.length}\nLanguages: ${scannerResult.languages?.join(', ') || 'unknown'}\nFrameworks: ${scannerResult.frameworks?.join(', ') || 'unknown'}\n\nSample modules:\n${files.slice(0, 30).map(f => `- ${f}`).join('\n')}`,
          AGENT_SYSTEM_PROMPTS.architecture
        )
        architectureResult = this.parseAnalysisResult(archResponse)[0] || {}
        reportProgress('architecture', 100)
      } catch (error) {
        errors.push(error instanceof GrokError ? error : new GrokError('ARCH_FAILED', 'architecture', String(error), true))
        reportProgress('architecture', 100)
      }
    }

    // Step 5: Tour Builder — 学习路径（增量模式复用已有 tour）
    reportProgress('tour', 0)
    let tourResult: any = {}
    if (isIncrementalRun && existingGraph?.metadata?.tour) {
      tourResult = { tours: existingGraph.metadata.tour }
      logForDebugging('[grok] Incremental: reusing existing tour')
      reportProgress('tour', 100)
    } else {
      try {
        const tourResponse = await this.callAgentWithTimeout(
          `Create learning tours for this project.\n\nFiles: ${files.length}\nLayers: ${JSON.stringify(architectureResult.layers || [])}`,
          AGENT_SYSTEM_PROMPTS.tour
        )
        tourResult = this.parseAnalysisResult(tourResponse)[0] || {}
        reportProgress('tour', 100)
      } catch (error) {
        errors.push(error instanceof GrokError ? error : new GrokError('TOUR_FAILED', 'tour', String(error), true))
        reportProgress('tour', 100)
      }
    }

    // Step 6: Graph Reviewer — 质量审查（增量模式跳过，复用已有 review）
    reportProgress('review', 0)
    let reviewResult: any = {}
    if (isIncrementalRun && existingGraph?.metadata?.review) {
      reviewResult = existingGraph.metadata.review
      logForDebugging('[grok] Incremental: reusing existing review')
      reportProgress('review', 100)
    } else {
      try {
        const nodeCount = analysisResults.length
        const edgeCount = architectureResult.dependencies?.length || 0
        const reviewResponse = await this.callAgentWithTimeout(
          `Review this knowledge graph for completeness.\n\nNodes: ${nodeCount}\nEdges: ${edgeCount}\nLayers: ${JSON.stringify(architectureResult.layers || [])}`,
          AGENT_SYSTEM_PROMPTS.review
        )
        reviewResult = this.parseAnalysisResult(reviewResponse)[0] || {}
        reportProgress('review', 100)
      } catch (error) {
        errors.push(error instanceof GrokError ? error : new GrokError('REVIEW_FAILED', 'review', String(error), true))
        reportProgress('review', 100)
      }
    }

    // Step 7: 组装并保存图谱（增量模式合并已有数据，延迟删除旧节点）
    const result = this.assembleGraph(
      files, scannerResult, analysisResults, architectureResult,
      tourResult, reviewResult, options.language || 'en', errors,
      isIncrementalRun ? existingGraph : undefined,
      isIncrementalRun ? changes : undefined
    )

    logForDebugging(`[grok] Pipeline completed in ${Date.now() - startTime}ms: ${result.nodeCount} nodes, ${result.edgeCount} edges`)
    return result
  }

  /**
   * 将 camelCase/snake_case 标识符拆分为 token
   */
  private tokenizeIdentifier(text: string): string[] {
    return text
      .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → camel Case
      .replace(/[_\-./]+/g, ' ')              // snake_case, kebab-case, paths
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 1)
  }

  /**
   * 查询已生成的知识图谱
   */
  async queryGraph(question: string): Promise<GrokChatResult> {
    const status = await this.getGraphStatus()
    if (!status.exists) {
      throw new GrokError('GRAPH_NOT_FOUND', 'query', '知识图谱未生成，请先执行 /grok', true)
    }

    const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)
    let graph: any
    try {
      graph = JSON.parse(readFileSync(graphPath, 'utf-8'))
    } catch (e) {
      throw new GrokError('GRAPH_INVALID', 'query', `知识图谱文件损坏: ${e instanceof Error ? e.message : String(e)}`, true, '建议执行 /grok --full 重新生成')
    }

    // 从问题中提取关键词，支持 camelCase/snake_case 拆分
    const rawKeywords = question.split(/\s+/).filter(w => w.length > 1)
    const keywords = new Set<string>()
    for (const kw of rawKeywords) {
      keywords.add(kw.toLowerCase())
      for (const token of this.tokenizeIdentifier(kw)) {
        keywords.add(token)
      }
    }

    // 匹配节点并计算相关性分数
    const scoredNodes = (graph.nodes || [])
      .map((node: any) => {
        const name = (node.name || '').toLowerCase()
        const summary = (node.summary || '').toLowerCase()
        const file = (node.file || '').toLowerCase()
        const kind = (node.kind || '').toLowerCase()
        const signature = (node.signature || '').toLowerCase()

        let score = 0
        for (const kw of keywords) {
          // 名称精确匹配权重最高
          if (name === kw) { score += 10; continue }
          // 名称包含匹配
          if (name.includes(kw)) { score += 5; continue }
          // 签名匹配
          if (signature.includes(kw)) { score += 3; continue }
          // 摘要匹配
          if (summary.includes(kw)) { score += 2; continue }
          // 文件路径匹配
          if (file.includes(kw)) { score += 1; continue }
          // 类型匹配
          if (kind.includes(kw)) { score += 1; continue }
        }

        // 名称 token 匹配（camelCase 拆分后）
        const nameTokens = this.tokenizeIdentifier(node.name || '')
        for (const nt of nameTokens) {
          if (keywords.has(nt)) score += 4
        }

        return { node, score }
      })
      .filter((item: any) => item.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 20)

    const matchedNodes = scoredNodes.map((s: any) => s.node)

    // 找关联边（O(n+m) 使用 Set）
    const matchedIds = new Set(matchedNodes.map((n: any) => n.id))
    const matchedEdges = (graph.edges || []).filter((edge: any) =>
      matchedIds.has(edge.from) || matchedIds.has(edge.to)
    ).slice(0, 30)

    // 构造上下文（按相关性排序）
    const context = scoredNodes.map(({ node: n, score }: any) =>
      `[${n.kind || 'node'}] ${n.name || n.id} (score:${score}) — ${n.file || 'N/A'}:${n.line || '?'}\n  ${n.summary || ''}`
    ).join('\n')

    const edgeContext = matchedEdges.map((e: any) =>
      `${e.from} → ${e.to} (${e.type || 'relates'})`
    ).join('\n')

    const prompt = `Based on the following knowledge graph data, answer the question.

Question: ${question}

Relevant nodes (${matchedNodes.length}, sorted by relevance):
${context || '(no matching nodes)'}

Relevant relationships (${matchedEdges.length}):
${edgeContext || '(no relationships)'}

Provide a concise answer with file:line references.`

    const answer = await this.callAgentWithTimeout(prompt, 'You are a code knowledge assistant. Answer questions about the codebase using the provided knowledge graph data. Include file:line references in your answer.')

    // 提取引用来源（带实际相关性分数）
    const sources: { file: string; line: number; relevance: number }[] = scoredNodes
      .filter(({ node: n }: any) => n.file)
      .map(({ node: n, score }: any) => ({ file: n.file, line: n.line || 0, relevance: score }))

    return { answer, sources }
  }

  /**
   * 启动浏览器 Dashboard
   */
  async startDashboard(port?: number): Promise<{ url: string; port: number }> {
    const status = await this.getGraphStatus()
    if (!status.exists) {
      throw new GrokError(
        'GRAPH_NOT_FOUND',
        'dashboard',
        '知识图谱未生成，请先执行 /grok',
        true
      )
    }

    // 关闭之前的 Dashboard 实例
    if (this.dashboardServer) {
      this.dashboardServer.closeAllConnections()
      this.dashboardServer.close()
      this.dashboardServer = null
    }

    const actualPort = port || await this.findAvailablePort()
    const token = Math.random().toString(36).slice(2)

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${actualPort}`)

      // 健康检查端点（不需要 token）
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          graphExists: existsSync(resolve(this.projectRoot, GROK_GRAPH_FILE)),
        }))
        return
      }

      // 验证 token
      if (url.searchParams.get('token') !== token) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      // 提供图谱数据
      if (url.pathname === '/api/graph') {
        const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)
        try {
          const data = readFileSync(graphPath, 'utf-8')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(data)
        } catch {
          res.writeHead(404)
          res.end('Graph not found')
        }
        return
      }

      // 提供 Dashboard HTML
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(this.getDashboardHtml(actualPort, token))
    })

    this.dashboardServer = server

    return new Promise((resolve_, reject) => {
      server.listen(actualPort, '127.0.0.1', () => {
        const url = `http://localhost:${actualPort}/dashboard?token=${token}`
        logForDebugging(`[grok] Dashboard started at ${url}`)

        openBrowser(url)

        // 30 分钟后自动关闭
        setTimeout(() => {
          server.close()
          this.dashboardServer = null
          logForDebugging(`[grok] Dashboard auto-closed after 30 minutes`)
        }, 30 * 60 * 1000)

        resolve_({ url, port: actualPort })
      })

      server.on('error', reject)
    })
  }

  /**
   * 查找可用端口
   */
  private async findAvailablePort(): Promise<number> {
    const PORT_RANGE = { min: 63000, max: 63100 }

    for (let port = PORT_RANGE.min; port <= PORT_RANGE.max; port++) {
      try {
        await new Promise<void>((resolve_, reject) => {
          const server = createServer()
          server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve_())
          })
          server.on('error', reject)
        })
        return port
      } catch {
        continue
      }
    }
    throw new GrokError(
      'NO_AVAILABLE_PORT',
      'dashboard',
      `No available port in range ${PORT_RANGE.min}-${PORT_RANGE.max}`,
      false
    )
  }

  /**
   * 生成 Dashboard HTML（内嵌 D3.js 可视化）
   */
  private getDashboardHtml(port: number, token: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>Grok 代码知识图谱</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a1a; color: #fff; }
    #graph { width: 100vw; height: 100vh; }
    .node { cursor: pointer; }
    .node circle { fill: #4ecca3; stroke: #fff; stroke-width: 1.5px; }
    .node text { font-size: 12px; fill: #fff; }
    .link { stroke: #333; stroke-opacity: 0.6; }
    #info { position: fixed; top: 20px; right: 20px; background: #1a1a2e; padding: 20px; border-radius: 8px; width: 300px; }
    h3 { margin: 0 0 10px; color: #4ecca3; }
  </style>
</head>
<body>
  <div id="graph"></div>
  <div id="info">
    <h3>Grok 代码知识图谱</h3>
    <p>点击节点查看详情</p>
  </div>
  <script>
    const port = ${port};
    const token = '${token}';

    fetch(\`http://localhost:\${port}/api/graph?token=\${token}\`)
      .then(r => r.json())
      .then(data => {
        const width = window.innerWidth;
        const height = window.innerHeight;

        const svg = d3.select('#graph')
          .append('svg')
          .attr('width', width)
          .attr('height', height);

        const simulation = d3.forceSimulation(data.nodes)
          .force('link', d3.forceLink(data.edges).id(d => d.id))
          .force('charge', d3.forceManyBody().strength(-100))
          .force('center', d3.forceCenter(width / 2, height / 2));

        const link = svg.append('g')
          .selectAll('line')
          .data(data.edges)
          .join('line')
          .attr('class', 'link');

        const node = svg.append('g')
          .selectAll('g')
          .data(data.nodes)
          .join('g')
          .attr('class', 'node')
          .call(d3.drag()
            .on('start', (event, d) => {
              if (!event.active) simulation.alphaTarget(0.3).restart();
              d.fx = d.x; d.fy = d.y;
            })
            .on('drag', (event, d) => {
              d.fx = event.x; d.fy = event.y;
            })
            .on('end', (event, d) => {
              if (!event.active) simulation.alphaTarget(0);
              d.fx = null; d.fy = null;
            })
          );

        node.append('circle').attr('r', 8);
        node.append('text').text(d => d.name || d.id).attr('x', 12).attr('y', 4);

        const esc = (s) => { const el = document.createElement('span'); el.textContent = s; return el.innerHTML; };
        node.on('click', (event, d) => {
          document.getElementById('info').innerHTML = \`
            <h3>\${esc(d.name || d.id)}</h3>
            <p><strong>类型:</strong> \${esc(d.kind || 'unknown')}</p>
            <p><strong>文件:</strong> \${esc(d.file || 'N/A')}</p>
            <p><strong>行号:</strong> \${esc(String(d.line || 'N/A'))}</p>
            <p>\${esc(d.summary || '')}</p>
          \`;
        });

        simulation.on('tick', () => {
          link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
              .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
          node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
        });
      })
      .catch(err => {
        const esc = (s) => { const el = document.createElement('span'); el.textContent = s; return el.innerHTML; };
        document.getElementById('info').innerHTML = '<h3>加载失败</h3><p>' + esc(err.message) + '</p>';
      });
  </script>
</body>
</html>`
  }

  /**
   * 检查图谱状态
   */
  async getGraphStatus(): Promise<GrokGraphStatus> {
    const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)

    try {
      const content = readFileSync(graphPath, 'utf-8')
      const graph = JSON.parse(content)

      const lastUpdated = graph.metadata?.lastUpdated
      const stale = lastUpdated
        ? Date.now() - new Date(lastUpdated).getTime() > 24 * 60 * 60 * 1000
        : true

      return {
        exists: true,
        nodeCount: graph.nodes?.length || 0,
        edgeCount: graph.edges?.length || 0,
        lastUpdated,
        stale,
      }
    } catch {
      return { exists: false }
    }
  }
}

// 导出单例
export const grokManager = new GrokManager()
