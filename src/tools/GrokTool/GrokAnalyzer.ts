// src/tools/GrokTool/GrokAnalyzer.ts
// File discovery + LLM batch analysis + two-phase optimization

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import { homedir } from 'os'
import { extname, join, resolve } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { logForDebugging } from '../../utils/debug.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { GrokError, type GraphData } from './GrokTypes.js'
import { computeFileFingerprint } from './GrokAssembler.js'

// ============================================================
// Constants + Agent system prompts
// ============================================================

const GROK_VENDOR_DIR = join(homedir(), '.ola-cc', 'vendor', 'grok')

export const AGENT_SYSTEM_PROMPTS = {
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
// GrokAnalyzer Class
// ============================================================

export class GrokAnalyzer {
  private vendorDir: string
  private projectRoot: string
  private LLM_TIMEOUT = 30_000
  private client: Anthropic | null = null
  private model: string = 'claude-sonnet-4-20250514'

  constructor(projectRoot: string, vendorDir?: string) {
    this.projectRoot = projectRoot
    this.vendorDir = vendorDir || GROK_VENDOR_DIR
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

  // ============================================================
  // Source management
  // ============================================================

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

    // 本地不存在时不阻塞下载，后台尝试 clone，失败也不影响核心功能
    logForDebugging(`[grok] Source not found at ${sourceDir}, attempting background clone`)
    console.error(`[grok] Source not found at ${sourceDir}`)
    this.cloneGrokSourceInBackground(sourceDir)

    // 返回 sourceDir 即使还不存在，调用方如果依赖文件会自行处理
    return sourceDir
  }

  /**
   * 后台克隆 Understand-Anything 仓库，不阻塞 TUI
   */
  private cloneGrokSourceInBackground(sourceDir: string): void {
    mkdirSync(this.vendorDir, { recursive: true })

    // 后台异步运行，不 await
    this.retryWithBackoff(async () => {
      try {
        await execFileAsync('git', ['clone', '--depth', '1', 'https://github.com/Lum1104/Understand-Anything.git', sourceDir], {
          timeout: 120_000,
        })
        logForDebugging(`[grok] Background clone complete: ${sourceDir}`)
        console.error(`[grok] Understand-Anything cloned to ${sourceDir}`)
      } catch (error) {
        logForDebugging(`[grok] Background clone failed: ${error instanceof Error ? error.message : String(error)}`)
        console.error(`[grok] Clone failed. To use full Grok features, run manually:
  git clone --depth 1 https://github.com/Lum1104/Understand-Anything.git "${sourceDir}"`)
      }
    }).catch(() => {
      // 后台失败不抛出——核心功能继续
    })
  }

  /**
   * 更新 Grok 源码
   */
  async updateGrokSource(): Promise<void> {
    const sourceDir = resolve(this.vendorDir, 'understand-anything')

    if (!existsSync(sourceDir)) {
      logForDebugging(`[grok] Update skipped: source not found at ${sourceDir}`)
      console.error(`[grok] Source not found, run manually:
  git clone --depth 1 https://github.com/Lum1104/Understand-Anything.git "${sourceDir}"`)
      return
    }

    logForDebugging(`[grok] Updating source at ${sourceDir}`)
    console.error(`[grok] Updating Understand-Anything at ${sourceDir}...`)
    try {
      await execFileAsync('git', ['pull'], { cwd: sourceDir, timeout: 60_000 })
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
        // 非直连 provider：当前 Grok 的轻量调用不支持这些 provider
        // 降级为直连模式，用户需确保 ANTHROPIC_API_KEY 可用
        logForDebugging(`[grok] Provider ${provider} detected but Grok uses direct API. Falling back to firstParty.`)
        this.client = new Anthropic()
      } else {
        this.client = new Anthropic()
      }
    }
    // 每次调用刷新 model，支持运行时切换
    this.model = process.env.ANTHROPIC_MODEL || process.env.OLA_CC_MODEL_SONNET || 'claude-sonnet-4-20250514'
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
   * 带超时的 Agent 调用（public for GrokTourBuilder）
   */
  async callAgentWithTimeout(prompt: string, systemPrompt: string): Promise<string> {
    // 先创建超时 Promise 并捕获 timer 引用，确保 finally 中可清理
    let timer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GrokError(
        'LLM_TIMEOUT',
        'agent',
        'LLM call timed out after 30s',
        true,
        'Try with smaller scope or check API status'
      )), this.LLM_TIMEOUT)
    })

    try {
      return await Promise.race([
        this.callAgent(prompt, systemPrompt),
        timeoutPromise,
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
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
      } catch (e) {
        // 跳过无权限的目录，记录警告
        logForDebugging(`[grok] Skipping directory (permission denied): ${dir} — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    walk(basePath)
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
    batchSize: number = 25,
    maxParallel: number = 5
  ): Promise<Record<string, unknown>[]> {
    // 内联 chunkArray
    const batches: string[][] = []
    for (let i = 0; i < files.length; i += batchSize) {
      batches.push(files.slice(i, i + batchSize))
    }

    const results: Record<string, unknown>[] = []

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
   * 清理文件路径，防止 LLM 提示注入
   * 用反引号包裹路径，转义内部反引号
   */
  sanitizeFilePath(path: string): string {
    return '`' + path.replace(/`/g, '\\`') + '`'
  }

  /**
   * 构建 file-analyzer 提示词
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
      const preview = result.slice(0, 200)
      logForDebugging(`[grok] Failed to parse analysis result: ${preview}`)
      console.warn(`[grok] Warning: LLM returned non-JSON response, skipping batch. Preview: ${preview}`)
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
    errors: GrokError[]
  ): Promise<Record<string, unknown>> {
    reportProgress(stage, 0)
    try {
      const response = await this.callAgentWithTimeout(prompt, systemPrompt)
      const result = this.parseAnalysisResult(response)[0] || {}
      reportProgress(stage, 100)
      return result
    } catch (error) {
      const code = `${stage.toUpperCase()}_FAILED`
      errors.push(error instanceof GrokError ? error : new GrokError(code, stage, String(error), true))
      reportProgress(stage, 100)
      return {}
    }
  }
}
