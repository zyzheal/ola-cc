# oh-my-claudecode Features Integration Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: oh-my-claudecode v4.14.4
**Priority**: P1/P2

---

## 1. Overview

oh-my-claudecode (OMC) 是基于 Claude Agent SDK 的独立编排系统，不是 claude-code fork。以下功能可独立集成到 ola-cc。

### 向后兼容原则

所有功能均通过 feature flag 控制，不修改现有接口：

| Feature | Flag | Default |
|---------|------|---------|
| Ralph PRD System | `OLA_CC_RALPH_PRD` | off |
| Learner Auto-Skill | `OLA_CC_LEARNER_AUTO_SKILL` | off |
| Notepad 3-Zone | `OLA_CC_NOTEPAD_3_ZONE` | off |
| Model Routing | — | 见独立设计文档 |
| AST Tools | `OLA_CC_AST_TOOLS` | off |

### Effort 分列

| Feature | Effort | LOC 估算 |
|---------|--------|---------|
| Ralph PRD System | M | ~700 |
| Learner Auto-Skill | M | ~650 |
| Notepad 3-Zone | M | ~400 |
| Model Routing | — | 见独立设计文档 |
| AST Tools | S | ~250 |

---

## 2. Ralph PRD System (P1)

### 2.1 Overview

Ralph 是基于 PRD (Product Requirements Document) 的任务管理 + 验证系统，包含 3 个组件。

### 2.2 PRD Structure

```typescript
// src/tools/RalphTool/types.ts

interface PRD {
  project: string
  branchName: string
  description: string
  userStories: UserStory[]
}

interface UserStory {
  id: string                    // e.g. "US-001"
  description: string
  acceptanceCriteria: string[]
  passes: boolean
  architectVerified: boolean
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  learnings: string[]
  filesModified: FileChange[]
}

interface FileChange {
  path: string
  description: string           // e.g. "added bar()"
}

interface PRDParseResult {
  prd: PRD
  errors: string[]              // parse errors
  warnings: string[]            // non-fatal issues
}
```

### 2.3 PRD Parsing

PRD 文件为 markdown 格式，解析流程：

```typescript
// src/tools/RalphTool/prd.ts (~150 LOC)

/**
 * Parse PRD markdown file into structured PRD object.
 * Supports both flat and nested user story formats.
 */
async function parsePRD(filePath: string): Promise<PRDParseResult>

/**
 * Extract user stories from markdown sections.
 * Recognizes: ## User Story: <desc>, - [ ] criteria, - [x] criteria
 */
function extractUserStories(content: string): UserStory[]

/**
 * Validate PRD structure completeness.
 * Checks: project name, branch, at least 1 user story, each story has >= 1 criteria.
 */
function validatePRD(prd: PRD): string[]
```

### 2.4 Progress Memory

**File**: `progress.txt` with two sections. 原子写入机制保证数据完整性：

```typescript
// src/tools/RalphTool/progress.ts (~200 LOC)

/**
 * Atomic write: write to tmp file, then rename.
 * Prevents partial writes on crash.
 */
async function atomicWriteProgress(filePath: string, content: string): Promise<void>
// 实现: writeFileSync(tmpPath, content) → renameSync(tmpPath, filePath)

/**
 * Read and parse progress file into structured sections.
 */
async function readProgress(filePath: string): Promise<ProgressState>

/**
 * Update a specific user story's progress section.
 * Preserves Codebase Patterns section, updates only target story.
 */
async function updateStoryProgress(
  filePath: string,
  storyId: string,
  update: Partial<UserStoryProgress>
): Promise<void>

interface ProgressState {
  codebasePatterns: string[]
  stories: Map<string, UserStoryProgress>
}

interface UserStoryProgress {
  description: string
  status: string
  learnings: string[]
  filesModified: FileChange[]
}
```

Progress 文件格式：

```markdown
## Codebase Patterns
- Pattern 1: ...
- Pattern 2: ...

## User Story: <description>
- Status: in_progress
- Learnings:
  - Learning 1: ...
  - Learning 2: ...
- Files modified:
  - src/foo.ts: added bar()
```

### 2.5 Verifier

3 critic modes，通过 `<ralph-approved>` XML 标签判定通过：

```typescript
// src/tools/RalphTool/verifier.ts (~250 LOC)

type CriticMode = 'architect' | 'critic' | 'codex'

interface VerificationResult {
  mode: CriticMode
  approved: boolean
  feedback: string
  issues: VerificationIssue[]
}

interface VerificationIssue {
  severity: 'critical' | 'warning' | 'info'
  description: string
  suggestion?: string
}

/**
 * XML tag matching regex for approval detection.
 * Matches: <ralph-approved> or <ralph-approved reason="..."> or <ralph-approved/>
 */
const RALPH_APPROVED_REGEX = /<ralph-approved(?:\s+reason="[^"]*")?\s*\/?>/

/**
 * Run verification with specified critic mode.
 * Each mode has a different system prompt focus:
 * - architect: structural integrity, dependency analysis
 * - critic: code quality, naming, patterns
 * - codex: implementation correctness, edge cases
 */
async function verify(
  prd: PRD,
  progress: ProgressState,
  mode: CriticMode,
  sourceFiles: string[]
): Promise<VerificationResult>

/**
 * Run all 3 critic modes and aggregate results.
 * All must approve for overall approval.
 */
async function verifyAll(
  prd: PRD,
  progress: ProgressState,
  sourceFiles: string[]
): Promise<{ approved: boolean; results: VerificationResult[] }>
```

### 2.6 Main Entry Point

```typescript
// src/tools/RalphTool/index.ts (~100 LOC)

/**
 * Ralph tool entry point. Implements Tool interface.
 * Subcommands:
 *   - parse <prd-file>        → parse and validate PRD
 *   - status                  → show progress state
 *   - update <story-id>       → update story progress
 *   - verify [--mode=architect|critic|codex] → run verification
 */
const RalphTool: Tool = {
  name: 'ralph',
  description: 'PRD-based task management and verification system',
  inputSchema: { /* Zod schema for subcommands */ },
  async call(input, context) { /* dispatch to subcommands */ }
}
```

### 2.7 Files to Create

| File | Purpose | Est. LOC |
|------|---------|---------|
| `src/tools/RalphTool/index.ts` | Main entry, Tool interface | ~100 |
| `src/tools/RalphTool/types.ts` | TypeScript interfaces | ~80 |
| `src/tools/RalphTool/prd.ts` | PRD parsing + validation | ~150 |
| `src/tools/RalphTool/progress.ts` | Progress memory (atomic write) | ~200 |
| `src/tools/RalphTool/verifier.ts` | 3-mode verification + XML matching | ~250 |

---

## 3. Learner Auto-Skill Extraction (P2)

### 3.1 Overview

自动从对话中提取 problem-solution 模式，生成可复用的 skill。

### 3.2 Detection (5 Pattern Types)

5 种 pattern 的具体 regex 模式（多语言：EN/ZH）：

```typescript
// src/hooks/learner/detector.ts (~300 LOC)

interface DetectedPattern {
  type: PatternType
  match: string               // matched text
  problem: string             // extracted problem description
  solution: string            // extracted solution
  language: 'en' | 'zh' | 'ko' | 'ja' | 'es'
  confidence: number          // 0-1
  context: string             // surrounding message context
}

type PatternType = 'problem-solution' | 'fix-pattern' | 'workaround' | 'discovery' | 'configuration'

/**
 * Pattern regex definitions per type, per language.
 * Each pattern has: regex, problemGroup, solutionGroup
 */
const PATTERNS: Record<PatternType, LangPattern[]> = {
  'problem-solution': [
    { lang: 'en', regex: /(?:the (?:issue|problem|bug) was|root cause[:\s]+)(.+?)(?:,?\s*(?:fixed|solved|resolved) by (?:doing|using|applying)[:\s]+)(.+)/is },
    { lang: 'zh', regex: /(?:问题[是在于原因]|bug[是在于原因])(.+?)[,，]\s*(?:通过|用|采用)(.+?)(?:解决|修复|搞定)/is },
  ],
  'fix-pattern': [
    { lang: 'en', regex: /(?:to fix|fix for|fixing)\s+(.+?)(?:,?\s*(?:apply|use|do)[:\s]+)(.+)/is },
    { lang: 'zh', regex: /(?:修复|解决|处理)\s*(.+?)[，,]\s*(?:需要|应该|可以)(.+)/is },
  ],
  'workaround': [
    { lang: 'en', regex: /(?:workaround|alternative)[:\s]+(?:instead of|don't)\s+(.+?)[,.]?\s*(?:do|use|try|go with)[:\s]+(.+)/is },
    { lang: 'zh', regex: /(?:替代方案|变通方法)[：:]\s*(?:不要|别)(.+?)[，,]\s*(?:改用|改|用)(.+)/is },
  ],
  'discovery': [
    { lang: 'en', regex: /(?:found that|discovered|turns out)\s+(.+?)(?:because|since|due to)[:\s]+(.+)/is },
    { lang: 'zh', regex: /(?:发现|原来)(.+?)(?:是因为|原因[是在于])(.+)/is },
  ],
  'configuration': [
    { lang: 'en', regex: /(?:set(?:ting)?|config(?:ure)?)\s+(\S+)\s+(?:to|as|=)\s+(\S+)\s+(?:to|for|resolves?|fixes?)[:\s]+(.+)/is },
    { lang: 'zh', regex: /(?:设置|配置)\s*(\S+)\s*(?:为|=|设为)\s*(\S+)\s*(?:可以|来|以)(.+)/is },
  ],
}
```

### 3.3 Skill-Worthiness Scoring (0-100)

完整评分公式：

```typescript
// src/hooks/learner/auto-learner.ts (~200 LOC)

interface ScoringFactors {
  problemSpecificity: number    // 0-20: 问题描述是否具体（含错误信息、文件路径等）
  solutionClarity: number       // 0-25: 解决方案是否清晰可执行
  reusability: number           // 0-20: 是否适用于不同项目/场景
  patternFrequency: number      // 0-15: 同类问题在 session 中出现次数
  contextRichness: number       // 0-20: 上下文信息是否充分（代码片段、文件引用等）
}

/**
 * Score = sum of all factors. Threshold >= 60 for auto-generation.
 *
 * Scoring heuristics:
 * - problemSpecificity: +5 per specific identifier (file path, error code, function name)
 * - solutionClarity: +5 per actionable step, +10 if has code example
 * - reusability: +10 if no project-specific paths, +10 if uses generic patterns
 * - patternFrequency: +5 per occurrence beyond first
 * - contextRichness: +5 per code snippet, +5 per file reference, +5 per tool output reference
 */
function scorePattern(pattern: DetectedPattern, sessionPatterns: DetectedPattern[]): ScoringFactors

function totalScore(factors: ScoringFactors): number {
  return factors.problemSpecificity
    + factors.solutionClarity
    + factors.reusability
    + factors.patternFrequency
    + factors.contextRichness
}
```

### 3.4 Session Cache 去重

```typescript
/**
 * Session-level dedup cache. Prevents generating duplicate skills
 * for the same problem-solution pair within one session.
 *
 * Key: hash(problem + solution normalized to lowercase, stripped of whitespace)
 * TTL: session lifetime (cleared on session end)
 */
const sessionCache = new Map<string, { pattern: DetectedPattern; score: number }>()

function isDuplicate(pattern: DetectedPattern): boolean {
  const key = normalizeForDedupe(pattern.problem + '|||' + pattern.solution)
  return sessionCache.has(key)
}
```

### 3.5 Auto-Generation Skill Template

当 score >= 60 时，自动生成以下格式的 skill 文件：

```markdown
<!-- Auto-generated by Learner at {{timestamp}} -->
<!-- Source: {{session_id}} at turn {{turn_number}} -->
<!-- Confidence: {{confidence}} -->
# {{title}}

## Trigger
{{trigger_words_comma_separated}}

## Problem
{{problem_description}}

## Solution
{{solution_steps}}

## Context
{{code_context_if_available}}

## Tags
{{inferred_tags}}
```

```typescript
/**
 * Generate skill file from detected pattern.
 * - Title: first 6 words of problem, title-cased
 * - Trigger words: extracted nouns/verbs from problem, deduplicated
 * - Tags: inferred from code context (language, framework, error type)
 */
async function generateSkill(pattern: DetectedPattern, outputPath: string): Promise<void>
```

### 3.6 Path Safety

生成的 skill 文件路径必须通过 `checkPathSafetyForAutoEdit` 校验，确保仅写入允许的目录（`~/.ola-cc/skills/`）。该函数在 `src/utils/permissions/filesystem.ts` 中定义，用于防止路径遍历攻击和越权写入。

### 3.7 Files to Create

| File | Purpose | Est. LOC |
|------|---------|---------|
| `src/hooks/learner/detector.ts` | Pattern detection (5 types, multi-lang regex) | ~300 |
| `src/hooks/learner/auto-learner.ts` | Skill-worthiness scoring + generation + session cache | ~200 |
| `src/hooks/learner/validator.ts` | Quality gates (dedup, min length, format check) | ~150 |

---

## 4. Notepad 3-Zone Memory (P2)

> **注意**: Notepad 的核心深度合并算法已在 [memory-lifecycle-design.md](./2026-06-03-memory-lifecycle-design.md) 6 节 "oh-my-claudecode 深度合并算法" 中有详细设计（合并策略、去重函数、字段级 resolve 策略）。本节仅描述 Notepad 特有的 3-Zone 分层架构。

### 4.1 Architecture

| Zone | Size Limit | Auto-Prune | Always Loaded |
|------|-----------|------------|---------------|
| Priority Context | 500 chars | No | **Yes** |
| Working Memory | — | 7 days | No |
| MANUAL | — | **Never** | No |

### 4.2 Priority Context

Always loaded into system prompt. Contains:
- Current task summary
- Key decisions made
- Critical constraints

### 4.3 Working Memory

Auto-pruned after 7 days of inactivity. Contains:
- Intermediate findings
- Temporary notes
- Exploration results

### 4.4 MANUAL Zone

Never auto-pruned. Contains:
- User-bookmarked insights
- Permanent reference notes
- Explicitly saved items

### 4.5 Files to Create

| File | Purpose | Est. LOC |
|------|---------|---------|
| `src/hooks/notepad/index.ts` | 3-zone memory manager | ~250 |
| `src/hooks/notepad/storage.ts` | Persistence layer (uses deep merge from §6) | ~150 |

---

## 5. Model Routing — 见 [agent-routing-smart-routing-design.md](./2026-06-03-agent-routing-smart-routing-design.md)

本功能（信号提取、权重评分、阈值路由、规则链）已在上述文档 §2 "Smart Model Routing" 中有完整设计，包括配置、检测条件、集成点和文件清单。此处不重复。

---

## 6. AST Tools (P2)

### 6.1 Overview

基于 ast-grep 的结构化代码搜索和替换，支持 17 种语言。

### 6.2 Binary Detection and Installation

```typescript
// src/tools/AstTools/astTools.ts (~200 LOC)

/**
 * Detect ast-grep binary. Try in order:
 * 1. `which sg` (system install)
 * 2. `which ast-grep` (alternative name)
 * 3. node_modules/.bin/ast-grep (local install)
 *
 * If not found and autoInstall is enabled:
 *   npm install -g @ast-grep/cli
 *
 * Returns: path to binary or throws with install instructions.
 */
async function detectAstGrep(): Promise<string>

/**
 * Execute ast-grep command with JSON output.
 * Wraps child_process.spawn with timeout (30s default).
 */
async function execAstGrep(
  binary: string,
  args: string[],
  options: { cwd?: string; timeout?: number }
): Promise<AstGrepResult>
```

### 6.3 Tools

```typescript
interface AstGrepSearchInput {
  pattern: string              // ast-grep pattern with meta-variables
  lang: string                 // language identifier
  paths?: string[]             // file/directory paths to search (default: cwd)
  include?: string[]           // glob include filters
  exclude?: string[]           // glob exclude filters
}

interface AstGrepReplaceInput {
  pattern: string              // pattern to match
  replacement: string          // replacement pattern (can use $NAME etc.)
  lang: string
  paths?: string[]
  dryRun?: boolean             // default: true
}

interface AstGrepSearchResult {
  file: string
  line: number
  column: number
  matched: string              // matched code text
  variables: Record<string, string>  // captured meta-variable values
}

interface AstGrepReplaceResult {
  file: string
  changes: number              // number of replacements in this file
  preview?: string             // unified diff preview (when dryRun=true)
}
```

### 6.4 dryRun Preview Diff Format

当 `dryRun: true`（默认）时，返回 unified diff 格式预览：

```diff
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,3 +10,3 @@
-  const result = oldFunction(args)
+  const result = newFunction(args)
```

用户确认后，以 `dryRun: false` 重新执行应用变更。

### 6.5 Meta-Variables

| Variable | Match |
|----------|-------|
| `$NAME` | Single node |
| `$$ARGS` | Multiple nodes |
| `$$$PARAMS` | Zero or more nodes |

### 6.6 Supported Languages (17)

TypeScript, JavaScript, Python, Rust, Go, Java, C, C++, C#, Ruby, PHP, Kotlin, Swift, Scala, Lua, HTML, CSS

### 6.7 Safety

- `dryRun: true` by default for replace
- Preview diff before applying
- Binary detection runs once per session (cached)

### 6.8 Files to Create

| File | Purpose | Est. LOC |
|------|---------|---------|
| `src/tools/AstTools/astTools.ts` | ast_grep_search + ast_grep_replace + binary detection | ~200 |
| `src/tools/AstTools/types.ts` | TypeScript interfaces | ~50 |

---

## 7. Integration Priority

| Feature | Priority | Effort | LOC | Dependencies |
|---------|----------|--------|-----|-------------|
| Model Routing | P1 | — | — | 见独立设计文档 |
| Ralph PRD System | P1 | M | ~700 | None |
| Learner Auto-Skill | P2 | M | ~650 | Skill system |
| Notepad 3-Zone | P2 | M | ~400 | Memory system (deep merge) |
| AST Tools | P2 | S | ~250 | ast-grep binary |
