// src/tools/GrokTool/GrokManager.ts
// Facade class — coordinates GrokAnalyzer, GrokAssembler, GrokTourBuilder

import { randomUUID } from 'crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, copyFileSync, mkdirSync } from 'fs'
import { atomicWriteJson } from './atomicSave.js'
import { createServer } from 'http'
import { homedir } from 'os'
import { extname, join, relative, resolve } from 'path'
import { z } from 'zod/v4'
import { openBrowser } from '../../utils/browser.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { GrokAnalyzer, AGENT_SYSTEM_PROMPTS } from './GrokAnalyzer.js'
import { GrokAssembler } from './GrokAssembler.js'
import { GrokTourBuilder } from './GrokTourBuilder.js'
import { GraphStore, type NodeMetadata, type EdgeMeta } from '../../services/graph/GraphStore.js'
import { GraphEngine } from '../../services/graph/GraphEngine.js'
import { type GraphNode, type GraphEdge, type GraphData, type GrokGenerateOptions, type GrokGenerateResult, type GrokChatResult, type GrokGraphStatus, GrokError, ERROR_SUGGESTIONS } from './GrokTypes.js'

// Re-export for backward compatibility
export { GrokError, ERROR_SUGGESTIONS }

// ============================================================
// Graph operation result types
// ============================================================

export interface ArchitectureResult {
  communities: Array<{ id: number; size: number; name: string; sample: string[] }>
  modularity: number
  resolution: number
  totalCommunities: number
  roles: { distribution: Record<string, number>; totalNodes: number }
  llmSummary: string
}

export interface HotspotResult {
  hotspots: Array<{ node: string; score: number; meta: unknown }>
  totalScored: number
  temporalCoupling: {
    pairs: Array<{ a: string; b: string; score: number; coChanges: number }>
    window: { since: string; until: string }
  }
  llmSummary: string
}

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
  batchSize: z.number().int().min(1).max(50).default(10),
  concurrency: z.number().int().min(1).max(10).default(3),
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
    batchSize: process.env.OLA_CC_GROK_BATCH_SIZE ? parseInt(process.env.OLA_CC_GROK_BATCH_SIZE) : undefined,
    concurrency: process.env.OLA_CC_GROK_CONCURRENCY ? parseInt(process.env.OLA_CC_GROK_CONCURRENCY) : undefined,
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
    // Pass GraphStore so GrokAnalyzer can use AST metadata (two-phase optimization)
    // instead of sending full file contents to LLM
    const graphStore = GraphStore.getInstance(root)
    this.analyzer = new GrokAnalyzer(root, GROK_VENDOR_DIR, graphStore)
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

    // Python framework detection from requirements.txt / pyproject.toml
    const PYTHON_DEP_TO_FRAMEWORK: Record<string, string> = {
      django: 'Django', flask: 'Flask', fastapi: 'FastAPI', starlette: 'Starlette',
      tornado: 'Tornado', pyramid: 'Pyramid', sanic: 'Sanic', aiohttp: 'aiohttp',
      celery: 'Celery', pytest: 'pytest', numpy: 'NumPy', pandas: 'pandas',
      tensorflow: 'TensorFlow', torch: 'PyTorch', 'scikit-learn': 'scikit-learn',
      sqlalchemy: 'SQLAlchemy', pydantic: 'Pydantic', click: 'Click',
    }
    for (const reqFile of ['requirements.txt', 'pyproject.toml']) {
      const reqPath = join(this.projectRoot, reqFile)
      if (existsSync(reqPath)) {
        try {
          const content = readFileSync(reqPath, 'utf-8')
          // Parse dependency sections only (not comments or descriptions)
          const lines = content.split('\n')
          let inDepSection = reqFile === 'requirements.txt'
          for (const line of lines) {
            const trimmed = line.trim()
            if (reqFile === 'pyproject.toml') {
              if (/^\[.*dependencies/i.test(trimmed)) { inDepSection = true; continue }
              if (/^\[/.test(trimmed)) { inDepSection = false; continue }
            }
            if (!inDepSection || !trimmed || trimmed.startsWith('#')) continue
            // Extract package name: strip version specifiers, extras, env markers
            const pkgName = trimmed.split(/[>=<!\[\s;@]/)[0].toLowerCase().replace(/_/g, '-')
            const fw = PYTHON_DEP_TO_FRAMEWORK[pkgName]
            if (fw) frameworkSet.add(fw)
          }
        } catch { /* skip */ }
      }
    }

    // Go framework detection from go.mod
    const goModPath = join(this.projectRoot, 'go.mod')
    if (existsSync(goModPath)) {
      try {
        const content = readFileSync(goModPath, 'utf-8')
        const GO_DEP_TO_FRAMEWORK: Record<string, string> = {
          'github.com/gin-gonic/gin': 'Gin',
          'github.com/gofiber/fiber': 'Fiber',
          'github.com/labstack/echo': 'Echo',
          'github.com/gorilla/mux': 'Gorilla Mux',
        }
        for (const [dep, fw] of Object.entries(GO_DEP_TO_FRAMEWORK)) {
          if (content.includes(dep)) frameworkSet.add(fw)
        }
      } catch { /* skip */ }
    }

    // Rust framework detection from Cargo.toml
    const cargoPath = join(this.projectRoot, 'Cargo.toml')
    if (existsSync(cargoPath)) {
      try {
        const content = readFileSync(cargoPath, 'utf-8')
        const RUST_DEP_TO_FRAMEWORK: Record<string, string> = {
          actix: 'Actix', axum: 'Axum', rocket: 'Rocket', warp: 'Warp',
          tokio: 'Tokio', serde: 'Serde', diesel: 'Diesel', sqlx: 'SQLx',
        }
        for (const [dep, fw] of Object.entries(RUST_DEP_TO_FRAMEWORK)) {
          if (content.toLowerCase().includes(dep)) frameworkSet.add(fw)
        }
      } catch { /* skip */ }
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
      /^cmd[\\/].*[\\/]main\.go$/,
    ]

    const entryPoints: string[] = []
    for (const f of files) {
      const rel = relative(this.projectRoot, f)
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

  // ============================================================
  // Graph-first extraction (bypass LLM for structural data)
  // ============================================================

  /**
   * 从 GraphStore 提取 Top N 核心文件（基于 PageRank）
   * PageRank 考虑边的方向和权重，比度中心性更精确地反映文件重要性
   */
  private extractTopFiles(store: GraphStore, maxFiles: number): string[] {
    // Use PageRank via GraphEngine for importance ranking
    const engine = new GraphEngine(store)
    const pr = engine.pageRank(0.85, 50)

    // Aggregate node-level PageRank scores to file level
    const fileScores = new Map<string, number>()
    for (const { node: nodeId, score } of pr.scores) {
      const meta = store.getNode(nodeId)
      if (!meta?.file) continue
      const current = fileScores.get(meta.file) ?? 0
      fileScores.set(meta.file, current + score)
    }

    return [...fileScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxFiles)
      .map(([file]) => file)
  }

  /**
   * 从 GraphStore 直接提取节点和边，转换为 GrokAssembler 格式
   * 跳过 LLM 分析，直接使用 AST 元数据
   *
   * 内存开销：约 250MB（54K 节点 + 193K 边时），因为需要将整个图复制到
   * GraphNode[]/GraphEdge[] 数组。对于更大的项目，可能需要流式处理或分块提取。
   */
  private extractGraphStructure(store: GraphStore): { nodes: import('./GrokTypes.js').GraphNode[]; edges: import('./GrokTypes.js').GraphEdge[] } {
    const nodes: import('./GrokTypes.js').GraphNode[] = []
    const edges: import('./GrokTypes.js').GraphEdge[] = []
    const seenEdges = new Set<string>()

    // Extract nodes from GraphStore
    for (const [id, meta] of store.nodeMeta) {
      nodes.push({
        id,
        name: meta.name,
        kind: meta.kind,
        file: meta.file,
        line: meta.line,
        signature: meta.signature || '',
        summary: meta.docstring || '',
        layer: meta.layer || '',
        domain: meta.domain || '',
      })
    }

    // Extract edges from adjacency map
    for (const [from, targets] of store.adjacency) {
      for (const [to, edgeList] of targets) {
        for (const edge of edgeList) {
          const key = `${from}→${to}→${edge.type}`
          if (seenEdges.has(key)) continue
          seenEdges.add(key)
          edges.push({ from, to, type: edge.type })
        }
      }
    }

    return { nodes, edges }
  }

  /**
   * 原子写入图谱文件（先清理残留 .tmp，备份旧文件，写 .tmp 再 rename）
   * 与 GrokAssembler.saveGraph 逻辑一致，用于 enrichGraph 和 fallback 路径
   */
  private atomicSave(filePath: string, data: GraphData): void {
    atomicWriteJson(filePath, data, 'GrokManager')
  }

  /**
   * Enrich graph data in memory with community names and top-node summaries.
   * Operates on the graphData object directly (no disk read), then saves once.
   */
  private enrichGraph(graph: GraphData, result: GrokGenerateResult): GrokGenerateResult {
    const store = GraphStore.getInstance(this.projectRoot)
    const engine = new GraphEngine(store)

    // 8a: Community naming (pure local)
    const community = engine.louvainCommunity()
    const communityNames = this.generateCommunityNames(community.communities, store)

    // Apply community names to nodes — clone nodes to avoid mutating original graph
    const nodeToCommunity = new Map<string, number>()
    for (const comm of community.communities) {
      for (const nodeId of comm.nodes) {
        nodeToCommunity.set(nodeId, comm.id)
      }
    }

    let enrichedCount = 0
    const enrichedNodes = graph.nodes.map(node => {
      const commId = nodeToCommunity.get(node.id)
      if (commId !== undefined) {
        const commName = communityNames.get(commId)
        // 保留已有 domain（来自 LLM 语义分析），仅当 domain 为空时才用社区名填充
        // 这是有意设计：LLM 分析产生的 domain 比 Louvain 社区名更精确
        if (commName && !node.domain) {
          enrichedCount++
          // 同步更新内存中的 GraphStore nodeMeta（避免后续磁盘 round-trip）
          const meta = store.getNode(node.id)
          if (meta && !meta.domain) {
            store.updateNodeDomain(node.id, commName)
          }
          return { ...node, domain: commName }
        }
      }
      return node
    })

    // Atomic save with enriched data (original graph untouched)
    const enrichedGraph: GraphData = { ...graph, nodes: enrichedNodes }
    const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)
    this.atomicSave(graphPath, enrichedGraph)

    logForDebugging(`[grok] Enrichment: ${communityNames.size} community names, ${enrichedCount} nodes updated`)

    return { ...result, graphData: undefined }
  }

  /**
   * 从社区成员的文件路径推断社区名称（纯本地，无 LLM）
   */
  private generateCommunityNames(
    communities: Array<{ id: number; nodes: string[] }>,
    store: GraphStore,
  ): Map<number, string> {
    const names = new Map<number, string>()

    for (const comm of communities) {
      // Collect file paths for community members
      const files = comm.nodes
        .map(id => store.getNode(id)?.file ?? '')
        .filter(Boolean)

      if (files.length === 0) {
        names.set(comm.id, `Community-${comm.id}`)
        continue
      }

      // Find common directory prefix
      const parts = files.map(f => f.split('/'))
      const minLen = Math.min(...parts.map(p => p.length))
      const commonParts: string[] = []
      for (let i = 0; i < minLen - 1; i++) {
        const segment = parts[0][i]
        if (parts.every(p => p[i] === segment)) {
          commonParts.push(segment)
        } else break
      }

      // Use the deepest common directory as name
      if (commonParts.length > 0) {
        const dirName = commonParts[commonParts.length - 1]
        // Check if it's a generic name, try one level up
        const genericNames = new Set(['src', 'lib', 'dist', 'build', 'out', 'app', 'index'])
        if (genericNames.has(dirName) && commonParts.length > 1) {
          names.set(comm.id, commonParts[commonParts.length - 2])
        } else {
          names.set(comm.id, dirName)
        }
      } else {
        // No common directory — use most frequent directory
        const dirFreq = new Map<string, number>()
        for (const f of files) {
          const dir = f.split('/').slice(0, -1).join('/') || '.'
          dirFreq.set(dir, (dirFreq.get(dir) ?? 0) + 1)
        }
        const topDir = [...dirFreq.entries()].sort((a, b) => b[1] - a[1])[0]
        names.set(comm.id, topDir?.[0]?.split('/').pop() ?? `Community-${comm.id}`)
      }
    }

    return names
  }

  /**
   * 为 Top-N 重要节点生成语义摘要（可选 LLM 增强）
   * 仅在 graph-first 模式下，对缺少 summary 的高重要性节点生成摘要
   *
   * 注意：此方法当前未被调用（P0-3 重构后 pipeline 依赖 GraphStore 的 docstring 字段）。
   * 保留为 reserved：当 GraphStore 中节点缺少 docstring 且需要 LLM 增强摘要时可启用。
   * 要启用，在 enrichGraph() 中 Step 8a 之后调用此方法，将结果合并到 enrichedNodes。
   */
  private async generateTopNodeSummaries(
    store: GraphStore,
    engine: GraphEngine,
    opts?: { maxNodes?: number; onProgress?: (stage: string, pct: number) => void }
  ): Promise<Map<string, string>> {
    const maxNodes = opts?.maxNodes ?? 20
    const summaries = new Map<string, string>()

    // Use PageRank to find most important nodes
    const pr = engine.pageRank()
    const topNodes = pr.scores
      .slice(0, maxNodes * 2) // get extra in case some already have summaries
      .filter(s => {
        const meta = store.getNode(s.node)
        // Skip nodes that already have meaningful summaries
        const existing = meta?.docstring ?? ''
        return existing.length < 30 // only enrich nodes with short/missing summaries
      })
      .slice(0, maxNodes)

    if (topNodes.length === 0) return summaries

    // Collect source code snippets for top nodes
    const snippets: Array<{ nodeId: string; file: string; name: string; kind: string; code: string }> = []
    for (const { node: nodeId } of topNodes) {
      const meta = store.getNode(nodeId)
      if (!meta?.file) continue

      try {
        const absPath = join(this.projectRoot, meta.file)
        const content = readFileSync(absPath, 'utf-8')
        const lines = content.split('\n')
        // Extract function/class context (signature + first few lines of body)
        const startLine = Math.max(0, (meta.line ?? 1) - 1)
        const endLine = Math.min(lines.length, startLine + 30)
        const code = lines.slice(startLine, endLine).join('\n')
        snippets.push({ nodeId, file: meta.file, name: meta.name, kind: meta.kind, code })
      } catch {
        // File not readable — skip
      }
    }

    if (snippets.length === 0) return summaries

    // Batch generate summaries via LLM (if available)
    const prompt = `Analyze these code snippets and generate a ONE-LINE summary (max 100 chars) for each.
Focus on WHAT the function/class does, not HOW.
Return JSON array: [{"id": "nodeId", "summary": "one line summary"}]

${snippets.map((s, i) => `[${i}] ${s.kind} ${s.name} (${s.file}):\n${s.code.slice(0, 500)}`).join('\n\n---\n\n')}`

    try {
      const result = await this.analyzer.callAgentWithTimeout(prompt, 'You are a code analysis assistant. Return only valid JSON array. No explanations.')

      // Parse LLM response — robust JSON extraction handling markdown fences and nested brackets
      let parsed: Array<{ id: string; summary: string }> = []
      try {
        // 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
        let cleaned = result.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()

        // 2. Try direct JSON.parse on the whole response
        try {
          const direct = JSON.parse(cleaned)
          if (Array.isArray(direct)) parsed = direct
        } catch {
          // 3. Fallback: find outermost [...] with bracket counting
          const start = cleaned.indexOf('[')
          if (start !== -1) {
            let depth = 0
            let end = -1
            for (let i = start; i < cleaned.length; i++) {
              if (cleaned[i] === '[') depth++
              else if (cleaned[i] === ']') {
                depth--
                if (depth === 0) { end = i; break }
              }
            }
            if (end !== -1) {
              parsed = JSON.parse(cleaned.slice(start, end + 1))
            }
          }
        }
      } catch { /* LLM returned unparseable JSON — skip */ }

      for (const item of parsed) {
        if (item.id && item.summary && item.summary.length > 5) {
          summaries.set(item.id, item.summary.slice(0, 150))
        }
      }
    } catch {
      // LLM not available — return empty summaries (graceful degradation)
    }

    return summaries
  }

  private async runPipelineInner(options: GrokGenerateOptions): Promise<GrokGenerateResult> {
    const errors: GrokError[] = []
    const reportProgress = options.onProgress || (() => {})
    const startTime = Date.now()
    const isIncremental = options.incremental !== false

    // Pre-load GraphStore for graph-first analysis
    // When available, extract structure directly from AST metadata (no LLM needed)
    let graphStoreLoaded = false
    let graphStore: GraphStore | undefined
    try {
      graphStore = GraphStore.getInstance(this.projectRoot)
      await graphStore.load()
      graphStoreLoaded = graphStore.nodeMeta.size > 0
      logForDebugging(`[grok] GraphStore loaded: ${graphStore.nodeMeta.size} nodes, graph-first mode ${graphStoreLoaded ? 'ENABLED' : 'DISABLED (empty)'}`)
    } catch (err) {
      logForDebugging(`[grok] GraphStore not available (${err instanceof Error ? err.message : String(err)}), falling back to LLM-only analysis`)
    }

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
    // Graph-first: 当 GraphStore 可用时，只对 Top N 核心文件做 LLM 语义分析
    reportProgress('analyzer', 0)
    let analysisResults: Record<string, unknown>[] = []
    let graphStructure: { nodes: GraphNode[]; edges: GraphEdge[] } | null = null

    if (graphStoreLoaded) {
      // Graph-first mode: extract structure from GraphStore, LLM only for top files
      const store = GraphStore.getInstance(this.projectRoot)
      graphStructure = this.extractGraphStructure(store)
      logForDebugging(`[grok] Graph-first: extracted ${graphStructure.nodes.length} nodes, ${graphStructure.edges.length} edges from GraphStore`)

      // Only send top files to LLM for semantic analysis
      const MAX_LLM_FILES = 200
      const topFiles = this.extractTopFiles(store, MAX_LLM_FILES)
      const llmFiles = topFiles.filter(f => filesToAnalyze.includes(f))
      logForDebugging(`[grok] Graph-first: ${llmFiles.length} top files for LLM semantic analysis (out of ${filesToAnalyze.length} total)`)

      if (llmFiles.length > 0) {
        try {
          analysisResults = await this.analyzer.analyzeFilesBatch(
            llmFiles, this.config.batchSize, this.config.concurrency,
            (pct) => reportProgress('analyzer', pct)
          )
        } catch (error) {
          errors.push(error instanceof GrokError ? error : new GrokError('ANALYZER_FAILED', 'analyzer', String(error), true))
        }
      }
      reportProgress('analyzer', 100)
    } else {
      // Fallback: LLM-only analysis for all files
      try {
        analysisResults = await this.analyzer.analyzeFilesBatch(
          filesToAnalyze, this.config.batchSize, this.config.concurrency,
          (pct) => reportProgress('analyzer', pct)
        )
        reportProgress('analyzer', 100)
      } catch (error) {
        errors.push(error instanceof GrokError ? error : new GrokError('ANALYZER_FAILED', 'analyzer', String(error), true))
        reportProgress('analyzer', 100)
      }
    }

    // Step 4: Architecture Agent — 架构层分析（增量模式：变更 <20% 文件时复用已有架构）
    let architectureResult: Record<string, unknown> = {}
    if (isIncrementalRun && existingGraph?.metadata && filesToAnalyze.length < files.length * 0.2) {
      // Use full layer objects with modules if available, fallback to name-only
      const layerModules = existingGraph.metadata.layerModules as Array<{ name: string; modules: string[] }> | undefined
      architectureResult = {
        layers: layerModules || existingGraph.metadata.layers?.map((l: string) => ({ name: l, modules: [] })) || [],
        dependencies: [],
      }
      logForDebugging('[grok] Incremental: reusing existing architecture analysis')
      reportProgress('architecture', 100)
    } else {
      const languages = Array.isArray(scannerResult.languages) ? scannerResult.languages.join(', ') : 'unknown'
      const frameworks = Array.isArray(scannerResult.frameworks) ? scannerResult.frameworks.join(', ') : 'unknown'
      architectureResult = await this.analyzer.runPipelineStep('architecture',
        `Analyze the architecture of this project.\n\nFiles: ${files.length}\nLanguages: ${languages}\nFrameworks: ${frameworks}\n\nSample modules:\n${files.slice(0, 30).map(f => `- ${f}`).join('\n')}`,
        AGENT_SYSTEM_PROMPTS.architecture, reportProgress, errors, 'primary'
      )
    }

    // Step 5: Tour Builder — 学习路径（增量模式复用已有 tour）
    let tourResult: Record<string, unknown> = {}
    if (isIncrementalRun && existingGraph?.metadata?.tour) {
      tourResult = { tours: existingGraph.metadata.tour }
      logForDebugging('[grok] Incremental: reusing existing tour')
      reportProgress('tour', 100)
    } else if (graphStoreLoaded) {
      // Graph-first mode: use data-driven tour from GraphStore (no LLM guessing)
      try {
        const store = GraphStore.getInstance(this.projectRoot)
        const engine = new GraphEngine(store)
        const { GrokTourBuilder } = await import('./GrokTourBuilder.js')
        const tourBuilder = new GrokTourBuilder(this.analyzer)
        const enhancedTour = tourBuilder.generateEnhancedTour(store, engine)
        tourResult = { tours: enhancedTour.steps.slice(0, 20).map(s => {
          const node = store.getNode(s.file.split(':')[0] || s.file)
          const docstring = node?.docstring?.split('\n')[0]?.slice(0, 120) || ''
          const sig = node?.signature?.slice(0, 80) || ''
          const roleTag = s.fanIn === 0 && s.fanOut > 0 ? '[Entry]'
            : s.fanOut === 0 && s.fanIn > 0 ? '[Sink]'
            : s.importance > 0.01 ? '[Core]' : ''
          const depFiles = s.dependencies
            .map(id => store.getNode(id)?.file?.split('/').pop())
            .filter(Boolean).slice(0, 3)
          return {
            title: `${roleTag} ${s.file.split('/').pop()}`.trim(),
            files: [s.file],
            description: [
              docstring || sig || s.description,
              depFiles.length > 0 ? `Prerequisites: ${depFiles.join(', ')}` : '',
              `Fan-in: ${s.fanIn}, Fan-out: ${s.fanOut}`,
            ].filter(Boolean).join(' | '),
          }
        }) }
        logForDebugging(`[grok] Graph-first: generated ${enhancedTour.steps.length} tour steps from GraphStore`)
      } catch (err) {
        logForDebugging(`[grok] Graph-first tour failed, falling back to LLM: ${err}`)
        tourResult = await this.analyzer.runPipelineStep('tour',
          `Create learning tours for this project.\n\nFiles: ${files.length}\nLayers: ${JSON.stringify(architectureResult.layers || [])}\n\nKey files:\n${files.slice(0, 30).map(f => `- ${f}`).join('\n')}`,
          AGENT_SYSTEM_PROMPTS.tour, reportProgress, errors, 'fast'
        )
      }
    } else {
      tourResult = await this.analyzer.runPipelineStep('tour',
        `Create learning tours for this project.\n\nFiles: ${files.length}\nLayers: ${JSON.stringify(architectureResult.layers || [])}\n\nKey files:\n${files.slice(0, 30).map(f => `- ${f}`).join('\n')}`,
        AGENT_SYSTEM_PROMPTS.tour, reportProgress, errors, 'fast'
      )
    }

    // Step 6: Graph Reviewer — 质量审查（增量模式跳过，复用已有 review）
    let reviewResult: Record<string, unknown> = {}
    if (isIncrementalRun && existingGraph?.metadata?.review) {
      reviewResult = existingGraph.metadata.review as Record<string, unknown>
      logForDebugging('[grok] Incremental: reusing existing review')
      reportProgress('review', 100)
    } else {
      // Include graph structure counts for accurate review
      const graphNodes = graphStructure?.nodes.length ?? 0
      const graphEdges = graphStructure?.edges.length ?? 0
      const llmNodes = analysisResults.reduce((sum, r) => sum + ((r.symbols as unknown[] | undefined)?.length ?? 0), 0)
      const deps = architectureResult.dependencies as unknown[] | undefined
      const archEdges = deps?.length || 0
      const totalNodes = graphNodes + llmNodes
      const totalEdges = graphEdges + archEdges
      reviewResult = await this.analyzer.runPipelineStep('review',
        `Review this knowledge graph for completeness.\n\nNodes: ${totalNodes}\nEdges: ${totalEdges}\nLayers: ${JSON.stringify(architectureResult.layers || [])}`,
        AGENT_SYSTEM_PROMPTS.review, reportProgress, errors, 'fast'
      )
    }

    // Step 7: 组装并保存图谱（增量模式合并已有数据，延迟删除旧节点）
    // Graph-first: pass graph structure directly to assembler (bypasses extractNewNodes to preserve original IDs)
    if (graphStructure) {
      logForDebugging(`[grok] Passing graph structure directly: ${graphStructure.nodes.length} nodes, ${graphStructure.edges.length} edges`)
    }

    // Use skipSave when enrichment will follow (avoids read-modify-write TOCTOU)
    const result = this.assembler.assembleGraph({
      files, scannerResult, analysisResults, architectureResult,
      tourResult, reviewResult, language: options.language || 'en', errors,
      existingGraph: isIncrementalRun ? existingGraph : undefined,
      changes: isIncrementalRun ? changes : undefined,
      graphStructure: graphStructure ?? undefined,
      skipSave: graphStoreLoaded ? true : undefined,
      store: graphStoreLoaded ? graphStore : undefined,
    })

    // Step 8: Post-assembly enrichment (optional, non-fatal — errors don't break pipeline)
    if (graphStoreLoaded && result.graphData) {
      try {
        const enrichedResult = this.enrichGraph(result.graphData, result)
        return enrichedResult
      } catch (err) {
        logForDebugging(`[grok] Enrichment failed (non-fatal): ${err}`)
        // Fallback: save original graph without enrichment (graph is unmutated)
        const graphPath = resolve(this.projectRoot, GROK_GRAPH_FILE)
        this.atomicSave(graphPath, result.graphData)
      }
    }

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
  // Graph algorithm operations
  // ============================================================

  /**
   * Analyze system architecture using Louvain community detection + role classification
   */
  async analyzeArchitecture(opts?: { resolution?: number; maxNodes?: number; timeoutMs?: number }): Promise<ArchitectureResult> {
    const store = GraphStore.getInstance(this.projectRoot)
    await store.load()
    const engine = new GraphEngine(store)

    const overallTimeout = opts?.timeoutMs ?? 60000
    const deadline = Date.now() + overallTimeout

    const remainingForLouvain = Math.max(5000, deadline - Date.now())
    const community = engine.louvainCommunity({
      resolution: opts?.resolution ?? 1.0,
      timeoutMs: Math.min(remainingForLouvain, 30000),
    })

    const remainingForRoles = Math.max(2000, deadline - Date.now())
    const skipPageRank = remainingForRoles < 5000
    const roles = engine.classifyRoles({
      timeoutMs: remainingForRoles,
      skipPageRank,
    })
    const limit = opts?.maxNodes ?? 20

    // Build role distribution summary
    const roleDistribution: Record<string, number> = {}
    for (const [, role] of roles) {
      roleDistribution[role] = (roleDistribution[role] ?? 0) + 1
    }

    // Generate summary from algorithmic results (no LLM dependency)
    const topCommunities = community.communities
      .sort((a, b) => b.size - a.size)
      .slice(0, 5)
    const communityLines = topCommunities
      .map(c => `  - Community ${c.id}: ${c.size} nodes (${c.nodes.slice(0, 3).join(', ')}${c.nodes.length > 3 ? ', ...' : ''})`)
      .join('\n')
    const roleLines = Object.entries(roleDistribution)
      .sort((a, b) => b[1] - a[1])
      .map(([r, count]) => `  - ${r}: ${count}`)
      .join('\n')
    // Feature chain tracing — end-to-end connectivity (skip if deadline is too close)
    let chainResult: ReturnType<typeof engine.traceFeatureChains> | null = null
    if (Date.now() < deadline - 5000) {
      chainResult = engine.traceFeatureChains({ maxChains: 30, roles })
    }
    const chainLines = chainResult
      ? [
          `Feature chains: ${chainResult.stats.totalEntries} entries, ${chainResult.stats.completeChains} complete (reach data layer), ${chainResult.stats.brokenChains} broken.`,
          chainResult.brokenLinks.length > 0
            ? `Broken links:\n${chainResult.brokenLinks.slice(0, 5).map(b => `  - ${b.from} (${b.fromRole}) → ${b.to}`).join('\n')}`
            : 'No broken links detected.',
        ].join('\n')
      : 'Feature chain tracing skipped (timeout).'

    const llmSummary = [
      `Architecture: ${community.communities.length} communities detected (modularity=${community.modularity.toFixed(3)}).`,
      `Top communities:\n${communityLines}`,
      `Role distribution:\n${roleLines}`,
      chainLines,
      community.modularity > 0.4
        ? 'Good modular structure — communities are well-separated.'
        : 'Low modularity — code may be tightly coupled with unclear boundaries.',
    ].join('\n')

    // Generate community names from file path patterns
    const communityNames = this.generateCommunityNames(community.communities, store)

    return {
      communities: community.communities
        .sort((a, b) => b.size - a.size)
        .slice(0, limit)
        .map(c => ({
          id: c.id,
          size: c.size,
          name: communityNames.get(c.id) ?? `Community-${c.id}`,
          sample: c.nodes.slice(0, 5),
        })),
      modularity: community.modularity,
      resolution: community.resolution,
      totalCommunities: community.communities.length,
      roles: {
        distribution: roleDistribution,
        totalNodes: roles.size,
      },
      llmSummary,
    }
  }

  /**
   * Trace feature chains from entry points to data layers
   * Identifies: entry → controller → service → database paths and broken links
   */
  async traceFeatureChains(opts?: { maxDepth?: number; maxChains?: number }) {
    const store = GraphStore.getInstance(this.projectRoot)
    await store.load()
    const engine = new GraphEngine(store)
    const roles = engine.classifyRoles()
    return engine.traceFeatureChains({ ...opts, roles })
  }

  /**
   * Detect code hotspots using PageRank + temporal coupling
   */
  async detectHotspots(opts?: { damping?: number; since?: string; maxNodes?: number }): Promise<HotspotResult> {
    const store = GraphStore.getInstance(this.projectRoot)
    await store.load()
    const engine = new GraphEngine(store)

    // PageRank for hotspot detection
    const pr = engine.pageRank(opts?.damping ?? 0.85)
    const topN = opts?.maxNodes ?? 20
    const hotspots = pr.scores.slice(0, topN).map(s => ({
      node: s.node,
      score: Math.round(s.score * 10000) / 10000,
      meta: store.getNode(s.node),
    }))

    // Temporal coupling via unified GraphEngine
    let temporalPairs: Array<{ a: string; b: string; score: number; coChanges: number }> = []
    try {
      const temporal = engine.temporalCoupling(this.projectRoot, {
        since: opts?.since || '30 days',
      })
      temporalPairs = temporal.pairs.slice(0, topN)
    } catch {
      // Git not available — skip temporal coupling
    }

    // Generate summary from algorithmic results (no LLM dependency)
    const topHotspot = hotspots[0]
    const topCoupling = temporalPairs[0]
    const llmSummary = [
      `Hotspots: ${hotspots.length} nodes scored by PageRank. Top: ${topHotspot?.node ?? 'N/A'} (score: ${topHotspot?.score ?? 0}).`,
      temporalPairs.length > 0
        ? `Temporal coupling: ${temporalPairs.length} co-change pairs detected. Highest: ${topCoupling?.a} <-> ${topCoupling?.b} (${topCoupling?.coChanges} co-changes).`
        : 'Temporal coupling: no co-change data available (git history may be unavailable).',
      hotspots.length > 0 && hotspots[0].score > 0.01
        ? 'High-scoring hotspots indicate frequently changed, heavily connected code — consider refactoring for modularity.'
        : 'No high-risk hotspots detected.',
    ].join('\n')

    return {
      hotspots,
      totalScored: pr.scores.length,
      temporalCoupling: {
        pairs: temporalPairs,
        window: { since: opts?.since ?? '30 days', until: 'now' },
      },
      llmSummary,
    }
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
