// src/tools/GrokTool/GrokManager.ts
// Facade class — coordinates GrokAnalyzer, GrokAssembler, GrokTourBuilder

import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { createServer } from 'http'
import { homedir } from 'os'
import { extname, join, resolve } from 'path'
import { z } from 'zod/v4'
import { openBrowser } from '../../utils/browser.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { GrokAnalyzer, AGENT_SYSTEM_PROMPTS } from './GrokAnalyzer.js'
import { GrokAssembler } from './GrokAssembler.js'
import { GrokTourBuilder } from './GrokTourBuilder.js'

// Re-export types and errors from GrokTypes for backward compatibility
export {
  type GrokGenerateOptions,
  type GrokGenerateResult,
  type GrokChatResult,
  type GrokGraphStatus,
  type GraphNode,
  type GraphEdge,
  type GraphData,
  GrokError,
  ERROR_SUGGESTIONS,
} from './GrokTypes.js'

// Import types for internal use
import type { GrokGenerateOptions, GrokGenerateResult, GrokChatResult, GrokGraphStatus, GraphNode, GraphData } from './GrokTypes.js'
import { GrokError } from './GrokTypes.js'

// ============================================================
// Constants
// ============================================================

const GROK_VENDOR_DIR = join(homedir(), '.ola-cc', 'vendor', 'grok')
const GROK_GRAPH_FILE = '.understand-anything/knowledge-graph.json'

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
// GrokManager Class (Facade)
// ============================================================

export class GrokManager {
  private pipelineLock: Promise<void> | null = null
  private _projectRoot: string | null
  private config: GrokConfig
  private dashboardServer: ReturnType<typeof createServer> | null = null
  private dashboardTimer: NodeJS.Timeout | null = null

  // Sub-modules
  private analyzer: GrokAnalyzer
  private assembler: GrokAssembler
  private tourBuilder: GrokTourBuilder

  /** 惰性获取 projectRoot，适配 worktree 切换 */
  private get projectRoot(): string {
    return this._projectRoot || getCwd()
  }

  constructor(projectRoot?: string) {
    this._projectRoot = projectRoot || null
    this.config = loadGrokConfig()

    const root = this.projectRoot
    this.analyzer = new GrokAnalyzer(root, GROK_VENDOR_DIR)
    this.assembler = new GrokAssembler(root)
    this.tourBuilder = new GrokTourBuilder(this.analyzer)

    logForDebugging(`[grok] Config loaded: ${JSON.stringify(this.config)}`)
  }

  // ============================================================
  // Source management (delegated to GrokAnalyzer)
  // ============================================================

  /**
   * 确保 Grok 源码已克隆（带重试）
   */
  async ensureGrokSource(): Promise<string> {
    return this.analyzer.ensureGrokSource()
  }

  /**
   * 更新 Grok 源码
   */
  async updateGrokSource(): Promise<void> {
    return this.analyzer.updateGrokSource()
  }

  // ============================================================
  // Pipeline orchestration
  // ============================================================

  /**
   * 运行 Agent 流水线生成知识图谱
   */
  async runAgentPipeline(options: GrokGenerateOptions): Promise<GrokGenerateResult> {
    // 原子化互斥锁：先捕获当前锁，再创建新锁，确保 check-and-set 原子性
    const prevLock = this.pipelineLock
    let releaseLock: () => void
    this.pipelineLock = new Promise<void>(resolve => { releaseLock = resolve })

    // 等待上一次 pipeline 完成（如果有的话）
    if (prevLock) {
      logForDebugging('[grok] Pipeline already running, waiting...')
      await prevLock
    }

    try {
      return await this.runPipelineInner(options)
    } finally {
      releaseLock!()
      this.pipelineLock = null
    }
  }

  /**
   * 本地文件系统扫描 — 替代 LLM scanner 步骤
   * 从文件扩展名检测语言，从 package.json 检测框架，从常见模式检测入口点
   */
  private localScan(files: string[]): { languages: string[]; frameworks: string[]; entryPoints: string[] } {
    // --- Language detection from file extensions ---
    const EXT_TO_LANG: Record<string, string> = {
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.js': 'JavaScript',
      '.jsx': 'JavaScript',
      '.py': 'Python',
      '.go': 'Go',
      '.rs': 'Rust',
      '.java': 'Java',
      '.cpp': 'C++',
      '.c': 'C',
      '.h': 'C/C++',
      '.hpp': 'C++',
      '.rb': 'Ruby',
      '.php': 'PHP',
      '.swift': 'Swift',
      '.kt': 'Kotlin',
      '.vue': 'Vue',
      '.svelte': 'Svelte',
    }

    const langSet = new Set<string>()
    for (const f of files) {
      const ext = extname(f).toLowerCase()
      const lang = EXT_TO_LANG[ext]
      if (lang) langSet.add(lang)
    }

    // --- Framework detection from package.json ---
    const frameworkSet = new Set<string>()
    const PKG_DEP_TO_FRAMEWORK: Record<string, string> = {
      react: 'React',
      'react-dom': 'React',
      'react-native': 'React Native',
      vue: 'Vue',
      '@angular/core': 'Angular',
      svelte: 'Svelte',
      next: 'Next.js',
      nuxt: 'Nuxt',
      express: 'Express',
      fastify: 'Fastify',
      koa: 'Koa',
      nestjs: 'NestJS',
      '@nestjs/core': 'NestJS',
      hono: 'Hono',
      drizzle: 'Drizzle ORM',
      prisma: 'Prisma',
      '@prisma/client': 'Prisma',
      typeorm: 'TypeORM',
      sequelize: 'Sequelize',
      mongoose: 'Mongoose',
      tailwindcss: 'Tailwind CSS',
      vite: 'Vite',
      webpack: 'Webpack',
      esbuild: 'esbuild',
      bun: 'Bun',
    }

    const pkgPath = join(this.projectRoot, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
        const allDeps: Record<string, string> = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        }
        for (const dep of Object.keys(allDeps)) {
          const fw = PKG_DEP_TO_FRAMEWORK[dep]
          if (fw) frameworkSet.add(fw)
        }
      } catch {
        // Malformed package.json — skip framework detection
      }
    }

    // --- Entry point detection from common patterns ---
    const ENTRY_BASENAMES = new Set([
      'index.ts', 'index.tsx', 'index.js', 'index.jsx',
      'main.ts', 'main.tsx', 'main.js', 'main.jsx',
      'main.py', '__main__.py',
      'main.go',
      'main.rs',
      'Main.java',
      'app.ts', 'app.tsx', 'app.js', 'app.jsx',
      'server.ts', 'server.tsx', 'server.js', 'server.jsx',
    ])

    const ENTRY_PATTERNS = [
      /^src[\\/]main\./,
      /^src[\\/]index\./,
      /^src[\\/]app\./,
      /^cmd[\\/]/,
      /^cmd[\\/].*[\\/]main\.go$/,
    ]

    const entryPoints: string[] = []
    for (const f of files) {
      const rel = f.slice(this.projectRoot.length).replace(/^[/\\]/, '')
      const basename = rel.split(/[\\/]/).pop() || ''
      if (ENTRY_BASENAMES.has(basename)) {
        entryPoints.push(f)
      } else {
        for (const pattern of ENTRY_PATTERNS) {
          if (pattern.test(rel)) {
            entryPoints.push(f)
            break
          }
        }
      }
    }

    return {
      languages: [...langSet],
      frameworks: [...frameworkSet],
      entryPoints,
    }
  }

  private async runPipelineInner(options: GrokGenerateOptions): Promise<GrokGenerateResult> {
    const errors: GrokError[] = []
    const reportProgress = options.onProgress || (() => {})
    const startTime = Date.now()
    const isIncremental = options.incremental !== false

    // Step 1: 发现文件
    reportProgress('scanner', 0)
    const files = await this.analyzer.discoverFiles(options.path, options.scope)
    if (files.length === 0) {
      return { status: 'failed', nodeCount: 0, edgeCount: 0, domainCount: 0, filePath: '', errors: [new GrokError('NO_FILES', 'scanner', 'No source files found', false)] }
    }

    // 增量模式：检测变更（不提前删除节点，延迟到 assembleGraph 阶段）
    let existingGraph: GraphData | null = null
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
          changes = this.analyzer.detectChanges(files, storedFps)

          // 无变更 → 直接返回现有图谱统计
          if (changes.changed.length === 0 && changes.added.length === 0 && changes.removed.length === 0) {
            logForDebugging('[grok] Incremental: no changes detected, skipping')
            return {
              status: 'success',
              nodeCount: existingGraph.nodes?.length || 0,
              edgeCount: existingGraph.edges?.length || 0,
              domainCount: new Set(existingGraph.nodes?.map((n: GraphNode) => n.layer).filter(Boolean)).size,
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
                changes = this.analyzer.detectChanges(files, storedFps)
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

    // Step 2: Local Scanner — 语言和框架检测（本地文件系统检测，无需 LLM）
    reportProgress('scanner', 0)
    let scannerResult: Record<string, unknown> = {}
    if (isIncrementalRun && existingGraph?.metadata) {
      scannerResult = {
        languages: existingGraph.metadata.languages || [],
        frameworks: existingGraph.metadata.frameworks || [],
      }
    } else {
      scannerResult = this.localScan(files)
    }
    reportProgress('scanner', 100)

    // Step 3: File Analyzer Agent — 批量并行分析（增量模式只分析变更文件）
    reportProgress('analyzer', 0)
    let analysisResults: Record<string, unknown>[] = []
    try {
      analysisResults = await this.analyzer.analyzeFilesBatch(filesToAnalyze)
      reportProgress('analyzer', 100)
    } catch (error) {
      errors.push(error instanceof GrokError ? error : new GrokError('ANALYZER_FAILED', 'analyzer', String(error), true))
      reportProgress('analyzer', 100)
    }

    // Step 4: Architecture Agent — 架构层分析（增量模式：变更 <20% 文件时复用已有架构）
    let architectureResult: Record<string, unknown> = {}
    if (isIncrementalRun && existingGraph?.metadata && filesToAnalyze.length < files.length * 0.2) {
      architectureResult = { layers: existingGraph.metadata.layers?.map((l: string) => ({ name: l, modules: [] })) || [], dependencies: [] }
      logForDebugging('[grok] Incremental: reusing existing architecture analysis')
      reportProgress('architecture', 100)
    } else {
      const languages = Array.isArray(scannerResult.languages) ? scannerResult.languages.join(', ') : 'unknown'
      const frameworks = Array.isArray(scannerResult.frameworks) ? scannerResult.frameworks.join(', ') : 'unknown'
      architectureResult = await this.analyzer.runPipelineStep('architecture',
        `Analyze the architecture of this project.\n\nFiles: ${files.length}\nLanguages: ${languages}\nFrameworks: ${frameworks}\n\nSample modules:\n${files.slice(0, 30).map(f => `- ${f}`).join('\n')}`,
        AGENT_SYSTEM_PROMPTS.architecture, reportProgress, errors
      )
    }

    // Step 5: Tour Builder — 学习路径（增量模式复用已有 tour）
    let tourResult: Record<string, unknown> = {}
    if (isIncrementalRun && existingGraph?.metadata?.tour) {
      tourResult = { tours: existingGraph.metadata.tour }
      logForDebugging('[grok] Incremental: reusing existing tour')
      reportProgress('tour', 100)
    } else {
      tourResult = await this.analyzer.runPipelineStep('tour',
        `Create learning tours for this project.\n\nFiles: ${files.length}\nLayers: ${JSON.stringify(architectureResult.layers || [])}`,
        AGENT_SYSTEM_PROMPTS.tour, reportProgress, errors
      )
    }

    // Step 6: Graph Reviewer — 质量审查（增量模式跳过，复用已有 review）
    let reviewResult: Record<string, unknown> = {}
    if (isIncrementalRun && existingGraph?.metadata?.review) {
      reviewResult = existingGraph.metadata.review as Record<string, unknown>
      logForDebugging('[grok] Incremental: reusing existing review')
      reportProgress('review', 100)
    } else {
      const nodeCount = analysisResults.length
      const deps = architectureResult.dependencies as unknown[] | undefined
      const edgeCount = deps?.length || 0
      reviewResult = await this.analyzer.runPipelineStep('review',
        `Review this knowledge graph for completeness.\n\nNodes: ${nodeCount}\nEdges: ${edgeCount}\nLayers: ${JSON.stringify(architectureResult.layers || [])}`,
        AGENT_SYSTEM_PROMPTS.review, reportProgress, errors
      )
    }

    // Step 7: 组装并保存图谱（增量模式合并已有数据，延迟删除旧节点）
    const result = this.assembler.assembleGraph(
      files, scannerResult, analysisResults, architectureResult,
      tourResult, reviewResult, options.language || 'en', errors,
      isIncrementalRun ? existingGraph : undefined,
      isIncrementalRun ? changes : undefined
    )

    logForDebugging(`[grok] Pipeline completed in ${Date.now() - startTime}ms: ${result.nodeCount} nodes, ${result.edgeCount} edges`)
    return result
  }

  // ============================================================
  // Query (delegated to GrokTourBuilder)
  // ============================================================

  /**
   * 查询已生成的知识图谱
   */
  async queryGraph(question: string): Promise<GrokChatResult> {
    const status = await this.getGraphStatus()
    if (!status.exists) {
      throw new GrokError('GRAPH_NOT_FOUND', 'query', '知识图谱未生成，请先执行 /grok', true)
    }

    const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)
    let graph: GraphData
    try {
      graph = JSON.parse(readFileSync(graphPath, 'utf-8'))
    } catch (e) {
      throw new GrokError('GRAPH_INVALID', 'query', `知识图谱文件损坏: ${e instanceof Error ? e.message : String(e)}`, true, '建议执行 /grok --full 重新生成')
    }

    return this.tourBuilder.queryGraph(question, graph)
  }

  // ============================================================
  // Dashboard (kept in GrokManager)
  // ============================================================

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
    if (this.dashboardTimer) {
      clearTimeout(this.dashboardTimer)
      this.dashboardTimer = null
    }

    const actualPort = port || await this.findAvailablePort()
    const token = randomUUID()

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${actualPort}`)

      // 安全头：禁止 CORS 和外部引用
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Referrer-Policy', 'no-referrer')

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

      // 验证 token（同时检查 query param 和 Authorization header）
      const queryToken = url.searchParams.get('token')
      const authHeader = req.headers.authorization?.replace('Bearer ', '')
      if (queryToken !== token && authHeader !== token) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      // 提供图谱数据（仅允许 localhost）
      if (url.pathname === '/api/graph') {
        const origin = req.headers.origin || ''
        if (origin && !origin.startsWith('http://localhost:') && !origin.startsWith('http://127.0.0.1:')) {
          res.writeHead(403)
          res.end('CORS not allowed')
          return
        }
        const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)
        try {
          const data = readFileSync(graphPath, 'utf-8')
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': `http://localhost:${actualPort}`,
          })
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
        if (this.dashboardTimer) clearTimeout(this.dashboardTimer)
        this.dashboardTimer = setTimeout(() => {
          server.close()
          this.dashboardServer = null
          this.dashboardTimer = null
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

  // ============================================================
  // Status (kept in GrokManager)
  // ============================================================

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
