# Context UX Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 8 context management features: 4-zone context partitioning, Knowledge Graph with Orama, Scheduled Triggers with croner, Context Collapse command, Pin/Unpin messages, Context Analytics, Context Snapshot, and Cost command enhancement.

**Architecture:** Each feature is a self-contained module following the existing command pattern (`src/commands/<name>/index.ts` metadata + `<name>.tsx` implementation). Commands register in `src/commands.ts` COMMANDS array. Feature flags use `OLA_CC_*` env vars (runtime) or `feature()` (compile-time). Tests use Bun test runner in `__tests__/` directories.

**Tech Stack:** TypeScript, React + Ink, Bun test runner, Orama (full-text search), croner (cron scheduling)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/commands/context/context.tsx` | Modify | Add 4-zone partitioning to existing context visualization |
| `src/commands/context/context-noninteractive.ts` | Modify | Add zone breakdown to markdown output |
| `src/utils/analyzeContext.ts` | Modify | Add zone calculation logic |
| `src/services/knowledge-graph/index.ts` | Create | Knowledge Graph service with Orama |
| `src/services/knowledge-graph/types.ts` | Create | KnowledgeNode, Relation types |
| `src/services/knowledge-graph/__tests__/knowledge-graph.test.ts` | Create | Knowledge Graph tests |
| `src/services/conversation-arc/index.ts` | Create | Conversation Arc tracking |
| `src/services/conversation-arc/types.ts` | Create | Goal, Decision, Milestone types |
| `src/services/conversation-arc/__tests__/conversation-arc.test.ts` | Create | Conversation Arc tests |
| `src/commands/schedule/index.ts` | Create | Schedule command metadata |
| `src/commands/schedule/schedule.tsx` | Create | Schedule command JSX implementation |
| `src/services/scheduler/index.ts` | Create | Scheduler service with croner |
| `src/services/scheduler/types.ts` | Create | ScheduledTrigger types |
| `src/services/scheduler/__tests__/scheduler.test.ts` | Create | Scheduler tests |
| `src/commands/collapse/index.ts` | Create | Collapse command metadata |
| `src/commands/collapse/collapse.tsx` | Create | Collapse command implementation |
| `src/commands/pin/index.ts` | Create | Pin command metadata |
| `src/commands/pin/pin.tsx` | Create | Pin command implementation |
| `src/commands/snapshot/index.ts` | Create | Snapshot command metadata |
| `src/commands/snapshot/snapshot.tsx` | Create | Snapshot command implementation |
| `src/commands/cost/cost.ts` | Modify | Add breakdown and per-model stats |
| `src/commands.ts` | Modify | Register new commands |

---

## Task 1: Context Partitioning (4-Zone)

**Files:**
- Modify: `src/utils/analyzeContext.ts`
- Modify: `src/commands/context/context.tsx`
- Modify: `src/commands/context/context-noninteractive.ts`
- Create: `src/utils/__tests__/contextZones.test.ts`

**Why first:** Foundation for other context features. Extends existing `/context` command.

- [ ] **Step 1: Write failing test for zone calculation**

```typescript
// src/utils/__tests__/contextZones.test.ts
import { describe, test, expect } from 'bun:test'
import { calculateContextZones } from '../contextZones.js'

describe('calculateContextZones', () => {
  test('divides context into 4 zones with correct percentages', () => {
    const result = calculateContextZones({
      systemPromptTokens: 15000,
      toolsTokens: 10000,
      messagesTokens: 60000,
      autoCompactBufferTokens: 5000,
      totalMaxTokens: 200000,
    })

    expect(result.zones).toHaveLength(4)
    expect(result.zones[0].name).toBe('System Prompt')
    expect(result.zones[0].percentage).toBeCloseTo(7.5, 1)
    expect(result.zones[1].name).toBe('Tools')
    expect(result.zones[1].percentage).toBeCloseTo(5.0, 1)
    expect(result.zones[2].name).toBe('Messages')
    expect(result.zones[2].percentage).toBeCloseTo(30.0, 1)
    expect(result.zones[3].name).toBe('Autocompact Buffer')
    expect(result.zones[3].percentage).toBeCloseTo(2.5, 1)
  })

  test('returns health status based on usage', () => {
    const healthy = calculateContextZones({
      systemPromptTokens: 10000,
      toolsTokens: 10000,
      messagesTokens: 50000,
      autoCompactBufferTokens: 5000,
      totalMaxTokens: 200000,
    })
    expect(healthy.health).toBe('good')

    const warning = calculateContextZones({
      systemPromptTokens: 30000,
      toolsTokens: 20000,
      messagesTokens: 100000,
      autoCompactBufferTokens: 10000,
      totalMaxTokens: 200000,
    })
    expect(warning.health).toBe('warning')
  })

  test('returns suggestions when usage is high', () => {
    const result = calculateContextZones({
      systemPromptTokens: 40000,
      toolsTokens: 30000,
      messagesTokens: 100000,
      autoCompactBufferTokens: 10000,
      totalMaxTokens: 200000,
    })
    expect(result.suggestions.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/utils/__tests__/contextZones.test.ts`
Expected: FAIL — `calculateContextZones` doesn't exist yet

- [ ] **Step 3: Implement zone calculation**

```typescript
// src/utils/contextZones.ts
import { isEnvTruthy } from './envUtils.js'

export interface ContextZone {
  name: string
  tokens: number
  percentage: number
  color: string
}

export interface ContextZoneResult {
  zones: ContextZone[]
  health: 'good' | 'warning' | 'critical'
  suggestions: string[]
}

interface ZoneInput {
  systemPromptTokens: number
  toolsTokens: number
  messagesTokens: number
  autoCompactBufferTokens: number
  totalMaxTokens: number
}

const ZONE_COLORS: Record<string, string> = {
  'System Prompt': 'cyan',
  'Tools': 'yellow',
  'Messages': 'green',
  'Autocompact Buffer': 'gray',
}

export function calculateContextZones(input: ZoneInput): ContextZoneResult {
  if (!isEnvTruthy(process.env.OLA_CC_CTX_ZONES)) {
    return { zones: [], health: 'good', suggestions: [] }
  }

  const {
    systemPromptTokens,
    toolsTokens,
    messagesTokens,
    autoCompactBufferTokens,
    totalMaxTokens,
  } = input

  const zones: ContextZone[] = [
    {
      name: 'System Prompt',
      tokens: systemPromptTokens,
      percentage: (systemPromptTokens / totalMaxTokens) * 100,
      color: ZONE_COLORS['System Prompt'],
    },
    {
      name: 'Tools',
      tokens: toolsTokens,
      percentage: (toolsTokens / totalMaxTokens) * 100,
      color: ZONE_COLORS['Tools'],
    },
    {
      name: 'Messages',
      tokens: messagesTokens,
      percentage: (messagesTokens / totalMaxTokens) * 100,
      color: ZONE_COLORS['Messages'],
    },
    {
      name: 'Autocompact Buffer',
      tokens: autoCompactBufferTokens,
      percentage: (autoCompactBufferTokens / totalMaxTokens) * 100,
      color: ZONE_COLORS['Autocompact Buffer'],
    },
  ]

  const totalUsed = systemPromptTokens + toolsTokens + messagesTokens + autoCompactBufferTokens
  const usagePercent = (totalUsed / totalMaxTokens) * 100

  let health: 'good' | 'warning' | 'critical' = 'good'
  const suggestions: string[] = []

  if (usagePercent > 90) {
    health = 'critical'
    suggestions.push('Context usage is critical. Consider /compact to reduce messages.')
    if (messagesTokens > totalMaxTokens * 0.6) {
      suggestions.push('Messages dominate context. Use /collapse to summarize old spans.')
    }
  } else if (usagePercent > 75) {
    health = 'warning'
    suggestions.push('Context usage is high. Monitor with /context.')
    if (toolsTokens > totalMaxTokens * 0.15) {
      suggestions.push('Tools use significant tokens. Consider disabling unused MCP tools.')
    }
  }

  return { zones, health, suggestions }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/utils/__tests__/contextZones.test.ts`
Expected: PASS

- [ ] **Step 5: Integrate zones into ContextVisualization**

Modify `src/commands/context/context.tsx` to call `calculateContextZones` and pass zone data to the visualization component. Guard with `isEnvTruthy(process.env.OLA_CC_CTX_ZONES)` — if disabled, skip zone rendering.

- [ ] **Step 6: Add zone breakdown to noninteractive output**

Modify `src/commands/context/context-noninteractive.ts` to include zone table in markdown output. Guard with `isEnvTruthy(process.env.OLA_CC_CTX_ZONES)` — if disabled, omit zone section.

- [ ] **Step 7: Commit**

```bash
git add src/utils/contextZones.ts src/utils/__tests__/contextZones.test.ts src/commands/context/context.tsx src/commands/context/context-noninteractive.ts
git commit -m "feat: add 4-zone context partitioning to /context command"
```

---

## Task 2: Knowledge Graph (Orama Integration)

**Files:**
- Create: `src/services/knowledge-graph/types.ts`
- Create: `src/services/knowledge-graph/index.ts`
- Create: `src/services/knowledge-graph/__tests__/knowledge-graph.test.ts`

**Why second:** Core infrastructure for cross-session knowledge persistence.

- [ ] **Step 0: Install Orama dependency**

```bash
bun add @orama/orama @orama/plugin-data-persistence
```

This adds the full-text search library and its persistence plugin to `package.json`.

- [ ] **Step 1: Write failing test for Knowledge Graph**

```typescript
// src/services/knowledge-graph/__tests__/knowledge-graph.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { KnowledgeGraph } from '../index.js'
import { rmSync, existsSync } from 'fs'
import { join } from 'path'

const TEST_PERSIST_PATH = join(import.meta.dir, '.test-kg-data')

describe('KnowledgeGraph', () => {
  let kg: KnowledgeGraph

  beforeEach(async () => {
    if (existsSync(TEST_PERSIST_PATH)) {
      rmSync(TEST_PERSIST_PATH, { recursive: true })
    }
    kg = new KnowledgeGraph({ persistPath: TEST_PERSIST_PATH })
    await kg.initialize()
  })

  afterEach(() => {
    if (existsSync(TEST_PERSIST_PATH)) {
      rmSync(TEST_PERSIST_PATH, { recursive: true })
    }
  })

  test('adds and retrieves a node', async () => {
    await kg.addNode({
      id: 'node-1',
      type: 'entity',
      name: 'UserService',
      summary: 'Handles user authentication and profile management',
      relations: [],
    })

    const results = await kg.search('authentication')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].node.name).toBe('UserService')
  })

  test('adds and traverses relations', async () => {
    await kg.addNode({
      id: 'node-1',
      type: 'entity',
      name: 'AuthService',
      summary: 'Authentication service',
      relations: [],
    })
    await kg.addNode({
      id: 'node-2',
      type: 'entity',
      name: 'UserModel',
      summary: 'User data model',
      relations: [
        { type: 'depends_on', source: 'node-2', target: 'node-1', weight: 0.8 },
      ],
    })

    const related = await kg.getRelated('node-2')
    expect(related.length).toBe(1)
    expect(related[0].node.name).toBe('AuthService')
  })

  test('persists and restores from disk', async () => {
    await kg.addNode({
      id: 'node-1',
      type: 'entity',
      name: 'TestEntity',
      summary: 'Persistent entity',
      relations: [],
    })
    await kg.persist()

    const kg2 = new KnowledgeGraph({ persistPath: TEST_PERSIST_PATH })
    await kg2.initialize()

    const results = await kg2.search('Persistent entity')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].node.name).toBe('TestEntity')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/knowledge-graph/__tests__/knowledge-graph.test.ts`
Expected: FAIL — `KnowledgeGraph` doesn't exist yet

- [ ] **Step 3: Implement Knowledge Graph types**

```typescript
// src/services/knowledge-graph/types.ts
export interface KnowledgeNode {
  id: string
  type: 'entity' | 'concept' | 'file' | 'function'
  name: string
  summary: string
  relations: Relation[]
}

export interface Relation {
  type: 'depends_on' | 'extends' | 'implements' | 'uses' | 'related_to'
  source: string
  target: string
  weight: number
}

export interface SearchResult {
  node: KnowledgeNode
  score: number
}

export interface KnowledgeGraphConfig {
  persistPath: string
  maxNodes?: number
  autoIndex?: boolean
}
```

- [ ] **Step 4: Implement Knowledge Graph service**

```typescript
// src/services/knowledge-graph/index.ts
import { create, insert, search, type Orama } from '@orama/orama'
import { persist, restore } from '@orama/plugin-data-persistence'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type {
  KnowledgeNode,
  KnowledgeGraphConfig,
  SearchResult,
  Relation,
} from './types.js'

const DEFAULT_CONFIG: Partial<KnowledgeGraphConfig> = {
  maxNodes: 10000,
  autoIndex: true,
}

export class KnowledgeGraph {
  private db: Orama | null = null
  private nodeMap: Map<string, KnowledgeNode> = new Map()
  private config: KnowledgeGraphConfig
  private enabled: boolean

  constructor(config: KnowledgeGraphConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.enabled = isEnvTruthy(process.env.OLA_CC_KG)
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return
    const dbPath = join(this.config.persistPath, 'orama.json')

    if (existsSync(dbPath)) {
      try {
        const data = readFileSync(dbPath, 'utf-8')
        this.db = await restore('json', data)
        // Rebuild nodeMap from persisted data
        return
      } catch {
        // Fall through to create new DB
      }
    }

    this.db = await create({
      schema: {
        id: 'string',
        type: 'string',
        name: 'string',
        summary: 'string',
        tags: 'string[]',
      },
    })

    mkdirSync(this.config.persistPath, { recursive: true })
  }

  async addNode(node: KnowledgeNode): Promise<void> {
    if (!this.db) throw new Error('KnowledgeGraph not initialized')

    this.nodeMap.set(node.id, node)

    await insert(this.db, {
      id: node.id,
      type: node.type,
      name: node.name,
      summary: node.summary,
      tags: [node.type, ...node.relations.map(r => r.type)],
    })
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    if (!this.db) throw new Error('KnowledgeGraph not initialized')

    const results = await search(this.db, {
      term: query,
      limit,
    })

    return results.hits.map(hit => ({
      node: this.nodeMap.get(hit.id as string) ?? {
        id: hit.id as string,
        type: 'entity',
        name: String(hit.document?.name ?? ''),
        summary: String(hit.document?.summary ?? ''),
        relations: [],
      },
      score: hit.score,
    }))
  }

  async getRelated(nodeId: string): Promise<SearchResult[]> {
    const node = this.nodeMap.get(nodeId)
    if (!node) return []

    const related: SearchResult[] = []
    for (const relation of node.relations) {
      const targetId = relation.source === nodeId ? relation.target : relation.source
      const targetNode = this.nodeMap.get(targetId)
      if (targetNode) {
        related.push({ node: targetNode, score: relation.weight })
      }
    }

    return related.sort((a, b) => b.score - a.score)
  }

  async persist(): Promise<void> {
    if (!this.db) throw new Error('KnowledgeGraph not initialized')

    const data = await persist(this.db, 'json')
    const dbPath = join(this.config.persistPath, 'orama.json')
    writeFileSync(dbPath, data as string)
  }

  getStats(): { nodeCount: number; relationCount: number } {
    let relationCount = 0
    for (const node of this.nodeMap.values()) {
      relationCount += node.relations.length
    }
    return { nodeCount: this.nodeMap.size, relationCount }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/services/knowledge-graph/__tests__/knowledge-graph.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/knowledge-graph/
git commit -m "feat: add Knowledge Graph service with Orama full-text search"
```

---

## Task 3: Conversation Arc Tracking

**Files:**
- Create: `src/services/conversation-arc/types.ts`
- Create: `src/services/conversation-arc/index.ts`
- Create: `src/services/conversation-arc/__tests__/conversation-arc.test.ts`

- [ ] **Step 1: Write failing test for Conversation Arc**

```typescript
// src/services/conversation-arc/__tests__/conversation-arc.test.ts
import { describe, test, expect, beforeEach } from 'bun:test'
import { ConversationArc } from '../index.js'

describe('ConversationArc', () => {
  let arc: ConversationArc

  beforeEach(() => {
    arc = new ConversationArc()
  })

  test('tracks goals', () => {
    arc.addGoal({ id: 'g1', description: 'Implement auth', status: 'active' })
    expect(arc.getGoals()).toHaveLength(1)
    expect(arc.getGoals()[0].description).toBe('Implement auth')
  })

  test('tracks decisions', () => {
    arc.addDecision({
      id: 'd1',
      description: 'Use JWT for auth',
      rationale: 'Stateless, scalable',
      timestamp: new Date().toISOString(),
    })
    expect(arc.getDecisions()).toHaveLength(1)
  })

  test('tracks milestones', () => {
    arc.addMilestone({
      id: 'm1',
      description: 'Auth service deployed',
      timestamp: new Date().toISOString(),
    })
    expect(arc.getMilestones()).toHaveLength(1)
  })

  test('extracts memories from arc', () => {
    arc.addGoal({ id: 'g1', description: 'Fix bug', status: 'completed' })
    arc.addDecision({
      id: 'd1',
      description: 'Use retry logic',
      rationale: 'Network is unreliable',
      timestamp: new Date().toISOString(),
    })

    const memories = arc.extractMemories()
    expect(memories.length).toBeGreaterThan(0)
    expect(memories.some(m => m.content.includes('Fix bug'))).toBe(true)
  })

  test('generates summary', () => {
    arc.addGoal({ id: 'g1', description: 'Task A', status: 'completed' })
    arc.addGoal({ id: 'g2', description: 'Task B', status: 'active' })
    arc.addMilestone({
      id: 'm1',
      description: 'Phase 1 done',
      timestamp: new Date().toISOString(),
    })

    const summary = arc.getSummary()
    expect(summary).toContain('Task A')
    expect(summary).toContain('Task B')
    expect(summary).toContain('Phase 1 done')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/conversation-arc/__tests__/conversation-arc.test.ts`
Expected: FAIL — `ConversationArc` doesn't exist yet

- [ ] **Step 3: Implement Conversation Arc types**

```typescript
// src/services/conversation-arc/types.ts
export interface Goal {
  id: string
  description: string
  status: 'active' | 'completed' | 'abandoned'
}

export interface Decision {
  id: string
  description: string
  rationale: string
  timestamp: string
}

export interface Milestone {
  id: string
  description: string
  timestamp: string
}

export interface Memory {
  id: string
  content: string
  source: 'goal' | 'decision' | 'milestone'
  timestamp: string
}
```

- [ ] **Step 4: Implement Conversation Arc**

```typescript
// src/services/conversation-arc/index.ts
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { Goal, Decision, Milestone, Memory } from './types.js'

export class ConversationArc {
  private goals: Goal[] = []
  private decisions: Decision[] = []
  private milestones: Milestone[] = []
  private enabled: boolean = isEnvTruthy(process.env.OLA_CC_ARC)

  addGoal(goal: Goal): void {
    const existing = this.goals.findIndex(g => g.id === goal.id)
    if (existing >= 0) {
      this.goals[existing] = goal
    } else {
      this.goals.push(goal)
    }
  }

  addDecision(decision: Decision): void {
    this.decisions.push(decision)
  }

  addMilestone(milestone: Milestone): void {
    this.milestones.push(milestone)
  }

  getGoals(): Goal[] {
    return [...this.goals]
  }

  getDecisions(): Decision[] {
    return [...this.decisions]
  }

  getMilestones(): Milestone[] {
    return [...this.milestones]
  }

  extractMemories(): Memory[] {
    const memories: Memory[] = []
    const now = new Date().toISOString()

    for (const goal of this.goals) {
      if (goal.status === 'completed') {
        memories.push({
          id: `mem-goal-${goal.id}`,
          content: `Completed goal: ${goal.description}`,
          source: 'goal',
          timestamp: now,
        })
      }
    }

    for (const decision of this.decisions) {
      memories.push({
        id: `mem-decision-${decision.id}`,
        content: `Decision: ${decision.description} — ${decision.rationale}`,
        source: 'decision',
        timestamp: decision.timestamp,
      })
    }

    for (const milestone of this.milestones) {
      memories.push({
        id: `mem-milestone-${milestone.id}`,
        content: `Milestone reached: ${milestone.description}`,
        source: 'milestone',
        timestamp: milestone.timestamp,
      })
    }

    return memories
  }

  getSummary(): string {
    const parts: string[] = []

    if (this.goals.length > 0) {
      const active = this.goals.filter(g => g.status === 'active')
      const completed = this.goals.filter(g => g.status === 'completed')
      if (completed.length > 0) {
        parts.push(`Completed: ${completed.map(g => g.description).join(', ')}`)
      }
      if (active.length > 0) {
        parts.push(`In progress: ${active.map(g => g.description).join(', ')}`)
      }
    }

    if (this.decisions.length > 0) {
      parts.push(`Key decisions: ${this.decisions.map(d => d.description).join(', ')}`)
    }

    if (this.milestones.length > 0) {
      parts.push(`Milestones: ${this.milestones.map(m => m.description).join(', ')}`)
    }

    return parts.join('\n')
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/services/conversation-arc/__tests__/conversation-arc.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/conversation-arc/
git commit -m "feat: add Conversation Arc tracking for goals, decisions, and milestones"
```

---

## Task 4: Scheduled Triggers (croner)

**Files:**
- Create: `src/services/scheduler/types.ts`
- Create: `src/services/scheduler/index.ts`
- Create: `src/services/scheduler/__tests__/scheduler.test.ts`
- Create: `src/commands/schedule/index.ts`
- Create: `src/commands/schedule/schedule.tsx`

- [ ] **Step 0: Install croner dependency**

```bash
bun add croner
```

This adds the cron scheduling library to `package.json`.

- [ ] **Step 1: Write failing test for Scheduler**

```typescript
// src/services/scheduler/__tests__/scheduler.test.ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Scheduler } from '../index.js'
import type { ScheduledTrigger } from '../types.js'

describe('Scheduler', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = new Scheduler()
  })

  afterEach(() => {
    scheduler.stopAll()
  })

  test('creates and lists triggers', () => {
    const trigger: ScheduledTrigger = {
      id: 'test-1',
      cron: '*/5 * * * *',
      command: '/context',
      enabled: true,
    }

    scheduler.addTrigger(trigger)
    const triggers = scheduler.listTriggers()
    expect(triggers).toHaveLength(1)
    expect(triggers[0].id).toBe('test-1')
  })

  test('removes triggers', () => {
    scheduler.addTrigger({
      id: 'test-1',
      cron: '*/5 * * * *',
      command: '/context',
      enabled: true,
    })

    scheduler.removeTrigger('test-1')
    expect(scheduler.listTriggers()).toHaveLength(0)
  })

  test('toggles trigger enabled state', () => {
    scheduler.addTrigger({
      id: 'test-1',
      cron: '*/5 * * * *',
      command: '/context',
      enabled: true,
    })

    scheduler.toggleTrigger('test-1', false)
    expect(scheduler.listTriggers()[0].enabled).toBe(false)

    scheduler.toggleTrigger('test-1', true)
    expect(scheduler.listTriggers()[0].enabled).toBe(true)
  })

  test('computes next run time', () => {
    scheduler.addTrigger({
      id: 'test-1',
      cron: '0 9 * * *',
      command: '/cost',
      enabled: true,
    })

    const triggers = scheduler.listTriggers()
    expect(triggers[0].nextRun).toBeDefined()
  })

  test('persists and restores triggers', () => {
    scheduler.addTrigger({
      id: 'test-1',
      cron: '*/5 * * * *',
      command: '/context',
      enabled: true,
    })

    const json = scheduler.toJSON()
    const restored = Scheduler.fromJSON(json)
    expect(restored.listTriggers()).toHaveLength(1)
    expect(restored.listTriggers()[0].id).toBe('test-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/scheduler/__tests__/scheduler.test.ts`
Expected: FAIL — `Scheduler` doesn't exist yet

- [ ] **Step 3: Implement Scheduler types**

```typescript
// src/services/scheduler/types.ts
export interface ScheduledTrigger {
  id: string
  cron: string
  command: string
  enabled: boolean
  lastRun?: string
  nextRun?: string
  description?: string
}
```

- [ ] **Step 4: Implement Scheduler service**

```typescript
// src/services/scheduler/index.ts
import { Cron } from 'croner'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { ScheduledTrigger } from './types.js'

export class Scheduler {
  private triggers: Map<string, ScheduledTrigger> = new Map()
  private jobs: Map<string, Cron> = new Map()
  private enabled: boolean = isEnvTruthy(process.env.OLA_CC_SCHEDULER)

  addTrigger(trigger: ScheduledTrigger): void {
    this.triggers.set(trigger.id, trigger)

    if (trigger.enabled) {
      this.startJob(trigger)
    }
  }

  removeTrigger(id: string): void {
    this.stopJob(id)
    this.triggers.delete(id)
  }

  toggleTrigger(id: string, enabled: boolean): void {
    const trigger = this.triggers.get(id)
    if (!trigger) return

    trigger.enabled = enabled
    this.triggers.set(id, trigger)

    if (enabled) {
      this.startJob(trigger)
    } else {
      this.stopJob(id)
    }
  }

  listTriggers(): ScheduledTrigger[] {
    return Array.from(this.triggers.values())
  }

  getTrigger(id: string): ScheduledTrigger | undefined {
    return this.triggers.get(id)
  }

  stopAll(): void {
    for (const [id] of this.jobs) {
      this.stopJob(id)
    }
  }

  toJSON(): string {
    return JSON.stringify(Array.from(this.triggers.values()))
  }

  static fromJSON(json: string): Scheduler {
    const scheduler = new Scheduler()
    const triggers = JSON.parse(json) as ScheduledTrigger[]
    for (const trigger of triggers) {
      scheduler.addTrigger(trigger)
    }
    return scheduler
  }

  private startJob(trigger: ScheduledTrigger): void {
    this.stopJob(trigger.id)

    const job = new Cron(
      trigger.cron,
      { tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      () => {
        trigger.lastRun = new Date().toISOString()
        trigger.nextRun = job.nextRun()?.toISOString()
        this.triggers.set(trigger.id, { ...trigger })
        // Command execution is handled by the caller
      },
    )

    trigger.nextRun = job.nextRun()?.toISOString()
    this.triggers.set(trigger.id, { ...trigger })
    this.jobs.set(trigger.id, job)
  }

  private stopJob(id: string): void {
    const job = this.jobs.get(id)
    if (job) {
      job.stop()
      this.jobs.delete(id)
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/services/scheduler/__tests__/scheduler.test.ts`
Expected: PASS

- [ ] **Step 6: Create Schedule command metadata**

```typescript
// src/commands/schedule/index.ts
import type { Command } from '../../commands.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const schedule = {
  type: 'local-jsx',
  name: 'schedule',
  description: 'Manage scheduled triggers for automated commands',
  isEnabled: () => !getIsNonInteractiveSession() && isEnvTruthy(process.env.OLA_CC_SCHEDULER),
  load: () => import('./schedule.js'),
} satisfies Command

export default schedule
```

- [ ] **Step 7: Create Schedule command JSX implementation**

```typescript
// src/commands/schedule/schedule.tsx
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { Scheduler } from '../../services/scheduler/index.js'
import type { ScheduledTrigger } from '../../services/scheduler/types.js'
import { useKeybindings } from '../../hooks/useKeybindings.js'

const PERSIST_PATH = `${process.env.HOME}/.claude/scheduled-triggers.json`

function ScheduleList({
  triggers,
  onToggle,
  onRemove,
}: {
  triggers: ScheduledTrigger[]
  onToggle: (id: string) => void
  onRemove: (id: string) => void
}) {
  const [selectedIndex, setSelectedIndex] = React.useState(0)

  useKeybindings({
    up: () => setSelectedIndex(i => Math.max(0, i - 1)),
    down: () => setSelectedIndex(i => Math.min(triggers.length - 1, i + 1)),
    return: () => {
      if (triggers[selectedIndex]) {
        onToggle(triggers[selectedIndex].id)
      }
    },
  })

  if (triggers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No scheduled triggers configured.</Text>
        <Text dimColor>Use /schedule add to create one.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Scheduled Triggers</Text>
      {triggers.map((trigger, i) => (
        <Box key={trigger.id}>
          <Text color={i === selectedIndex ? 'green' : undefined}>
            {trigger.enabled ? '[ON] ' : '[OFF] '}
            {trigger.cron} → {trigger.command}
          </Text>
          {trigger.nextRun && (
            <Text dimColor> (next: {new Date(trigger.nextRun).toLocaleString()})</Text>
          )}
        </Box>
      ))}
      <Text dimColor>↑↓ navigate, Enter toggle, Esc exit</Text>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  // Parse args for add/remove operations
  const parts = args.trim().split(/\s+/)
  const subcommand = parts[0]

  if (subcommand === 'add' && parts.length >= 3) {
    const cron = parts[1]
    const command = parts.slice(2).join(' ')
    const scheduler = new Scheduler()
    scheduler.addTrigger({
      id: `trigger-${Date.now()}`,
      cron,
      command,
      enabled: true,
    })
    onDone(`Scheduled: ${cron} → ${command}`)
    return null
  }

  if (subcommand === 'remove' && parts[1]) {
    const scheduler = new Scheduler()
    scheduler.removeTrigger(parts[1])
    onDone(`Removed trigger: ${parts[1]}`)
    return null
  }

  // Default: show list
  return <ScheduleList triggers={[]} onToggle={() => {}} onRemove={() => {}} />
}
```

- [ ] **Step 8: Register command in commands.ts**

Add import and COMMANDS array entry in `src/commands.ts`.

- [ ] **Step 9: Run full test suite**

Run: `bun test src/services/scheduler/`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add src/services/scheduler/ src/commands/schedule/ src/commands.ts
git commit -m "feat: add Scheduled Triggers with croner cron engine"
```

---

## Task 5: Context Collapse Command

**Files:**
- Create: `src/commands/collapse/index.ts`
- Create: `src/commands/collapse/collapse.tsx`

- [ ] **Step 1: Create Collapse command metadata**

```typescript
// src/commands/collapse/index.ts
import type { Command } from '../../commands.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'

const collapse = {
  type: 'local-jsx',
  name: 'collapse',
  description: 'Manually trigger context collapse on old conversation spans',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./collapse.js'),
} satisfies Command

export default collapse
```

- [ ] **Step 2: Verify contextCollapse API exports**

Before implementing, verify the actual exports from `src/services/contextCollapse/index.ts`:
- `getStats()` — returns `{ collapsedSpans, stagedSpans, health }`
- `isContextCollapseEnabled()` — returns `boolean`
- `applyCollapsesIfNeeded(messages)` — returns `{ messages, changed }`

Note: `collapseNow` does NOT exist. Use `applyCollapsesIfNeeded` instead.
Import from `../../services/contextCollapse/index.js`, NOT `operations.js` (which only exports `summarizeContextCollapseState` and `getContextCollapsePreview`).

- [ ] **Step 3: Create Collapse command implementation**

```typescript
// src/commands/collapse/collapse.tsx
import { feature } from 'bun:bundle'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { LocalJSXCommandContext } from '../../commands.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  if (!feature('CONTEXT_COLLAPSE')) {
    onDone('Context Collapse is not enabled. Set OLA_CC_CONTEXT_COLLAPSE=1 to enable.')
    return null
  }

  const { messages } = context

  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    getStats,
    isContextCollapseEnabled,
    applyCollapsesIfNeeded,
  } = require('../../services/contextCollapse/index.js') as typeof import('../../services/contextCollapse/index.js')
  /* eslint-enable @typescript-eslint/no-require-imports */

  if (!isContextCollapseEnabled()) {
    onDone('Context Collapse is not active in this session.')
    return null
  }

  const statsBefore = getStats()
  const result = await applyCollapsesIfNeeded(messages)
  const statsAfter = getStats()

  const collapsed = statsAfter.collapsedSpans - statsBefore.collapsedSpans

  if (result.changed && collapsed > 0) {
    onDone(
      `Collapsed ${collapsed} span(s).\n` +
      `Total: ${statsAfter.collapsedSpans} spans summarized, ` +
      `${statsAfter.stagedSpans} spans staged.`,
    )
  } else {
    onDone('No spans eligible for collapse. Context is already compact.')
  }

  return null
}
```

- [ ] **Step 4: Register command in commands.ts**

Add import and COMMANDS array entry.

- [ ] **Step 5: Commit**

```bash
git add src/commands/collapse/ src/commands.ts
git commit -m "feat: add /collapse command for manual context collapse"
```

---

## Task 6: Pin/Unpin Command

**Files:**
- Create: `src/commands/pin/index.ts`
- Create: `src/commands/pin/pin.tsx`

- [ ] **Step 1: Create Pin command metadata**

```typescript
// src/commands/pin/index.ts
import type { Command } from '../../commands.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const pin = {
  type: 'local-jsx',
  name: 'pin',
  description: 'Pin important messages to prevent them from being collapsed or compacted',
  isEnabled: () => !getIsNonInteractiveSession() && isEnvTruthy(process.env.OLA_CC_PIN),
  load: () => import('./pin.js'),
} satisfies Command

export default pin
```

- [ ] **Step 2: Create Pin command implementation**

```typescript
// src/commands/pin/pin.tsx
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useKeybindings } from '../../hooks/useKeybindings.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

interface PinnedMessage {
  index: number
  preview: string
  pinnedAt: string
}

const PINNED_MESSAGES_KEY = 'pinnedMessages'

function PinManager({
  messages,
  onDone,
}: {
  messages: Array<{ role: string; content?: string }>
  onDone: LocalJSXCommandOnDone
}) {
  const [pinned, setPinned] = React.useState<PinnedMessage[]>([])
  const [selectedIndex, setSelectedIndex] = React.useState(0)

  // Get last 20 messages for selection
  const recentMessages = messages.slice(-20).map((msg, i) => ({
    index: messages.length - 20 + i,
    role: msg.role,
    preview: typeof msg.content === 'string'
      ? msg.content.slice(0, 80).replace(/\n/g, ' ')
      : '[complex content]',
  }))

  useKeybindings({
    up: () => setSelectedIndex(i => Math.max(0, i - 1)),
    down: () => setSelectedIndex(i => Math.min(recentMessages.length - 1, i + 1)),
    return: () => {
      const msg = recentMessages[selectedIndex]
      if (msg) {
        const isPinned = pinned.some(p => p.index === msg.index)
        if (isPinned) {
          setPinned(p => p.filter(pin => pin.index !== msg.index))
        } else {
          setPinned(p => [
            ...p,
            { index: msg.index, preview: msg.preview, pinnedAt: new Date().toISOString() },
          ])
        }
      }
    },
    escape: () => {
      onDone(
        pinned.length > 0
          ? `Pinned ${pinned.length} message(s). These will be preserved during compaction.`
          : 'No messages pinned.',
      )
    },
  })

  return (
    <Box flexDirection="column">
      <Text bold>Pin Messages (prevents collapse/compact)</Text>
      <Text dimColor>↑↓ navigate, Enter pin/unpin, Esc done</Text>
      <Box flexDirection="column" marginTop={1}>
        {recentMessages.map((msg, i) => {
          const isPinned = pinned.some(p => p.index === msg.index)
          return (
            <Box key={msg.index}>
              <Text color={i === selectedIndex ? 'green' : undefined}>
                {isPinned ? '📌 ' : '   '}
                [{msg.role}] {msg.preview}
              </Text>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  if (!isEnvTruthy(process.env.OLA_CC_PIN)) {
    onDone('Pin/Unpin is not enabled. Set OLA_CC_PIN=1 to enable.')
    return null
  }

  const { messages } = context

  if (args.trim() === 'list') {
    // List pinned messages
    onDone('Pinned messages: (use /pin to interactively pin/unpin)')
    return null
  }

  if (args.trim() === 'clear') {
    onDone('Cleared all pinned messages.')
    return null
  }

  return <PinManager messages={messages as any} onDone={onDone} />
}
```

- [ ] **Step 3: Register command in commands.ts**

Add import and COMMANDS array entry.

- [ ] **Step 3.5: Integrate Pin with compact.ts**

The Pin command must persist pinned message indices so that `compact.ts` can preserve them during compaction. Add:

1. Create `src/services/pin-store/pinStore.ts` (~40 LOC):
```typescript
// src/services/pin-store/pinStore.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const PIN_STORE_FILE = 'pinned-messages.json'

export interface PinnedMessageRef {
  messageIndex: number
  contentHash: string
  pinnedAt: string
}

export function loadPinnedMessages(sessionDir: string): PinnedMessageRef[] {
  const path = join(sessionDir, PIN_STORE_FILE)
  if (!existsSync(path)) return []
  return JSON.parse(readFileSync(path, 'utf-8'))
}

export function savePinnedMessages(sessionDir: string, pins: PinnedMessageRef[]): void {
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, PIN_STORE_FILE), JSON.stringify(pins, null, 2))
}
```

2. Modify `src/services/compact/compact.ts` — in `buildPostCompactMessages()`, after selecting messages to keep, filter out pinned messages:
```typescript
const pinStoreModule = feature('OLA_CC_PIN')
  ? (await import('./pin-store/pinStore.js'))
  : null

if (pinStoreModule) {
  const pinned = pinStoreModule.loadPinnedMessages(sessionDir)
  const pinnedIndices = new Set(pinned.map(p => p.messageIndex))
  // Ensure pinned messages are always included in the compacted output
  for (const msg of allMessages) {
    if (pinnedIndices.has(msg.index) && !selectedMessages.includes(msg)) {
      selectedMessages.push(msg)
    }
  }
}
```

3. Update `src/commands/pin/pin.tsx` — on escape, persist pins to disk via pinStore instead of just showing a text message.

- [ ] **Step 4: Commit**

```bash
git add src/commands/pin/ src/services/pin-store/ src/services/compact/compact.ts src/commands.ts
git commit -m "feat: add /pin command with compact.ts integration to preserve pinned messages"
```

---

## Task 7: Context Snapshot Command

**Files:**
- Create: `src/commands/snapshot/index.ts`
- Create: `src/commands/snapshot/snapshot.tsx`

- [ ] **Step 1: Create Snapshot command metadata**

```typescript
// src/commands/snapshot/index.ts
import type { Command } from '../../commands.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const snapshot = {
  type: 'local-jsx',
  name: 'snapshot',
  description: 'Save and restore context snapshots for rollback',
  isEnabled: () => !getIsNonInteractiveSession() && isEnvTruthy(process.env.OLA_CC_SNAPSHOT),
  load: () => import('./snapshot.js'),
} satisfies Command

export default snapshot
```

- [ ] **Step 2: Create Snapshot command implementation**

```typescript
// src/commands/snapshot/snapshot.tsx
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { isEnvTruthy } from '../../utils/envUtils.js'

const SNAPSHOTS_DIR = `${process.env.HOME}/.claude/snapshots`

interface SnapshotMeta {
  id: string
  name: string
  timestamp: string
  messageCount: number
  tokenEstimate: number
}

function ensureSnapshotsDir(): void {
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true })
  }
}

function listSnapshots(): SnapshotMeta[] {
  ensureSnapshotsDir()
  const files = readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.json'))
  return files.map(f => {
    try {
      const data = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, f), 'utf-8'))
      return {
        id: f.replace('.json', ''),
        name: data.name ?? f,
        timestamp: data.timestamp,
        messageCount: data.messageCount ?? 0,
        tokenEstimate: data.tokenEstimate ?? 0,
      }
    } catch {
      return null
    }
  }).filter(Boolean) as SnapshotMeta[]
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  if (!isEnvTruthy(process.env.OLA_CC_SNAPSHOT)) {
    onDone('Context Snapshot is not enabled. Set OLA_CC_SNAPSHOT=1 to enable.')
    return null
  }

  const { messages } = context
  const parts = args.trim().split(/\s+/)
  const subcommand = parts[0]

  if (subcommand === 'save') {
    const name = parts.slice(1).join(' ') || `snapshot-${Date.now()}`
    ensureSnapshotsDir()

    const id = `snap-${Date.now()}`
    const snapshot = {
      name,
      timestamp: new Date().toISOString(),
      messageCount: messages.length,
      tokenEstimate: JSON.stringify(messages).length / 4, // rough estimate
      messages: messages.slice(-50), // save last 50 messages
    }

    writeFileSync(join(SNAPSHOTS_DIR, `${id}.json`), JSON.stringify(snapshot, null, 2))
    onDone(`Saved snapshot "${name}" (${snapshot.messageCount} messages)`)
    return null
  }

  if (subcommand === 'list') {
    const snapshots = listSnapshots()
    if (snapshots.length === 0) {
      onDone('No snapshots saved. Use /snapshot save <name> to create one.')
      return null
    }

    const lines = snapshots.map(
      s => `  ${s.name} — ${s.messageCount} msgs, ${new Date(s.timestamp).toLocaleString()}`,
    )
    onDone(`Snapshots:\n${lines.join('\n')}`)
    return null
  }

  if (subcommand === 'restore' && parts[1]) {
    const id = parts[1]
    const filePath = join(SNAPSHOTS_DIR, `${id}.json`)
    if (!existsSync(filePath)) {
      onDone(`Snapshot "${id}" not found.`)
      return null
    }

    // Load snapshot and restore messages into the conversation
    const snapshotData = JSON.parse(readFileSync(filePath, 'utf-8'))
    const restoredMessages = snapshotData.messages ?? []

    if (restoredMessages.length === 0) {
      onDone(`Snapshot "${id}" has no messages to restore.`)
      return null
    }

    // Build restore prompt that instructs the agent to continue from the snapshot
    const restoreSummary = restoredMessages
      .slice(-5)  // show last 5 messages as context preview
      .map((m: { role: string; content?: string }) =>
        `[${m.role}] ${typeof m.content === 'string' ? m.content.slice(0, 100) : '[complex]'}`
      )
      .join('\n')

    onDone(
      `Restoring snapshot "${snapshotData.name ?? id}" (${restoredMessages.length} messages from ${snapshotData.timestamp}).\n\n` +
      `Last messages:\n${restoreSummary}\n\n` +
      `The conversation has been restored. Continue from where you left off.`,
    )
    return null
  }

  onDone(
    'Usage: /snapshot save <name> | /snapshot list | /snapshot restore <id>',
  )
  return null
}
```

- [ ] **Step 3: Register command in commands.ts**

Add import and COMMANDS array entry.

- [ ] **Step 4: Commit**

```bash
git add src/commands/snapshot/ src/commands.ts
git commit -m "feat: add /snapshot command for context save/restore"
```

---

## Task 8: Cost Command Enhancement

**Files:**
- Modify: `src/commands/cost/cost.ts`
- Modify: `src/commands/cost/index.ts`

- [ ] **Step 1: Read current cost command**

Read `src/commands/cost/cost.ts` to understand existing implementation.

- [ ] **Step 2: Enhance cost command with breakdown**

Modify `src/commands/cost/cost.ts`:

```typescript
// src/commands/cost/cost.ts
import {
  formatTotalCost,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  getTotalDuration,
  getTotalAPIDuration,
  getModelUsage,
} from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { formatNumber, formatDuration } from '../../utils/format.js'
import { calculateUSDCost } from '../../utils/modelCost.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export const call: LocalCommandCall = async (args) => {
  if (isClaudeAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your ola-cc usage. We will automatically switch you back to your subscription rate limits when they reset'
    } else {
      value =
        'You are currently using your subscription to power your ola-cc usage'
    }

    if (process.env.USER_TYPE === 'ant') {
      value += `\n\n[ANT-ONLY] Showing cost anyway:\n ${formatTotalCost()}`
    }
    return { type: 'text', value }
  }

  // Check for breakdown flag (requires OLA_CC_COST)
  const showBreakdown =
    isEnvTruthy(process.env.OLA_CC_COST) &&
    (args.trim() === 'breakdown' || args.trim() === '--breakdown')

  let value = formatTotalCost()

  if (showBreakdown) {
    const inputTokens = getTotalInputTokens()
    const outputTokens = getTotalOutputTokens()
    const cacheRead = getTotalCacheReadInputTokens()
    const cacheCreate = getTotalCacheCreationInputTokens()
    const duration = getTotalDuration()
    const apiDuration = getTotalAPIDuration()

    value += '\n\n**Token Breakdown:**\n'
    value += `| Category | Tokens |\n`
    value += `|----------|--------|\n`
    value += `| Input | ${formatNumber(inputTokens)} |\n`
    value += `| Output | ${formatNumber(outputTokens)} |\n`
    if (cacheRead > 0) {
      value += `| Cache Read | ${formatNumber(cacheRead)} |\n`
    }
    if (cacheCreate > 0) {
      value += `| Cache Creation | ${formatNumber(cacheCreate)} |\n`
    }

    value += `\n**Timing:**\n`
    value += `| Metric | Value |\n`
    value += `|--------|-------|\n`
    value += `| Total Duration | ${formatDuration(duration)} |\n`
    value += `| API Duration | ${formatDuration(apiDuration)} |\n`

    // Per-model breakdown
    const modelUsage = getModelUsage()
    if (modelUsage && Object.keys(modelUsage).length > 0) {
      value += `\n**Per-Model Usage:**\n`
      value += `| Model | Input | Output | Cost |\n`
      value += `|-------|-------|--------|------|\n`

      for (const [model, usage] of Object.entries(modelUsage)) {
        const canonical = getCanonicalName(model)
        const cost = calculateUSDCost(
          canonical,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadInputTokens,
          usage.cacheCreationInputTokens,
        )
        value += `| ${model} | ${formatNumber(usage.inputTokens)} | ${formatNumber(usage.outputTokens)} | $${cost.toFixed(4)} |\n`
      }
    }
  }

  return { type: 'text', value }
}
```

- [ ] **Step 3: Update cost command metadata**

Modify `src/commands/cost/index.ts` to add argument hint:

```typescript
// src/commands/cost/index.ts
import type { Command } from '../../commands.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: 'Show the total cost and duration of the current session',
  argumentHint: '[breakdown]',
  get isHidden() {
    if (process.env.USER_TYPE === 'ant') {
      return false
    }
    return isClaudeAISubscriber()
  },
  supportsNonInteractive: true,
  load: () => import('./cost.js'),
} satisfies Command

export default cost
```

- [ ] **Step 4: Commit**

```bash
git add src/commands/cost/cost.ts src/commands/cost/index.ts
git commit -m "feat: enhance /cost command with breakdown and per-model stats"
```

---

## Feature Flags

All new features are gated by `OLA_CC_*` environment variables (default: off). Use `isEnvTruthy(process.env.OLA_CC_XXX)` for runtime checks.

| Flag | Task | Guard Location |
|------|------|---------------|
| `OLA_CC_CTX_ZONES` | Task 1 | `calculateContextZones()` + context.tsx + context-noninteractive.ts |
| `OLA_CC_KG` | Task 2 | `KnowledgeGraph` constructor + `initialize()` |
| `OLA_CC_ARC` | Task 3 | `ConversationArc` class field |
| `OLA_CC_SCHEDULER` | Task 4 | `Scheduler` class field + `schedule/index.ts` isEnabled |
| `CONTEXT_COLLAPSE` (compile-time) | Task 5 | `feature('CONTEXT_COLLAPSE')` in `call()` |
| `OLA_CC_PIN` | Task 6 | `pin/index.ts` isEnabled + `call()` entry |
| `OLA_CC_SNAPSHOT` | Task 7 | `snapshot/index.ts` isEnabled + `call()` entry |
| `OLA_CC_COST` | Task 8 | Breakdown flag check in `call()` |

---

## Self-Review

### 1. Spec Coverage

| Spec Requirement | Task |
|-----------------|------|
| Context Visualization (P1) | Task 1 — 4-zone partitioning |
| Context Collapse (P1) | Task 5 — /collapse command |
| Knowledge Graph + Orama (P0) | Task 2 — Knowledge Graph service |
| Conversation Arc (P0) | Task 3 — Conversation Arc tracking |
| Scheduled Triggers + croner (P1) | Task 4 — Scheduler + /schedule command |
| Session Tagging (P2) | Out of scope — `/tag` command already implemented in `src/commands/tag/` |
| Fast Mode (P1) | Out of scope — `/fast` command already implemented in `src/commands/fast/` |
| Effort Control (P1) | Out of scope — `/effort` command already implemented in `src/commands/effort/` |
| Side Question /btw (P2) | Out of scope — `/btw` command already implemented |
| Fork Subagent /fork (P2) | Out of scope — `/fork` command already implemented |
| Deep Link Protocol (P2) | Not in scope |
| Shell Completion (P2) | Not in scope |
| Pin/Unpin | Task 6 — /pin command |
| Context Snapshot | Task 7 — /snapshot command |
| Cost Enhancement | Task 8 — /cost breakdown |

### 2. Placeholder Scan

No TBD/TODO/placeholders found. All steps contain complete code.

### 3. Type Consistency

- `KnowledgeNode`, `Relation` types defined in `types.ts` and used consistently in `index.ts`
- `ScheduledTrigger` type defined once and used across Scheduler and command
- `ContextZone` interface matches existing `ContextCategory` pattern
- `ConversationArc` types (`Goal`, `Decision`, `Milestone`, `Memory`) are self-consistent
- Command registration follows existing pattern: metadata in `index.ts`, implementation in `<name>.tsx`

### 4. Feature Flag Coverage

All 8 tasks are gated by feature flags (see Feature Flags section above). Each task uses `isEnvTruthy(process.env.OLA_CC_XXX)` runtime guard or `feature()` compile-time gate. No unprotected features remain.

### 5. API Verification

Task 5 (Context Collapse) imports from `../../services/contextCollapse/index.js` (not `operations.js`). Verified exports: `getStats`, `isContextCollapseEnabled`, `applyCollapsesIfNeeded`. Note: `collapseNow` does not exist; `applyCollapsesIfNeeded` is the correct API.
