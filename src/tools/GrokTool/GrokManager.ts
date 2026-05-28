// src/tools/GrokTool/GrokManager.ts

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { execSync } from 'child_process'
import { createServer } from 'http'
import { resolve } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod/v4'
import { openBrowser } from '../../utils/browser.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'

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

export interface GrokError {
  agent: string           // 失败的 Agent 名称
  stage: string           // 失败阶段
  message: string
  recoverable: boolean    // 是否可恢复
  suggestion?: string     // 建议操作
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
  private projectRoot: string
  private vendorDir: string
  private config: GrokConfig

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || getCwd()
    this.vendorDir = GROK_VENDOR_DIR.replace('~', process.env.HOME || '~')
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
          { stdio: 'pipe' }
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
      execSync('git pull', { cwd: sourceDir, stdio: 'pipe' })
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
  private readonly PARSE_TIMEOUT = 10_000  // 文件解析超时 10 秒

  private client: Anthropic | null = null
  private model: string = 'claude-sonnet-4-20250514'

  /**
   * 获取或创建 Anthropic 客户端（惰性初始化）
   */
  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic()
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
    return Promise.race([
      this.callAgent(prompt, systemPrompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new GrokError(
          'LLM_TIMEOUT',
          'agent',
          'LLM call timed out after 30s',
          true,
          'Try with smaller scope or check API status'
        )), this.LLM_TIMEOUT)
      )
    ])
  }

  /**
   * 带超时的文件解析
   */
  private async parseWithTimeout<T>(fn: () => T, fileName: string): Promise<T> {
    return Promise.race([
      Promise.resolve(fn()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new GrokError(
          'PARSE_TIMEOUT',
          'parse',
          `Parsing ${fileName} timed out after 10s`,
          true,
          'File too large, use --exclude to skip'
        )), this.PARSE_TIMEOUT)
      )
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
      const batchResults = await Promise.all(
        parallelBatches.map(batch =>
          this.callAgentWithTimeout(
            this.buildFileAnalyzerPrompt(batch),
            AGENT_SYSTEM_PROMPTS.analyzer
          )
        )
      )
      results.push(...batchResults.flatMap(r => this.parseAnalysisResult(r)))
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
   * 解析分析结果
   */
  private parseAnalysisResult(result: string): any[] {
    try {
      const parsed = JSON.parse(result)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      logForDebugging(`[grok] Failed to parse analysis result: ${result.slice(0, 200)}`)
      return []
    }
  }

  /**
   * 运行 Agent 流水线生成知识图谱
   */
  async runAgentPipeline(options: GrokGenerateOptions): Promise<GrokGenerateResult> {
    // TODO: 实现 Agent 流水线
    throw new Error('Not implemented')
  }

  /**
   * 查询已生成的知识图谱
   */
  async queryGraph(question: string): Promise<GrokChatResult> {
    // TODO: 实现图谱查询
    throw new Error('Not implemented')
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

    return new Promise((resolve_, reject) => {
      server.listen(actualPort, '127.0.0.1', () => {
        const url = `http://localhost:${actualPort}/dashboard?token=${token}`
        logForDebugging(`[grok] Dashboard started at ${url}`)

        openBrowser(url)

        // 30 分钟后自动关闭
        setTimeout(() => {
          server.close()
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

        node.on('click', (event, d) => {
          document.getElementById('info').innerHTML = \`
            <h3>\${d.name || d.id}</h3>
            <p><strong>类型:</strong> \${d.kind || 'unknown'}</p>
            <p><strong>文件:</strong> \${d.file || 'N/A'}</p>
            <p><strong>行号:</strong> \${d.line || 'N/A'}</p>
            <p>\${d.summary || ''}</p>
          \`;
        });

        simulation.on('tick', () => {
          link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
              .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
          node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
        });
      })
      .catch(err => {
        document.getElementById('info').innerHTML = '<h3>加载失败</h3><p>' + err.message + '</p>';
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
