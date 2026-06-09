# AgentMemory 记忆系统增强方案 v4

> 基于 `rohitg00/agentmemory` (21.6K stars) **本地源码深度分析** + ola-cc 记忆系统架构审计
> v3: 算法专家+系统架构师双视角分析
> v4: AgentTool 架构师+算法专家+系统架构师三视角 ola-cc 能力缺陷补偿方案

## 一、AgentMemory 核心算法深度分析

### 1.1 三层去重引擎

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: SHA-256 工具调用去重 (dedup.ts)                 │
│   hash = sha256(sessionId + ":" + toolName + ":" + input[:500])
│   TTL = 5min, 每 60s 自动清理, timer.unref() 不阻塞退出  │
├─────────────────────────────────────────────────────────┤
│ Layer 2: Jaccard 相似度去重 (remember.ts)                │
│   tokens = content.toLowerCase().split(/\s+/).filter(len>2) │
│   similarity = |intersection| / |union|                  │
│   threshold = 0.7 → 跳过保存                            │
│   已有相似 → version++ + isLatest 链                    │
├─────────────────────────────────────────────────────────┤
│ Layer 3: Fingerprint 内容指纹 (lessons.ts)               │
│   fp = sha256(content.trim().toLowerCase()).slice(0,16)  │
│   相同指纹 → 强化: confidence += 0.1*(1-confidence)      │
└─────────────────────────────────────────────────────────┘
```

### 1.2 保留率评分系统 (retention.ts)

```
retention = min(1, salience * exp(-λ*t) + σ * Σ(1/daysSinceAccess))

参数:
  λ = 0.01  (衰减速率)
  σ = 0.3   (强化系数)

显著性权重 (TYPE_SALIENCE):
  architecture = 0.90
  preference   = 0.85
  pattern      = 0.80
  user         = 0.80
  feedback     = 0.70
  bug          = 0.70
  project      = 0.65
  workflow     = 0.60
  reference    = 0.50
  fact         = 0.50

分层:
  hot      (≥0.70)  — 核心记忆，优先注入上下文
  warm     (≥0.40)  — 重要记忆，按需注入
  cold     (≥0.15)  — 低优先级，搜索时才返回
  evictable(<0.15)  — 可驱逐，定期清理
```

### 1.3 经验教训系统 (lessons.ts)

```typescript
// 强化公式（渐近趋近 1.0）
confidence += 0.1 * (1 - confidence)

// 衰减扫描 (lesson-decay-sweep)
confidence -= decayRate * weeksSinceUpdate
// 最低保留 0.05
// confidence ≤ 0.1 && reinforcements === 0 → 软删除

// 召回评分
score = confidence * relevance * recencyBoost
// recencyBoost = exp(-0.01 * daysSinceUpdate)

// 来源追踪
source: 'crystal' | 'manual' | 'consolidation'
```

### 1.4 记忆合并 (consolidate.ts)

```
observations → 按 concepts 分组
  → 每组 ≥ minObservations (默认 10) + importance ≥ 5
  → LLM 合并 (XML 结构化输出)
  → 输出: type/title/content/concepts/files/strength
  → 同名记忆 → version++ + supersedes 链
  → 最多 10 次 LLM 调用, 30s 超时
```

### 1.5 行动结晶 (crystallize.ts)

```
Action[] (status=done/cancelled)
  → LLM 摘要 (JSON 输出)
  → Crystal { narrative, keyOutcomes, filesAffected, lessons }
  → lessons 自动触发 lesson-save
  → actions 关联 crystallizedInto
  → auto-crystallize: 7 天前的已完成 actions 自动结晶
```

### 1.6 自动遗忘 (auto-forget.ts)

```
三种遗忘策略:
  1. TTL 过期: memory.forgetAfter < now → 删除 (含图片引用清理)
  2. 矛盾检测: 共享 concepts 的记忆, token-level Jaccard > 0.9 → 旧版 isLatest=false
  3. 低价值淘汰: 180 天 + importance ≤ 2 → 删除

搜索索引同步: 删除时清理 searchIndex + vectorIndex + accessLog
```

### 1.7 工作记忆窗口 (working-memory.ts)

```
核心记忆 (pinned): 手动添加, 30% token 预算
归档记忆 (archival): 按 strength+recency 排序, 70% token 预算

评分: score = importance*0.5 + recency*0.3 + accessCount*0.2

自动换页 (auto-page): 核心记忆超预算 → 低分条目转归档

访问追踪: 每次读取更新 accessCount + lastAccessedAt
```

### 1.8 知识图谱 (graph.ts, 997 行)

```
LLM 实体提取: observations → <entity> + <relationship>
快照系统: 预计算 top-degree 子图 (500 节点)
增量更新: applyDegreeDelta 维护 top-N 排名
名称索引: type|name → nodeId (避免 O(n) 扫描)
BFS 查询: 最大深度 5, 支持 nodeType 过滤
超时保护: 6s 预算, 超时降级到快照
重建保护: >25000 节点拒绝全量重建
```

## 二、ola-cc 记忆系统架构审计

### 2.1 精确集成点

| 集成点 | 文件:行号 | 说明 | 风险 |
|--------|----------|------|------|
| B1 | `memoryIndex.ts:154-190` | 混合搜索增强 (search 方法) | 低 |
| B2 | `memoryIndex.ts:121-138` | 索引增量更新 (indexFile 方法) | 低 |
| B3 | `memdir.ts:57-103` | MEMORY.md 智能截断 | 低 |
| B4 | `memoryTypes.ts:14-19` | 记忆类型扩展 | 低 |
| B5 | `agentMemory.ts:52-65` | Agent Memory 跨 agent 共享 | 中 |
| B6 | `sessionMemory.ts:272-350` | Session→Auto Memory 沉淀 | 高 |

### 2.2 现有记忆系统约束

| 约束 | 位置 | 影响 |
|------|------|------|
| MEMORY.md 200 行 / 25KB 限制 | memdir.ts:36-38 | 索引文件不能无限增长 |
| Session Memory feature gate | sessionMemory.ts:80-82 | 可能被禁用 |
| sequential() 单实例保护 | sessionMemory.ts:272 | 提取不能并发 |
| createMemoryFileCanUseTool 权限 | sessionMemory.ts:460-482 | 只允许编辑记忆文件 |
| BM25 + VectorStore 内存存储 | memoryIndex.ts | 重启后需重建索引 |
| vectorAnchoredFusion 硬编码 alpha=0.7 | memoryIndex.ts:169 | 融合权重不可调 |

## 三、优化方案

### 方案 1: 去重引擎（P0）

#### 3.1.1 集成位置

**写入流程**：在 auto-memory 的保存路径中插入去重检查

```
用户消息 → LLM 判断保存 → [新增] 去重检查 → 写入 MEMORY.md
                              ├─ SHA-256 匹配 → 跳过
                              ├─ Jaccard > 0.7 → 强化已有
                              └─ 无匹配 → 新建
```

#### 3.1.2 实现

```typescript
// src/services/memory/dedup.ts

import { createHash } from 'crypto'

export class MemoryDedup {
  private recentHashes = new Map<string, number>()
  private readonly TTL_MS = 5 * 60 * 1000

  computeHash(content: string): string {
    return createHash('sha256')
      .update(content.slice(0, 500))
      .digest('hex')
  }

  isDuplicate(hash: string): boolean {
    const expires = this.recentHashes.get(hash)
    if (!expires) return false
    if (Date.now() > expires) {
      this.recentHashes.delete(hash)
      return false
    }
    return true
  }

  record(hash: string): void {
    this.recentHashes.set(hash, Date.now() + this.TTL_MS)
  }

  /**
   * Jaccard 相似度去重
   * 借鉴 remember.ts 的阈值 0.7
   */
  findSimilar(
    newContent: string,
    existingEntries: Array<{ id: string; content: string }>,
    threshold = 0.7
  ): { isDuplicate: boolean; similarTo?: string; score?: number } {
    const newTokens = this.tokenize(newContent)
    for (const entry of existingEntries) {
      const existingTokens = this.tokenize(entry.content)
      const score = this.jaccard(newTokens, existingTokens)
      if (score >= threshold) {
        return { isDuplicate: true, similarTo: entry.id, score }
      }
    }
    return { isDuplicate: false }
  }

  /**
   * Fingerprint 去重（用于 lessons）
   * 借鉴 lessons.ts 的 fingerprintId 逻辑
   */
  fingerprint(content: string): string {
    return createHash('sha256')
      .update(content.trim().toLowerCase())
      .digest('hex')
      .slice(0, 16)
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    )
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    let intersection = 0
    for (const item of a) {
      if (b.has(item)) intersection++
    }
    const union = a.size + b.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  cleanup(): void {
    const now = Date.now()
    for (const [hash, expires] of this.recentHashes) {
      if (now > expires) this.recentHashes.delete(hash)
    }
  }
}

export const memoryDedup = new MemoryDedup()
```

#### 3.1.3 集成到 auto-memory 写入

**集成位置**: 系统提示中的 auto-memory 保存逻辑（由 LLM 执行）

在 `memdir.ts` 的 `buildMemoryLines()` 中添加去重指引：

```typescript
// memdir.ts:199 附近的 buildMemoryLines 函数
// 在现有指引后追加：
const DEDUP_SECTION = [
  '## Deduplication',
  '',
  'Before saving a new memory:',
  '- Check if similar content already exists in MEMORY.md index',
  '- If a similar entry exists, update it instead of creating a new one',
  '- Use the `/memory dedup` command to scan for duplicates',
]
```

**程序化去重**：在 `memoryIndex.ts` 的 `indexFile` 方法中添加：

```typescript
// memoryIndex.ts:121 附近的 indexFile 方法
indexFile(filePath: string): void {
  const content = fs.readFileSync(filePath, 'utf-8')
  const docId = path.basename(filePath)

  // 新增：去重检查
  const hash = memoryDedup.computeHash(content)
  if (memoryDedup.isDuplicate(hash)) return // 跳过重复

  // 新增：相似度检查
  const existing = [...this.docContents.entries()].map(([id, c]) => ({ id, content: c }))
  const { isDuplicate, similarTo } = memoryDedup.findSimilar(content, existing)
  if (isDuplicate) {
    // 标记为重复，不加入索引
    return
  }

  memoryDedup.record(hash)
  this.bm25.addDocument(docId, content)
  // ... 其余逻辑
}
```

### 方案 2: 经验教训系统（P0）

#### 3.2.1 存储设计

```
.ola-cc/
├── lessons/
│   ├── lessons.json      # 教训条目
│   └── access-log.json   # 访问日志
└── memory/
    └── ...               # 现有记忆文件
```

#### 3.2.2 实现

```typescript
// src/services/memory/lessons.ts

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { memoryDedup } from './dedup.js'

export interface Lesson {
  id: string                 // fingerprint ID
  content: string
  context: string
  confidence: number         // 0-1
  reinforcements: number
  source: 'manual' | 'auto' | 'crystal'
  project?: string
  tags: string[]
  createdAt: string
  updatedAt: string
  lastReinforcedAt?: string
  decayRate: number          // 默认 0.05
}

export class LessonSystem {
  private lessons = new Map<string, Lesson>()
  private filePath: string

  constructor(memoryDir: string) {
    this.filePath = join(memoryDir, 'lessons.json')
  }

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf-8'))
      for (const lesson of data) {
        this.lessons.set(lesson.id, lesson)
      }
    } catch { /* file not found */ }
  }

  /**
   * 保存教训 — 借鉴 lesson-save 的 fingerprint 去重 + 强化逻辑
   */
  async save(
    content: string,
    options?: {
      context?: string
      confidence?: number
      source?: Lesson['source']
      tags?: string[]
    }
  ): Promise<{ action: 'created' | 'strengthened'; lesson: Lesson }> {
    const fp = memoryDedup.fingerprint(content)
    const existing = this.lessons.get(fp)

    if (existing && !existing.deleted) {
      // 强化: confidence += 0.1 * (1 - confidence)
      existing.reinforcements++
      existing.confidence = Math.min(
        1.0,
        existing.confidence + 0.1 * (1 - existing.confidence)
      )
      existing.lastReinforcedAt = new Date().toISOString()
      existing.updatedAt = existing.lastReinforcedAt
      if (options?.context && !existing.context) {
        existing.context = options.context
      }
      await this.persist()
      return { action: 'strengthened', lesson: existing }
    }

    const now = new Date().toISOString()
    const lesson: Lesson = {
      id: fp,
      content: content.trim(),
      context: options?.context?.trim() || '',
      confidence: Math.max(0, Math.min(1, options?.confidence ?? 0.5)),
      reinforcements: 0,
      source: options?.source || 'manual',
      tags: options?.tags || [],
      createdAt: now,
      updatedAt: now,
      decayRate: 0.05,
    }
    this.lessons.set(fp, lesson)
    await this.persist()
    return { action: 'created', lesson }
  }

  /**
   * 召回 — 借鉴 lesson-recall 的评分公式
   * score = confidence * relevance * recencyBoost
   */
  recall(query: string, options?: { limit?: number; minConfidence?: number }): Lesson[] {
    const limit = options?.limit ?? 5
    const minConfidence = options?.minConfidence ?? 0.1
    const queryTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 2)

    const scored: Array<{ lesson: Lesson; score: number }> = []

    for (const lesson of this.lessons.values()) {
      if (lesson.confidence < minConfidence) continue

      const contentTokens = lesson.content.toLowerCase().split(/\s+/)
      const matchCount = queryTokens.filter(t =>
        contentTokens.some(ct => ct.includes(t) || t.includes(ct))
      ).length
      if (matchCount === 0) continue

      const relevance = matchCount / queryTokens.length
      const days = (Date.now() - new Date(lesson.updatedAt).getTime()) / (24 * 60 * 60 * 1000)
      const recencyBoost = Math.exp(-0.01 * days)
      const score = lesson.confidence * relevance * recencyBoost

      scored.push({ lesson, score })
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.lesson)
  }

  /**
   * 衰减扫描 — 借鉴 lesson-decay-sweep
   */
  async decaySweep(): Promise<{ pruned: number; decayed: number }> {
    const now = Date.now()
    let pruned = 0
    let decayed = 0

    for (const [id, lesson] of this.lessons) {
      const weeks = (now - new Date(lesson.updatedAt).getTime()) / (7 * 24 * 60 * 60 * 1000)
      const oldConfidence = lesson.confidence

      lesson.confidence = Math.max(0.05, lesson.confidence - lesson.decayRate * weeks)

      if (lesson.confidence !== oldConfidence) decayed++

      // confidence ≤ 0.1 且从未强化 → 软删除
      if (lesson.confidence <= 0.1 && lesson.reinforcements === 0) {
        this.lessons.delete(id)
        pruned++
      }
    }

    if (pruned > 0 || decayed > 0) await this.persist()
    return { pruned, decayed }
  }

  getStats(): { total: number; avgConfidence: number; bySource: Record<string, number> } {
    const lessons = [...this.lessons.values()]
    const avgConfidence = lessons.length > 0
      ? lessons.reduce((sum, l) => sum + l.confidence, 0) / lessons.length
      : 0
    const bySource: Record<string, number> = {}
    for (const l of lessons) {
      bySource[l.source] = (bySource[l.source] ?? 0) + 1
    }
    return { total: lessons.length, avgConfidence, bySource }
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.filePath,
      JSON.stringify([...this.lessons.values()], null, 2),
      { mode: 0o600 }
    )
  }
}
```

### 方案 3: 保留率评分 + 自动清理（P1）

#### 3.3.1 实现

```typescript
// src/services/memory/retention.ts

import type { MemoryEntry } from './types.js'

const TYPE_SALIENCE: Record<string, number> = {
  architecture: 0.9,  preference: 0.85, pattern: 0.8,
  user: 0.8,          feedback: 0.7,    bug: 0.7,
  project: 0.65,      workflow: 0.6,    reference: 0.5,
  fact: 0.5,
}

const LAMBDA = 0.01   // 衰减速率
const SIGMA = 0.3     // 强化系数

/**
 * 计算保留率 — 借鉴 retention.ts 公式
 * retention = min(1, salience * exp(-λ*t) + σ * recencyFactor)
 */
export function calculateRetention(entry: {
  type: string
  updatedAt: string
  accessCount: number
  strength?: number
}): number {
  const salience = TYPE_SALIENCE[entry.type] ?? 0.5
  const t = (Date.now() - new Date(entry.updatedAt).getTime()) / (24 * 60 * 60 * 1000)

  // 指数衰减
  const decay = salience * Math.exp(-LAMBDA * t)

  // 访问强化
  const reinforcement = entry.accessCount > 0
    ? SIGMA * (1 / Math.max(1, t / (entry.accessCount + 1)))
    : 0

  return Math.min(1, decay + reinforcement)
}

export function classifyLayer(retention: number): 'hot' | 'warm' | 'cold' | 'evictable' {
  if (retention >= 0.7) return 'hot'
  if (retention >= 0.4) return 'warm'
  if (retention >= 0.15) return 'cold'
  return 'evictable'
}

/**
 * 矛盾检测 — 借鉴 auto-forget.ts 的 Jaccard > 0.9 逻辑
 */
export function findContradictions(
  memories: Array<{ id: string; content: string; concepts?: string[] }>
): Array<{ memoryA: string; memoryB: string; score: number }> {
  const contradictions: Array<{ memoryA: string; memoryB: string; score: number }> = []

  // 按 concept 分组
  const conceptIndex = new Map<string, typeof memories>()
  for (const mem of memories) {
    for (const concept of mem.concepts ?? []) {
      const key = concept.toLowerCase()
      if (!conceptIndex.has(key)) conceptIndex.set(key, [])
      conceptIndex.get(key)!.push(mem)
    }
  }

  const compared = new Set<string>()
  for (const [, group] of conceptIndex) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const pairKey = [group[i].id, group[j].id].sort().join('|')
        if (compared.has(pairKey)) continue
        compared.add(pairKey)

        // Token-level Jaccard
        const tokensA = new Set(group[i].content.toLowerCase().split(/\s+/).filter(t => t.length > 2))
        const tokensB = new Set(group[j].content.toLowerCase().split(/\s+/).filter(t => t.length > 2))
        let intersection = 0
        for (const t of tokensA) if (tokensB.has(t)) intersection++
        const union = tokensA.size + tokensB.size - intersection
        const score = union === 0 ? 0 : intersection / union

        if (score > 0.9) {
          contradictions.push({ memoryA: group[i].id, memoryB: group[j].id, score })
        }
      }
    }
  }

  return contradictions
}
```

### 方案 4: 记忆类型扩展（P2）

**集成点** — `memoryTypes.ts:14-19`

```typescript
// 当前
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const

// 扩展后
export const MEMORY_TYPES = [
  'user',        // 用户画像
  'feedback',    // 行为指导
  'project',     // 项目状态
  'reference',   // 外部引用
  'pattern',     // 代码模式 (新增)
  'architecture',// 架构决策 (新增)
  'bug',         // 已知问题 (新增)
  'workflow',    // 工作流程 (新增)
] as const
```

**同步更新**：`TYPES_SECTION_INDIVIDUAL` 和 `TYPES_SECTION_COMBINED` 需要追加新类型的描述。

### 方案 5: Session→Auto Memory 沉淀（P2）

**集成点** — `sessionMemory.ts:272-350`

```typescript
// 在 extractSessionMemory 完成后
// 将高价值 Session Memory 条目自动写入 Auto Memory

async function沉淀ToAutoMemory(sessionMemoryContent: string): Promise<void> {
  // 解析 Session Memory 中的结构化段落
  const sections = parseSessionMemorySections(sessionMemoryContent)

  for (const section of sections) {
    // 只沉淀决策和架构相关内容
    if (section.type === 'decisions' || section.type === 'architecture') {
      const hash = memoryDedup.computeHash(section.content)
      if (!memoryDedup.isDuplicate(hash)) {
        await writeAutoMemory({
          type: section.type === 'decisions' ? 'project' : 'architecture',
          title: section.title,
          content: section.content,
          source: 'session-memory',
        })
        memoryDedup.record(hash)
      }
    }
  }
}
```

## 四、实施路线（修订版）

### Phase 1: 去重 + 教训（P0，1.5 周）

| 任务 | 文件 | 行数 | 集成点 |
|------|------|------|--------|
| 实现 MemoryDedup | 新建 `memory/dedup.ts` | ~100 行 | 无 |
| 实现 LessonSystem | 新建 `memory/lessons.ts` | ~200 行 | 无 |
| 集成去重到 indexFile | 修改 `memoryIndex.ts:121` | ~15 行 | B2 |
| 集成去重到 memdir | 修改 `memdir.ts:199` | ~15 行 | B3 |
| 实现 /memory lessons 命令 | 修改 `commands/memory/` | ~80 行 | 无 |
| 测试 | 新建 `memory/dedup.test.ts` | ~150 行 | 无 |

**总计**: ~560 行

### Phase 2: 保留率 + 清理（P1，1 周）

| 任务 | 文件 | 行数 | 集成点 |
|------|------|------|--------|
| 实现 retention.ts | 新建 `memory/retention.ts` | ~120 行 | 无 |
| 实现自动清理 | 新建 `memory/autoForget.ts` | ~100 行 | 无 |
| 注册衰减扫描 hook | 修改 `sessionMemory.ts` | ~20 行 | A7 |
| 实现 /memory stats 命令 | 修改 `commands/memory/` | ~40 行 | 无 |

### Phase 3: 类型扩展 + 沉淀（P2，1.5 周）

| 任务 | 文件 | 行数 | 集成点 |
|------|------|------|--------|
| 扩展 memoryTypes | 修改 `memoryTypes.ts:14` | ~10 行 | B4 |
| 更新 prompt 模板 | 修改 `memdir.ts` | ~60 行 | B3 |
| 实现 Session→Auto 沉淀 | 修改 `sessionMemory.ts:272` | ~60 行 | B6 |
| 测试 | 新建测试文件 | ~100 行 | 无 |

## 五、验收标准（修订版）

| 指标 | 当前值 | Phase 1 | Phase 2 | Phase 3 |
|------|--------|---------|---------|---------|
| 重复记忆率 | ~30% | ≤5% | ≤5% | ≤5% |
| 教训召回准确率 | 无 | ≥80% | ≥80% | ≥80% |
| 记忆信噪比 | 不可控 | — | hot+warm≥70% | hot+warm≥70% |
| 过期记忆清理 | 无 | 无 | 自动 | 自动 |
| 记忆类型覆盖 | 4 种 | 4 种 | 4 种 | 8 种 |
| Session→Auto 沉淀 | 无 | 无 | 无 | 自动 |

## 六、与 Headroom 方案的协同

| 层 | AgentMemory 负责 | Headroom 负责 |
|----|-----------------|---------------|
| 记忆持久化 | 去重/合并/清理/教训 | — |
| 上下文压缩 | — | CCR 可逆压缩 |
| 工作记忆 | pinned/archive 分层 | token 预算管理 |
| 信息恢复 | 记忆检索 (BM25+Vector) | CCR 原文恢复 |
| 质量保证 | 保留率评分 + 矛盾检测 | 压缩质量反馈 |

**依赖关系**：
- Phase 1 (去重+教训) 无外部依赖，可独立实施
- Phase 2 (保留率) 依赖 Phase 1 的 dedup
- Phase 3 (沉淀) 依赖 Phase 1 + Headroom CCR（沉淀时需要原文备份）

## 七、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Jaccard 0.7 阈值误判 | 有效记忆被跳过 | 提供 `/memory force-save` 覆盖命令 |
| 衰减过快丢失重要记忆 | 知识流失 | 最低 confidence=0.05 + pinned 保护 |
| fingerprint 碰撞 | 不同内容相同 ID | 使用 16 字符哈希 + 内容校验 |
| lessons.json 文件锁 | 并发写入冲突 | 使用 proper-lockfile（已有依赖） |
| 与 auto-memory 指引冲突 | LLM 行为不一致 | 去重指引作为补充，不覆盖现有规则 |

## 八、v3 深度源码分析补充（本地源码）

> 基于 `/tmp/agentmemory` 本地源码，算法专家分析 12 个核心算法文件 + 系统架构师分析 12 个管线模块

### 8.1 移植优先级矩阵（算法专家视角）

按 **价值/复杂度** 排序：

| 优先级 | 模块 | 价值 | 复杂度 | 评分 | 可移植性 | 理由 |
|--------|------|------|--------|------|----------|------|
| **P0** | retention.ts | 5 | 1 | **5.0** | 5/5 | 纯数学公式，零依赖。ola-cc 完全缺少记忆生命周期管理 |
| **P0** | lessons.ts | 5 | 1 | **5.0** | 5/5 | 纯算法。强化 EMA + 线性衰减 + fingerprint 去重 |
| **P0** | working-memory.ts | 5 | 1 | **5.0** | 5/5 | 评分公式自包含。30% core + 70% archival 分层直接可用 |
| **P1** | jaccardSimilarity | 4 | 1 | **4.0** | 5/5 | schema.ts 中的 Jaccard 实现可直接提取 |
| **P1** | auto-forget.ts | 4 | 1 | **4.0** | 4/5 | TTL + 矛盾检测 + 低价值清理三种机制 |
| **P1** | SearchIndex BM25 | 4 | 2 | **2.0** | 3/5 | CJK 分词 + 同义词扩展 + 前缀匹配是 ola-cc 缺失的 |
| **P2** | graph.ts 快路径 | 3 | 2 | **1.5** | 3/5 | snapshot + top-degree 排名 + name-index O(1) 查找 |
| **P2** | access-tracker.ts | 3 | 2 | **1.5** | 5/5 | 细粒度锁 + 滑动窗口设计 |

### 8.2 BM25 搜索增强细节（本地源码发现）

AgentMemory 的 SearchIndex (`search-index.ts`) 比 ola-cc 的 toolRanker BM25 更成熟：

```
BM25 参数: k1=1.2, b=0.75 (标准参数)

同义词扩展: queryTerms = rawTerms + getSynonyms(rawTerms), 权重 0.7
前缀匹配: IDF * 0.5 (二分查找 sortedTerms)
CJK 分词: 内置 CJK tokenizer
过采样: post-filter 时 fetchLimit = limit * 10
嵌入截断: EMBED_MAX_CHARS = 16000
批量重建: REBUILD_EMBED_BATCH_SIZE = 32 (环境变量可覆盖)
```

**移植建议**: 直接复用 SearchIndex 类替换 ola-cc 的 toolRanker BM25，增加同义词扩展 + 前缀匹配。

### 8.3 工作记忆评分公式（本地源码精确值）

```
score = importance*0.5 + recency*0.3 + accessCount*0.2

core (pinned): 手动添加, 30% token 预算
archival: 按 strength+recency 排序, 70% token 预算

自动换页: 核心记忆超预算 → 低分条目转归档
访问追踪: 每次读取更新 accessCount + lastAccessedAt
```

### 8.4 管线架构差异（系统架构师视角）

| 维度 | AgentMemory | ola-cc 当前 | 建议 |
|------|-------------|-------------|------|
| 存储 | KV Store (per-session namespace) | JSONL + SQLite | 保持 ola-cc 的 SQLite，增加 KV 抽象层 |
| 索引 | BM25 + 向量 | BM25 (toolRanker) | 增加向量索引 |
| 压缩 | LLM + Synthetic 双路径 | LLM only | 增加 Synthetic 降级路径 |
| 驱逐 | 五级策略 + 干运行 | 无 | 移植 evict.ts |
| 治理 | 审计追踪 + 批量删除 | 无 | 移植 governance.ts |
| 上下文 | Token 预算 + 多源组装 | 固定策略 | 移植 context.ts |

### 8.5 管线模块补充建议

**立即移植（P1）**:

| 模块 | 理由 | 集成点 |
|------|------|--------|
| observe.ts 去重+隐私过滤 | ola-cc 完全缺失，防止重复记忆和敏感数据泄露 | `src/services/compact/` |
| evict.ts 五级驱逐策略 | 解决记忆无限增长问题 | 新建 `memory/eviction.ts` |
| context.ts Token 预算管理 | ola-cc 缺少结构化上下文组装 | `src/services/compact/compact.ts` |
| compress.ts 质量评分+自纠正 | 提升压缩质量 | `src/services/compact/microCompact.ts` |

**近期集成（P2）**:

| 模块 | 理由 | 集成点 |
|------|------|--------|
| cascade.ts 级联失效 | GraphEngine 缺少一致性维护 | `src/services/graph/IncrementalSync.ts` |
| patterns.ts 模式识别 | 增强 LearningSystem | `src/tools/AgentTool/LearningSystem.ts` |
| file-index.ts 文件历史 | 增强 CodegraphTool | `src/tools/CodegraphTool/` |
| flow-compress.ts 工作流压缩 | 长时间工作流的记忆化 | `src/services/compact/` |

### 8.6 核心差距总结

ola-cc 与 AgentMemory 的核心差距集中在两个维度：

1. **记忆生命周期管理** — ola-cc 完全缺少驱逐+治理机制，记忆只增不减
2. **结构化上下文组装** — ola-cc 的 compact 系统使用固定策略，缺少 Token 预算+多源优先级的动态组装

### 8.7 推荐移植路径

**Phase 1 (1-2 天)** — 直接复制纯算法模块：
1. `jaccardSimilarity` — 从 schema.ts 提取
2. `computeRetention` + `computeSalience` + `computeReinforcementBoost` — 从 retention.ts 提取
3. `scoreEntry` (working-memory 评分) — 从 working-memory.ts 提取
4. `reinforceLesson` + `lesson-decay-sweep` — 从 lessons.ts 提取
5. `access-tracker` 滑动窗口 — 从 access-tracker.ts 提取

**Phase 2 (3-5 天)** — 适配集成：
1. 将 retention 评分接入 ola-cc 的 memory 系统
2. 将 working-memory 的 core/archival 分层接入 system prompt 构建
3. 将 lessons 系统作为新的 Orion 技能实现
4. 将 auto-forget 作为定期清理任务

**Phase 3 (1 周+)** — 深度集成：
1. 将 SearchIndex BM25 的 CJK + 同义词 + 前缀匹配增强 ola-cc 搜索
2. 将 graph snapshot 优化移植到 ola-cc GraphStore
3. 将 consolidate/crystallize 的 LLM 流程接入 ola-cc API client

## 九、v4 ola-cc 能力缺陷补偿方案（三专家联合分析）

> AgentTool 架构师 + 资深算法专家 + 系统架构师共同分析 ola-cc 源码后，聚焦"ola-cc 当前能力不足"的 13 个具体问题

### 9.1 AgentTool 架构缺陷（3 个）

#### 缺陷 A1: 无跨会话记忆注入

**现状**: `runAgent.ts` 每次启动 agent 时，`buildAgentPrompt()` 只包含当前任务描述。`LearningSystem` 记录了执行历史但从未将历史教训注入 agent 上下文。`contrastAnalysis()` 生成的洞察无消费者。

**补偿方案**: 从 AgentMemory 的 `context.ts` + `enrich.ts` 借鉴多源上下文组装。

**集成点**: `src/tools/AgentTool/agentToolUtils.ts` 的 `buildAgentPrompt()` 函数

```
修改: 在构造 system prompt 时，从 LearningSystem 加载当前 skill 的 lessons
     和 contrast insights，按 token 预算截断后追加到 prompt 末尾
位置: runAgent.ts 中 agent 启动前调用
限制: 硬限 2000 token
```

**风险**: 低。prompt 追加不改变执行逻辑。

#### 缺陷 A2: 无行动链结晶→可复用知识管线

**现状**: `LearningSystem.logExecution()` 记录单次执行，但多次连续工具调用形成的行动链无法被总结为结构化经验。`AgentAnalyzer.consolidateRevisions()` 只按 signal_type 去重，不提取步骤级程序性知识。

**补偿方案**: 从 AgentMemory 的 `crystallize.ts` + `consolidation-pipeline.ts` 借鉴。

**集成点**: `runAgent.ts` 的 agent 完成后逻辑（~500-600 行）

```
新增: LearningSystem.crystallize(skill, actionChain) 方法
触发: 仅在 agent 失败或 score<60 时
执行: 异步不阻塞返回
输出: Crystal { narrative, keyOutcomes, filesAffected, lessons }
```

**风险**: 中。需额外 LLM 调用。建议异步执行 + 条件触发。

#### 缺陷 A3: 无依赖感知的任务优先级排序

**现状**: AgentTool 是单任务执行器，多 agent 排队时只能 FIFO。`EvolutionEngine` 管理进化阶段但不管理任务间依赖。

**补偿方案**: 从 AgentMemory 的 `frontier.ts` 借鉴依赖图分析。

**集成点**: `src/tools/SingularityTool/SingularityTool.ts` 新增 `agent_frontier` 操作

```
新增操作: agent_frontier
数据源: EvolutionEngine 的 ExecutionRecord
评分: priority*10 + age_hours*0.5 + unlockCount*5 + active*15
退化: 无边数据时按 priority 排序
```

**风险**: 低。新增操作不破坏现有接口。需扩展 storage.ts 的 JSONL schema。

---

### 9.2 算法缺陷（5 个）

#### 缺陷 B1: 无记忆衰减机制（P0）

**现状**: 记忆只增不减，context 不断膨胀导致 compact 频率升高。

**补偿算法**: AgentMemory 的 `retention.ts` 指数衰减 + 强化公式

```
R(t) = min(1, S * exp(-λ * Δt) + σ * Σ(1/daysSinceAccess_i))
S = salience (architecture=0.9, bug=0.7, preference=0.85, fact=0.5)
λ = 0.005 (ola-cc 调低，会话通常 1-3 小时)
σ = 0.3
分层: hot≥0.7, warm≥0.4, cold≥0.15, evictable<0.15
```

**集成点**: `sessionMemoryCompact.ts` 的 compact 前钩子中插入衰减扫描

**复杂度**: O(N) 时间，O(1) 空间

#### 缺陷 B2: 无记忆去重（P1）

**现状**: 重复记忆堆积，依赖 LLM 自行判断（不可靠且浪费 token）。

**补偿算法**: AgentMemory 的 Jaccard 去重

```
jaccard(a, b) = |A∩B| / |A∪B|
tokens = content.toLowerCase().split(/\s+/).filter(len > 2)
阈值: 英文 0.7, 中文 0.6 (中文 token 稀疏度更高)
优化: concept 索引将候选对从 O(K²) 缩小到 O(K * avg_concept_overlap)
```

**集成点**: `microCompact.ts` 的 per-tool-result 压缩阶段插入去重检查

**复杂度**: 单次比较 O(M+N)，concept 索引优化后近 O(K * avg_overlap)

#### 缺陷 B3: 上下文压缩无自适应尺寸控制（P2）

**现状**: MicroCompact 和 SM-Compact 使用固定策略截断，无法根据内容冗余度动态调整。

**补偿算法**: Headroom 的 `compute_optimal_k`（Kneedle 信息饱和检测）

```
1. n≤8 → 全保留
2. SimHash 去重: count_unique_simhash(items, hamming_threshold=3)
3. 累积 bigram 覆盖曲线 curve[i] = |unique_bigrams(items[0..i])|
4. Kneedle 拐点检测: max(y_norm - x_norm)
5. k = min_k.max(knee * bias)  // bias=0.8 偏向压缩
```

**集成点**: `microCompact.ts` 替换固定截断逻辑

**复杂度**: O(N * L)（SimHash + bigram）

#### 缺陷 B4: 工具排名缺乏语义扩展（P3）

**现状**: `toolRanker.ts` 纯词匹配，无同义词扩展、无前缀匹配、无 CJK 支持。

**补偿算法**: AgentMemory search.ts 的 BM25 增强（三项）

```
1. 同义词扩展: Map<string, string[]> 映射表，查询词自动扩展
2. 前缀匹配: 长度≥4 的查询词匹配所有前缀文档词（权重 0.5x）
3. CJK 分词: 中日韩字符按 bigram 切分
```

**集成点**: `toolRanker.ts` 的 `extractTerms()` 函数

**复杂度**: 同义词 O(S)，前缀 O(T*V)，CJK O(L)

#### 缺陷 B5: 经验教训无强化/衰减系统（P4）

**现状**: `LearningSystem.ts` 只做执行记录，无 confidence 强化、无 EMA 衰减、无自动遗忘。

**补偿算法**: AgentMemory 的 lessons 三层机制

```
1. 强化: confidence += 0.1 * (1 - confidence)  (EMA alpha=0.1)
2. 衰减: confidence -= decayRate * weeksSinceBaseline (decayRate=0.1)
3. 召回: score = confidence * relevance * recencyBoost
   recencyBoost = 1 / (1 + days * 0.01)
```

**集成点**: `LearningSystem.ts` 的 `contrastAnalysis()` 输出后插入 lesson-save

**复杂度**: 强化 O(1)，衰减 O(K)，召回 O(K*Q)

---

### 9.3 架构缺陷（5 个）

#### 缺陷 C1: 记忆无生命周期管理

**现状**: 记忆写入后永不清理。MEMORY.md 以 200 行硬上限暴力截断。

**补偿方案**: AgentMemory 的 `evict.ts` 五级驱逐

```
新增: src/services/compact/memoryEviction.ts
策略: 会话 TTL(30天) + 重要度衰减 + MEMORY.md 按重要度排序保留
集成: autoCompact.ts 的 shouldTriggerAutoCompact() 中增加驱逐检查
```

#### 缺陷 C2: microCompact 不感知缓存冻结区

**现状**: `microCompact.ts` 无差别清理所有旧 tool_result，不区分是否在 Anthropic cache_control marker 之前。

**补偿方案**: Headroom 的 `live_zone.rs` frozen boundary 概念

```
修改: microCompactMessages() 入口增加 frozenCount 参数
逻辑: frozen_count 之前的消息完全跳过 microCompact
来源: 反推 claude.ts 已有的 cache_control 标记位置
```

**风险**: 高。误删 frozen 区消息会破坏 prompt cache，导致成本飙升。

#### 缺陷 C3: 压缩无质量反馈和自纠正

**现状**: `compactConversation()` 调用 LLM 生成摘要但不验证摘要质量。

**补偿方案**: AgentMemory 的 `compress.ts` 三步质量闭环

```
新增: compactConversation() 返回后增加:
1. 结构验证: 摘要必须包含 key_files、open_questions、decisions
2. 信息密度评分: 文件路径、错误信息的召回率
3. 评分低于阈值时自动重试一次
集成点: compactConversation() 返回后、buildPostCompactMessages() 之前
```

#### 缺陷 C4: 压缩策略无差异化

**现状**: 所有用户、所有会话使用相同压缩参数。

**补偿方案**: Headroom 的 `compression_policy.rs` 认证模式驱动

```
新增: src/services/compact/CompressionPolicy.ts
策略: free tier(激进) / paid tier(保守) / long-session(优先不超限)
集成: autoCompact.ts 的 buffer token 从 policy 读取
```

#### 缺陷 C5: 图引擎无级联失效

**现状**: 文件修改/删除时，对应图节点和边不会被标记为 stale。

**补偿方案**: AgentMemory 的 `cascade.ts` 级联失效

```
新增: src/services/graph/CascadeInvalidator.ts
逻辑: 记忆修改时通过 sourceObservationIds 关联标记图节点 stale
集成: IncrementalSync.ts 的 sync() 末尾调用级联检查
```

---

### 9.4 缺陷总览与实施优先级

| 优先级 | 缺陷 | 类型 | 严重度 | 实现难度 | 来源 |
|--------|------|------|--------|----------|------|
| **P0** | B1 记忆衰减 | 算法 | 高 | 低 | AgentMemory retention.ts |
| **P0** | C2 缓存冻结区感知 | 架构 | 高 | 中 | Headroom live_zone.rs |
| **P1** | B2 记忆去重 | 算法 | 高 | 低 | AgentMemory remember.ts |
| **P1** | C1 记忆生命周期 | 架构 | 高 | 中 | AgentMemory evict.ts |
| **P1** | A1 跨会话记忆注入 | AgentTool | 高 | 低 | AgentMemory context.ts |
| **P2** | C3 压缩质量反馈 | 架构 | 中 | 中 | AgentMemory compress.ts |
| **P2** | B3 压缩自适应尺寸 | 算法 | 中 | 中 | Headroom adaptive_sizer |
| **P2** | A2 行动链结晶 | AgentTool | 中 | 中 | AgentMemory crystallize.ts |
| **P3** | C4 压缩策略差异化 | 架构 | 中 | 低 | Headroom compression_policy |
| **P3** | B4 搜索语义扩展 | 算法 | 中 | 中 | AgentMemory search.ts |
| **P3** | A3 依赖感知排序 | AgentTool | 中 | 低 | AgentMemory frontier.ts |
| **P4** | B5 经验强化/衰减 | 算法 | 低 | 低 | AgentMemory lessons.ts |
| **P4** | C5 图级联失效 | 架构 | 低 | 中 | AgentMemory cascade.ts |

### 9.5 推荐实施路径

**Week 1** (P0 + P1):
- B1 记忆衰减: 新建 `memory/retention.ts`，集成到 `sessionMemoryCompact.ts`
- C2 缓存冻结区: 修改 `microCompact.ts`，增加 `frozenCount` 参数
- B2 记忆去重: 新建 `memory/dedup.ts`，集成到 `microCompact.ts`
- C1 记忆生命周期: 新建 `compact/memoryEviction.ts`，集成到 `autoCompact.ts`
- A1 跨会话记忆注入: 修改 `agentToolUtils.ts` 的 `buildAgentPrompt()`

**Week 2** (P2):
- C3 压缩质量反馈: 修改 `compact.ts`，增加质量验证层
- B3 压缩自适应: 修改 `microCompact.ts`，替换固定截断
- A2 行动链结晶: 修改 `runAgent.ts`，增加 `LearningSystem.crystallize()`

**Week 3** (P3):
- C4 压缩策略差异化: 新建 `CompressionPolicy.ts`
- B4 搜索语义扩展: 修改 `toolRanker.ts` 的 `extractTerms()`
- A3 依赖感知排序: 修改 `SingularityTool.ts`，新增 `agent_frontier` 操作

**Week 4** (P4 + 收尾):
- B5 经验强化/衰减: 修改 `LearningSystem.ts`
- C5 图级联失效: 新建 `CascadeInvalidator.ts`

---

## 10. v5 — TDD 深度评审修正（2026-06-07）

> 由 AgentTool 架构师 + 资深算法专家 + 系统架构师三位专家进行 TDD 深度评审后整合。
> 本节修正 v4 中的错误、补充遗漏、调整优先级，并为每个缺陷提供 TDD 测试设计。

### 10.1 关键修正汇总

| 缺陷 | v4 错误 | v5 修正 | 影响 |
|------|---------|---------|------|
| A1 | 集成点 `agentToolUtils.ts:buildAgentPrompt()` | 实际在 `promptTemplate.ts:47`，仅 built-in agent 用。正确注入点: `runAgent.ts:590-601` 的 `agentSystemPrompt` 构建后 | 高 — 注入到错误位置 |
| A2 | 触发条件 `score<60` | `runAgent.ts` 无 score 概念。正确触发: `validationGate verdict=FAIL/PARTIAL` 或 `qualityScan error-level` | 高 — 触发条件不存在 |
| A3 | ExecutionRecord 有 priority/edges | ExecutionRecord 只有 `skill/outcome/score/timestamp/duration_ms`，无 priority，无边数据 | 中 — 退化为 FIFO |
| B1 | λ=0.005 适用于 ola-cc | λ=0.005 对 1-3 小时会话衰减≈0。需要 λ≈0.5-2.0 | 高 — 衰减形同虚设 |
| B1 | `Σ(1/daysSinceAccess_i)` 强化项 | `daysSinceAccess→0` 时发散。需 `1/max(0.01, days)` 防护 | 中 — 高频访问记忆失去区分度 |
| B2 | Jaccard 去重 + 中文阈值 0.6 | `split(/\s+/)` 对中文产生单 token，Jaccard 恒为 0。需 bigram tokenizer | **致命** — 中文去重完全失效 |
| B4 | CJK bigram 切分 | `\b` 不匹配 CJK 边界，中文搜索路径完全失效。需移除 `\b` 约束 | **致命** — 中文搜索不可用 |
| B5 | `weeksSinceBaseline` 基线 | 实现用 `updatedAt` 做基线，每次 `save()` 重置衰减时钟 → 教训永不衰减 | 高 — 衰减机制无效 |
| C2 | 统一 frozenCount 参数 | microCompact 有两条路径: cached MC 不修改内容、time-based MC 才修改。frozenCount 仅适用于后者 | 高 — cached MC 路径不适用 |
| C5 | 级联失效集成到 IncrementalSync | `IncrementalSync.sync()` 是 `markDirty()` + `store.load()` 全量重载。级联失效在全量重载后无意义 | **根本矛盾** — 需 GraphStore 增量更新先行 |

### 10.2 Feature Flags

| Flag | 默认值 | 控制缺陷 | 回滚行为 |
|------|--------|---------|---------|
| `OLA_CC_RETENTION_DECAY` | false | B1 衰减 | 跳过衰减计算 |
| `OLA_CC_MEMORY_DEDUP` | false | B2 去重 | 跳过去重检查 |
| `OLA_CC_ADAPTIVE_COMPRESS` | false | B3 自适应 | 使用固定截断 |
| `OLA_CC_SEARCH_CJK` | false | B4 CJK 搜索 | 跳过 bigram 扩展 |
| `OLA_CC_LESSON_DECAY` | false | B5 教训衰减 | 跳过 confidence 衰减 |
| `OLA_CC_LESSONS_INJECT` | false | A1 注入 | 不注入 lessons |
| `OLA_CC_CRYSTALLIZE` | false | A2 结晶 | 不触发 crystallize |
| `OLA_CC_AGENT_FRONTIER` | false | A3 排序 | 使用默认排序 |
| `OLA_CC_MEMORY_LIFECYCLE` | false | C1 生命周期 | 恢复暴力截断 |
| `OLA_CC_FROZEN_ZONE` | false | C2 冻结区 | frozenCount=0 |
| `OLA_CC_COMPACT_QUALITY` | false | C3 质量反馈 | 跳过验证 |
| `OLA_CC_COMPRESSION_POLICY` | false | C4 策略差异化 | 硬编码 40K buffer |
| `OLA_CC_CASCADE_INVALIDATE` | false | C5 级联失效 | 跳过级联 |

所有 flag 通过 `isEnvTruthy()` + GrowthBook 双重控制，与 `autoCompact.ts` 现有模式一致。

### 10.3 TDD 测试设计

#### A1: 跨会话记忆注入

**验收标准:**
- Given: LearningSystem 有 5 条 orion-scoring 执行记录且 contrastAnalysis 返回有效 delta
- When: runAgent 启动 orion-scoring agent
- Then: agent system prompt 末尾包含 "## Lessons Learned"，总 token ≤ 2000

**前置条件（v4 遗漏）:**
1. `LearningSystem` 需 `enablePersistence: true`（默认 false）
2. 需调用 `loadFromDisk(skill)` 加载历史
3. `contrastAnalysis()` 返回中文 insight → 需翻译或统一语言

**单元测试 (5):**
1. `buildLessonsContext` 在 `delta === null` 时返回空字符串
2. `buildLessonsContext` 在有有效 delta 时返回格式化 markdown
3. `buildLessonsContext` 截断到 2000 token
4. `buildLessonsContext` 跳过 confidence < 0.3 的 lessons
5. `buildLessonsContext` 处理 LearningSystem 无历史记录

**集成测试 (2):**
1. 验证 lessons 注入后 `query()` 收到的 system prompt 包含 lessons 段落
2. 验证异步 agent 路径（`runAsyncAgentLifecycle`）同样注入

**风险修正:** 低 → **中**。lessons 注入增加 prompt token，低质量 insight（如"数据不足"）纯属浪费。增加质量门控: `delta !== null && scoreDelta > 10`。

#### A2: 行动链结晶

**验收标准:**
- Given: agent 执行 5 次 tool_use 后因 validationGate verdict=FAIL 终止
- When: runAgent post-completion 逻辑执行
- Then: 异步触发 crystallize，不阻塞返回，crystal 写入 JSONL

**关键修正:**
- ActionChain 数据源: 从 `agentMessages`（Message[]）提取 tool_use + tool_result 对，非 AgentMemory 的 Action[]
- `agentMessages` 在 `runAgent.ts:1223` 被清空 → crystallize 必须在此之前完成
- LLM provider: 需通过 `toolUseContext.options.mainLoopModel` + API client factory 构建
- abort 场景: agent 因 abort 终止时不触发 crystallize

**单元测试 (5):**
1. `extractActionChain` 从 agentMessages 正确提取 tool_use/tool_result 对
2. `extractActionChain` 跳过 stream_event 和 progress 消息
3. `shouldCrystallize` 在 verdict=FAIL 时返回 true
4. `shouldCrystallize` 在正常完成且无 error 时返回 false
5. `shouldCrystallize` 在 abort 时返回 false

**集成测试 (2):**
1. 验证 crystallize 异步执行不延迟 `finalizeAgentTool` 返回
2. 验证 `agentMessages` 在 crystallize 读取后才被清空

**风险修正:** 中 → **高**。在 finally 块中发起额外 LLM 转换: (1) 用户需等待; (2) abort 场景未处理; (3) agentMessages 清空时序风险。

#### A3: 依赖感知排序

**验收标准:**
- Given: ExecutionRecord 有 10 条记录、3 个 skill
- When: 调用 agent_frontier 操作
- Then: 按 score 降序排列，无 blocker 排在前面

**数据模型修正:** ExecutionRecord 无 priority/edges → 退化为 `age_hours*0.5 + score*0.1`。需扩展 ExecutionRecord 增加可选 `priority` 和 `edges` 字段。

**单元测试 (5):**
1. 无 edges 时按 `age_hours*0.5 + score*0.1` 排序
2. 有 unlockCount 时加分
3. 过滤 status=done
4. 空列表返回空
5. 全部 done 返回空

**风险:** 低（正确）。与 `knowledge_query`/`knowledge_extract` 有 API 重叠，需明确区别。

#### B1: 记忆衰减

**数学性质测试:**
- 衰减单调性: 固定 salience，R(t) 对 t 单调递减（无强化项时）
- 有界性: 0 ≤ R(t) ≤ 1
- 强化有界: daysSinceAccess→0 时 boost 有上限（`1/max(0.01, days)` 防护）

**边界测试:**
- `daysSinceAccess=0` → 不产生 NaN/Infinity
- `accessTimestamps=[]` → 返回 0
- `salience=0` → 返回纯强化项

**参数校准修正:**
- λ: 0.005 → **0.5**（小时级会话，30 分钟后衰减≈0.78）
- 强化防护: `Σ(1/days_i)` → `Σ(1/max(0.01, days_i))`

**性能基准:** N=500 条记忆，`computeRetention` < 5ms

#### B2: 记忆去重

**数学性质测试:**
- Jaccard 对称性: `j(a,b) = j(b,a)`
- 自相似: `j(a,a) = 1`
- 空集: `j("","") = 0`（当前返回 1，语义可疑）

**边界测试:**
- 纯中文 `"你好世界"` vs `"世界你好"` → 当前返回 0，bigram 修复后应 >0
- 单字符输入
- 超长输入 50KB

**CJK 修复（最高优先级）:** `split(/\s+/)` → bigram tokenizer。影响 B2 + B4 两个缺陷。

**性能基准:** K=200 条目去重 < 50ms

#### B3: 自适应压缩尺寸

**数学性质测试:**
- `find_knee` 对单调递增曲线返回 >0
- 对常数曲线返回 1
- 对严格凹曲线返回拐点

**边界测试:**
- 空数组 → n=0
- 单元素 → 返回 1
- 全相同 → 返回 min_k

**参数修正:** Kneedle `max_diff > 0.05` 过严，对 5-15 条高多样性 tool_result 退化为不压缩。建议 `max_diff > 0.02`。

**性能基准:** N=50 条、300 字符均值，`compute_optimal_k` < 10ms

#### B4: BM25 语义扩展

**数学性质测试:**
- 同义词扩展传递性: A→B, B→C 不自动 A→C
- CJK bigram 覆盖性

**边界测试:**
- 纯中文 `"搜索文件"` → 返回非零分数
- 混合中英文 `"read文件"` → 正确分词
- 空查询 → 返回全量工具

**CJK 修复:** `\b` 不匹配 CJK → 移除 `\b` 约束或改用 `(?:^|\s|${term})`。同义词限定为精确匹配。

**性能基准:** 53 工具 + 10 同义词扩展，`rankTools` < 5ms

#### B5: 经验教训强化/衰减

**数学性质测试:**
- 强化单调性: 连续强化 confidence 只增不减
- 衰减单调性: 无强化时 confidence 随时间递减
- 有界性: `0.05 ≤ confidence ≤ 1.0`

**边界测试:**
- `confidence=0` 强化后 = 0.1
- `confidence=1` 强化后仍 = 1.0
- `weeks=0` 无衰减
- `decayRate=0` 无衰减

**关键修正:**
- 衰减基线: `updatedAt` → `lastDecayedAt || lastReinforcedAt || createdAt`
- 强化频率限制: 高频调用场景（每分钟多次）需增加冷却期，避免强化完全抵消衰减
- recall 评分: `text.includes(term)` → 词边界匹配

**性能基准:** K=200 教训，`decaySweep()` < 10ms，`recall()` < 5ms

#### C1-C5 架构 TDD（详见 Headroom 方案 10.3 节）

### 10.4 修正后的优先级矩阵

| 优先级 | 缺陷 | v4 优先级 | v5 修正 | 原因 |
|--------|------|-----------|---------|------|
| **P0** | B2 CJK 去重 | P1 | **P0** | 中文场景核心功能完全失效 |
| **P0** | B4 CJK 搜索 | P3 | **P0** | 中文场景核心功能完全失效 |
| **P0** | B1 衰减参数 | P0 | P0 | λ 参数校准 + 奇点修复 |
| **P0** | C2 冻结区 | P0 | P0 | 仅修正为 time-based MC 路径 |
| **P1** | B5 衰减基线 | P4 | **P1** | updatedAt 重置导致永不衰减 |
| **P1** | A1 注入点 | P1 | P1 | 修正集成点 + 前置条件 |
| **P1** | C1 生命周期 | P1 | P1 | 增加并发保护 |
| **P2** | A2 结晶 | P2 | P2 | 风险升为高，增加 abort 处理 |
| **P2** | C3 质量反馈 | P2 | P2 | 验证移入重试循环内部 |
| **P2** | B3 自适应 | P2 | P2 | Kneedle 阈值放宽 |
| **P3** | C4 策略差异化 | P3 | P3 | 与 env var 优先级需明确 |
| **P3** | A3 排序 | P3 | P3 | 数据模型需扩展 |
| **P4** | C5 级联失效 | P4 | **P4+** | 根本矛盾: 全量重载下无意义，需 GraphStore 增量更新先行 |

### 10.5 修正后的实施路径

**Phase 1 — CJK 基础修复（1-2 天）:**
1. 实现 `tokenizeCJK(text)` bigram tokenizer（B2 + B4 共用）
2. 修复 `jaccardSimilarity` 使用 bigram
3. 修复 `toolRanker.ts` 的 `\b` 问题
4. 测试: 纯中文去重/搜索回归测试

**Phase 2 — P0 算法修复（3-5 天）:**
1. B1 衰减: 修复 `Σ(1/days)` 奇点 + λ 校准
2. C2 冻结区: 仅修改 time-based MC 路径，frozenCount 在 `query.ts` 预计算
3. B5 衰减基线: `updatedAt` → `lastDecayedAt`

**Phase 3 — AgentTool 集成（1 周）:**
1. A1: 修正注入点到 `runAgent.ts:600`，增加前置条件和质量门控
2. A2: 增加 abort 处理，调整 agentMessages 清空时序
3. C1: 增加 MEMORY.md 读写并发保护

**Phase 4 — 质量增强（1 周）:**
1. C3: 质量验证嵌入重试循环
2. B3: Kneedle 阈值放宽 + SimHash 短文本优化
3. C4: CompressionPolicy + env var 优先级

**Phase 5 — 高级功能（1 周）:**
1. A3: ExecutionRecord 扩展 + agent_frontier
2. C5: 降级为 P4+，等待 GraphStore 增量更新支持

---

## 11. v6 — 第六轮深度评审修正（2026-06-07）

> 三位专家对 v5 进行验证性评审，确认核心修正正确，发现 18 个遗留问题。

### 11.1 v5 核心修正验证结论

| v5 修正 | 验证结果 | 说明 |
|---------|---------|------|
| A1 注入点 → `runAgent.ts:590-601` | ✅ 正确 | 该位置是所有 agent 的公共路径 |
| A2 触发 → validationGate verdict | ✅ 正确 | `runAgent.ts` 无 score 概念 |
| B1 λ=0.5 | ✅ 正确 | 1h 衰减≈2%，3h≈6%，30d≈0，尺度合理 |
| B2/B4 CJK 失效 | ✅ 正确 | `split(/\s+/)` 和 `\b` 确实对中文无效 |
| B5 衰减基线 | ✅ 正确 | 与 `lessons.ts:226` 源码一致 |
| C2 双路径 | ✅ 正确 | cached MC 不修改内容，frozenCount 仅适用 time-based |
| C5 根本矛盾 | ✅ 正确 | `IncrementalSync.sync()` 确实是全量重载 |

### 11.2 新发现的问题（18 项）

#### AgentTool 架构师发现（D1-D6）

**D1 [严重]: `agentMessages` 变量不存在**

v5 A2 结晶依赖 `agentMessages`（Message[]）作为数据源，但 `runAgent.ts` 中**不存在此变量**。第 1223 行清空的是 `initialMessages`，query() 是 AsyncGenerator，消息逐条 yield，从未收集到数组。

**修正**: 在 query 循环中新增 `const agentMessages: Message[] = []`，在 `isRecordableMessage` 分支中 push。在 validation gate 前（非 finally 中）触发 crystallize。

**D2 [中等]: A2 abort 场景已自动处理**

runAgent 的 abort 处理在 1008-1009 行: `throw new AbortError()`，直接进入 finally 块，跳过 validation gate。abort 时不触发 crystallize 是控制流自动保证的，不需要显式检查。v5 TDD 测试用例 5（"shouldCrystallize 在 abort 时返回 false"）暗示需显式条件，实际不需要。

**D3 [低等]: A1 注入被 override.systemPrompt 绕过**

`runAgent.ts:591`: `const agentSystemPrompt = override?.systemPrompt ? override.systemPrompt : ...`。当调用者提供 `override.systemPrompt` 时，`getAgentSystemPrompt()` 不被调用，lessons 注入被跳过。AgentTool.tsx 的 fork 路径会传入 override.systemPrompt。

**修正**: 在 `override.systemPrompt` 分支也追加 lessons，或在 `agentSystemPrompt` 构建后的统一位置注入。

**D4 [中等]: B5 强化冷却期缺少实现方案**

v5 提到"高频调用场景需增加冷却期"但未给出方案。建议: 同一 fingerprint 的强化间隔不低于 1 小时，通过 `lastReinforcedAt` 时间戳判断。

**D5 [低等]: 缺少 `OLA_CC_CRYSTALLIZE_COLLECT` flag**

A2 需要在 query 循环中收集 messages（D1 的方案），这是独立的性能敏感操作，应有独立 flag。

**D6 [低等]: CJK bigram 空集语义**

bigram tokenizer 对空字符串返回空 Set，两个空 Set 的 Jaccard 返回 0（当前实现 union=0 时返回 0）。应明确为预期行为并添加测试。

#### 算法专家发现（B1-2, B-CJK-1/2, B3-1, B5-1/2）

**B1-2 [中等]: 多访问叠加 boost 无总上限**

accessTimestamps = [now, now, ...] × 50 时，boost = 0.3 × 50 × 100 = 1500，被 min 截断到 1.0。数学有界但语义上需确认是否合理。

**修正**: 增加 `boost = min(boost, MAX_BOOST)` 或限制 accessTimestamps 窗口大小（如最近 30 天）。

**B-CJK-1 [高]: bigram tokenizer 缺少预处理规范**

v5 未指定: 标点处理（`", "` 成为 bigram）、数字处理（`"read123file"` 数字干扰）、中英混合（`"read文件"` 需分段）。

**修正 tokenizer 规范:**
- ASCII 段: 保留原有 `split(/\s+/)` 逻辑（单词级 token）
- CJK 段: 连续 CJK 字符按 bigram 切分
- 非字母数字字符（标点等）作为分隔符

**B-CJK-2 [中等]: toolRanker `\b` 移除导致 ASCII 误匹配**

直接移除 `\b` 使 `"file"` 匹配 `"profile"`。

**修正**: CJK 字符不加 `\b`，ASCII 保留 `\b`。判断 term 是否含 CJK 字符来决定是否添加 word boundary。

**B3-1 [中等]: Kneedle 0.02 阈值缺少 diversity 保护**

Headroom 原始 Rust 代码有 `diversity_ratio > 0.7` 的高多样性保护（`adaptive_sizer.rs:84-91`）。v5 降低阈值但未引入此保护。

**修正**: 移植 Rust 代码的 floor 逻辑: `floor = min_k.max(n * (0.3 + 0.7 * diversity))`。

**B5-1 [低等]: 新建教训首次 sweep 前强化重置衰减**

当 `lastDecayedAt` 不存在时，baseline 回退到 `lastReinforcedAt`，强化会重置衰减时钟。增加 TDD 测试覆盖。

**B5-2 [中等]: decay-sweep 1 周最小门槛与 λ=0.5 尺度不匹配**

源码 `lessons.ts:230` 的 `if (weeksSinceBaseline < 1) continue` 意味着教训需存活 1 周才开始衰减。与 λ=0.5（小时级衰减）设计冲突。

**修正**: ola-cc 实现时移除 1 周最小门槛，或改为可配置参数（如 `minDecayAgeHours=1`）。

#### 系统架构师发现（R6-1 到 R6-6）

**R6-1 [中等]: `sequential()` 是 per-function 包装器，非全局锁**

驱逐扫描和 MEMORY.md 写入如果用两个独立的 `sequential()` 包装，之间没有互斥。

**修正**: 将驱逐+写入合并为同一个 `sequential()` 包装的原子操作。`buildMemoryPrompt` 的同步读取在 Node.js 单线程模型下天然安全（sync 期间不会 yield），实际风险低于描述。

**R6-2 [中等]: frozenCount 预计算与 `claude.ts` 耦合**

`cache_control` 标记在 `claude.ts:631-691` 的 `getCacheControl()` 中设置，在 API 请求构建阶段。microCompact 在请求**之前**调用。预计算 frozenCount 需要复制 `claude.ts` 的 cache key 逻辑，引入隐式依赖。

**修正**: frozenCount 不在 `query.ts` 预计算。改为在 `microcompactMessages` 内部检查 messages 中已有的 cache_control 标记，或作为 `claude.ts` 构建请求时的副产品输出，传递给下一轮 microCompact。

**R6-3 [中等]: 质量验证复用 PTL 重试会导致不必要截断**

`compact.ts:477` 的 PTL 重试循环在失败时会 `truncateHeadForPTLRetry`（丢弃最旧消息组）。质量不达标时应用相同 messages 重新生成，不应截断。

**修正**: 质量验证需要独立的重试逻辑。在 `streamCompactSummary` 返回后增加质量检查，失败时用原始 messages 重试，最多 1 次，使用独立计数器。

**R6-4 [高]: GrowthBook `auto_compact_buffer_tokens` flag 不存在**

`autoCompact.ts` 中不存在此 GrowthBook flag。buffer 是硬编码 `AUTOCOMPACT_BUFFER_TOKENS = 40_000`。唯一运行时覆盖是 `OLA_CC_AUTO_COMPACT_WINDOW` 环境变量（覆盖 context window，非 buffer）。

**修正**: C4 优先级链修正为: `OLA_CC_AUTO_COMPACT_WINDOW` > CompressionPolicy 按 tier 计算 > 硬码 40K。如需 GrowthBook 层，需先在 `autoCompact.ts` 中添加 feature value 调用。

**R6-5 [低等]: 两个方案 Phase 独立编号导致跨方案依赖不清晰**

B1 在 Headroom Phase 2，B2 在 AgentMemory Phase 1，但 B1 的 retention 评分依赖 B2 的去重。

**修正**: 合并为统一 Phase 路径图（见 11.4 节）。

**R6-6 [中等]: Feature flag 间 3 个未标注的隐含依赖**

1. `OLA_CC_MEMORY_LIFECYCLE` (C1) **依赖** `OLA_CC_RETENTION_DECAY` (B1) — 无 retention 评分时驱逐退化为随机
2. `OLA_CC_LESSONS_INJECT` (A1) **依赖** `OLA_CC_LESSON_DECAY` (B5) — 不衰减则低质量教训永久注入
3. `OLA_CC_COMPACT_QUALITY` (C3) **依赖** `OLA_CC_COMPRESSION_POLICY` (C4) — 质量阈值因 tier 而异

### 11.3 修正后的 Feature Flags（含依赖）

| Flag | 默认值 | 控制 | 依赖 Flag |
|------|--------|------|-----------|
| `OLA_CC_RETENTION_DECAY` | false | B1 衰减 | — |
| `OLA_CC_MEMORY_DEDUP` | false | B2 去重 | — |
| `OLA_CC_ADAPTIVE_COMPRESS` | false | B3 自适应 | — |
| `OLA_CC_SEARCH_CJK` | false | B4 CJK 搜索 | — |
| `OLA_CC_LESSON_DECAY` | false | B5 教训衰减 | — |
| `OLA_CC_LESSONS_INJECT` | false | A1 注入 | `OLA_CC_LESSON_DECAY` |
| `OLA_CC_CRYSTALLIZE` | false | A2 结晶 | — |
| `OLA_CC_CRYSTALLIZE_COLLECT` | false | A2 消息收集 | — |
| `OLA_CC_AGENT_FRONTIER` | false | A3 排序 | — |
| `OLA_CC_MEMORY_LIFECYCLE` | false | C1 生命周期 | `OLA_CC_RETENTION_DECAY` |
| `OLA_CC_FROZEN_ZONE` | false | C2 冻结区 | — |
| `OLA_CC_COMPACT_QUALITY` | false | C3 质量反馈 | `OLA_CC_COMPRESSION_POLICY` |
| `OLA_CC_COMPRESSION_POLICY` | false | C4 策略差异化 | — |
| `OLA_CC_CASCADE_INVALIDATE` | false | C5 级联失效 | — |

### 11.4 统一实施路径（合并两方案）

**Phase 1 — CJK 基础 + P0 算法（1 周）:**
1. `tokenizeCJK()` bigram tokenizer（ASCII 保留单词级，CJK 按 bigram，标点为分隔符）
2. B2: `jaccardSimilarity` 使用新 tokenizer
3. B4: `toolRanker.ts` — CJK 字符不加 `\b`，ASCII 保留 `\b`
4. B1: `Σ(1/days)` 奇点 `1/max(0.01, days)` + λ=0.5 + boost 总上限
5. C2: frozenCount 仅 time-based MC 路径，从 messages 中已有的 cache_control 标记计算

**Phase 2 — P1 修复（1 周）:**
1. B5: `updatedAt` → `lastDecayedAt` + 移除 1 周最小门槛 + 冷却期（1 小时）
2. A1: 注入点 `runAgent.ts:600`，处理 `override.systemPrompt` 分支，增加质量门控
3. C1: MEMORY.md retention 评分决定哪 200 行 + 驱逐+写入合并为单一 `sequential()` 原子操作

**Phase 3 — 质量增强（1 周）:**
1. C3: 质量验证独立重试（非 PTL 重试），最多 1 次
2. C4: CompressionPolicy 优先级链: env var > Policy > 40K
3. B3: Kneedle `max_diff > 0.02` + diversity floor 保护

**Phase 4 — AgentTool 集成（1 周）:**
1. A2: query 循环中收集 agentMessages + validation gate 前触发 crystallize + 独立 flag
2. A3: ExecutionRecord 扩展 + agent_frontier

**Phase 5 — 延后（待定）:**
1. C5: GraphStore 增量更新改造（3-5 天）后实施级联失效

### 11.5 新增 TDD 测试（v6 补充）

| 缺陷 | 新增测试 | 类型 |
|------|---------|------|
| D1 | query 循环中 agentMessages 收集正确性 | 集成 |
| D3 | override.systemPrompt 时 lessons 仍注入 | 边界 |
| B1-2 | 50 次近期访问 boost 有上限 | 边界 |
| B-CJK-1 | `"hello, world"` 标点处理；`"read123file"` 数字处理；`"read文件"` 混合分段 | 边界 |
| B-CJK-2 | `"file"` 不匹配 `"profile"`；`"文件"` 匹配 `"文件管理"` | 回归 |
| B3-1 | 高多样性（diversity>0.7）时不过度压缩 | 数学性质 |
| B5-1 | `createdAt=7天前, lastDecayedAt=undefined, lastReinforcedAt=1天前` → baseline=1天前 | 边界 |
| B5-2 | 教训存活 1 天后即可被衰减（无 1 周门槛） | 回归 |
| R6-3 | 质量验证失败用原始 messages 重试（非截断后） | 集成 |
| R6-4 | CompressionPolicy 计算值被 env var 覆盖 | 集成 |
| R6-6 | `MEMORY_LIFECYCLE=1` + `RETENTION_DECAY=0` 时驱逐退化为时间戳排序 | 边界 |
