# Dynamic Workflows Design

**Date**: 2026-06-03
**Status**: Design Complete
**Source**: claude-code-best v2.6.6
**Priority**: P2
**Effort**: L (14 files rewrite)

---

## 1. Overview

Dynamic Workflows 是基于 Markdown/YAML DSL 的任务编排系统，与 ola-cc 现有的 DAG-based workflow 完全不同。用户通过编写 Markdown 文件定义工作流，LLM 驱动逐步执行。

## 2. Comparison with ola-cc Existing Workflow

| Dimension | claude-code (New) | ola-cc (Existing) |
|-----------|-------------------|-------------------|
| DSL format | Markdown + YAML frontmatter | TypeScript DAG definition |
| Execution engine | Step-by-step LLM-driven | Topological sort DAG execution |
| State persistence | `.claude/workflow-runs/*.json` | Memory only |
| Permission control | `/workflows approve <id>` | None |
| User interaction | Approval dialogs, progress UI | None |
| AgentTool integration | Workflow steps can call agents | Independent system |

## 3. Workflow File Format

### 3.1 YAML Frontmatter

```yaml
---
name: deploy-pipeline
description: "Deploy workflow with approval gates"
permissions:
  bash: "allow"          # Auto-approve bash
  file_edit: "ask"       # Need confirmation for file edit
  web_fetch: "deny"      # Block web fetch
---
```

**Permission levels**:
- `"allow"` — Auto-approve this tool type
- `"ask"` — Require user confirmation
- `"deny"` — Block this tool type entirely

### 3.2 Markdown Body

```markdown
# Deploy Pipeline

## Step 1: Build
Run `npm run build` and verify no errors.
Check the output for any warnings.

## Step 2: Test
Run `npm test` and ensure all tests pass.
If any test fails, investigate and fix before proceeding.

## Step 3: Deploy
[requires approval]
Deploy to production with `npm run deploy`.
Verify the deployment at https://example.com
```

**Special markers**:
- `[requires approval]` — Step requires explicit user approval before execution
- `## Step N: Title` — Defines step boundaries
- Code blocks with backticks — Injected as prompt context into the LLM (NOT executed as shell commands). Used to provide example code, reference implementations, or constraints to guide LLM behavior during step execution

**Step 依赖声明**：在 YAML frontmatter 中使用 `depends_on` 显式声明依赖关系：
```yaml
---
name: deploy-pipeline
steps:
  - id: 1
    title: Build
  - id: 2
    title: Test
    depends_on: [1]
  - id: 3
    title: Deploy
    depends_on: [1, 2]
---
```
未声明依赖的步骤默认按顺序执行。

## 4. WorkflowTool 5 Actions

### 4.1 start

```typescript
{
  action: "start",
  workflow: "deploy-pipeline",     // Name or path
  variables: { env: "production" } // Optional template variables
}
```

**Flow**:
1. Find workflow file in `.claude/workflows/` or `~/.claude/workflows/`
2. Parse YAML frontmatter → permissions, metadata
3. Parse Markdown → step list
4. Create run record in `.claude/workflow-runs/{runId}.json`
5. LLM executes Step 1 with permission context

### 4.2 advance

```typescript
{
  action: "advance",
  run_id: "abc-123",
  step_result: "Build completed successfully with 0 errors"
}
```

**Flow**:
1. Load run record from `.claude/workflow-runs/{runId}.json`
2. Mark current step as completed
3. If `[requires approval]` → show approval dialog
4. LLM executes next step with accumulated context

### 4.3 status

```typescript
{ action: "status", run_id: "abc-123" }
```

Returns: current step, progress, last output, pending approvals

### 4.4 cancel

```typescript
{ action: "cancel", run_id: "abc-123" }
```

Marks run as cancelled, no further execution.

### 4.5 list

```typescript
{ action: "list" }
```

Returns available workflow templates from `.claude/workflows/` directories.

## 5. Run Record Format

`.claude/workflow-runs/{runId}.json`:

```json
{
  "id": "abc-123",
  "workflow": "deploy-pipeline",
  "status": "running",
  "currentStep": 2,
  "totalSteps": 3,
  "startedAt": "2026-06-03T10:00:00Z",
  "variables": { "env": "production" },
  "steps": [
    {
      "index": 0,
      "title": "Build",
      "status": "completed",
      "output": "Build completed successfully",
      "completedAt": "2026-06-03T10:02:00Z"
    },
    {
      "index": 1,
      "title": "Test",
      "status": "running",
      "output": null
    },
    {
      "index": 2,
      "title": "Deploy",
      "status": "pending",
      "requiresApproval": true
    }
  ],
  "permissions": {
    "bash": "allow",
    "file_edit": "ask",
    "web_fetch": "deny"
  }
}
```

## 6. Slash Command Integration

`/workflows` command provides:
- `/workflows list` — List available templates
- `/workflows start <name>` — Start a workflow
- `/workflows status [run_id]` — Check status
- `/workflows approve <run_id>` — Approve pending step
- `/workflows cancel <run_id>` — Cancel a run

## 7. Background Task Integration

`LocalWorkflowTask` provides:
- Background execution with progress tracking
- Notification on approval needed
- Auto-resume after approval
- Error recovery and retry

## 8. Files to Modify

| File | Operation | Description |
|------|-----------|-------------|
| `src/tools/WorkflowTool/WorkflowTool.ts` | **Rewrite** | Replace with step-by-step engine |
| `src/tools/WorkflowTool/constants.ts` | **Extend** | Add WORKFLOW_DIR_NAME, extensions |
| `src/tools/WorkflowTool/createWorkflowCommand.ts` | **Rewrite** | Slash command generator |
| `src/tools/WorkflowTool/WorkflowPermissionRequest.tsx` | **Rewrite** | Permission UI |
| `src/tools/WorkflowTool/workflowTypes.ts` | **Delete** | DAG types no longer needed |
| `src/tools/WorkflowTool/index.ts` | **Delete** | No longer needed |
| `src/utils/workflowRuns.ts` | **New** | Run record persistence |
| `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` | **Rewrite** | Background task |
| `src/components/tasks/WorkflowDetailDialog.tsx` | **Rewrite** | Detail UI |
| `src/commands/workflows/index.ts` | **Rewrite** | /workflows command |
| `src/tools.ts` | **Adjust** | Feature gate |
| `src/constants/tools.ts` | **Adjust** | Feature gate consistency |
| `scripts/build.ts` | **Add** | WORKFLOW_SCRIPTS flag |

## 9. Risks

- **Breaking change**: Replaces existing DAG-based workflow entirely
- **LLM dependency**: Each step execution requires API call (cost + latency)
- **State management**: File-based persistence needs cleanup for old runs（保留最近 50 个 run records，超过的按时间自动删除）
- **Permission complexity**: Per-step permission overrides need careful testing
- **Feature flag**: `WORKFLOW_SCRIPTS` gate needed to avoid breaking existing users（默认值: `off`）

## 10. Error Recovery

### 10.1 Step Failure

When a single step fails:
- Record error details in the step's `output` field and set `status: "failed"`
- Skip all downstream steps that depend on the failed step (dependency inferred from step ordering)
- Independent steps (no transitive dependency on the failed step) continue executing
- The run `status` remains `"running"` as long as there are executable steps remaining

### 10.2 Run Failure and Retry

When a run encounters a fatal error (e.g., API failure, permission denied):
- Retry up to **3 times** with exponential backoff: **1s → 2s → 4s**
- After 3 retries, mark the run `status: "failed"` and persist the error in the run record
- User can manually resume a failed run via `/workflows start <name> --resume <run_id>`

### 10.3 Rollback Policy

Workflows are **declarative** — no automatic rollback is performed on failure. Instead:
- Provide an `on_failure` hook in the YAML frontmatter for users to define custom rollback logic
- Example:

```yaml
---
name: deploy-pipeline
on_failure:
  - run: "kubectl rollout undo deployment/app"
  - notify: "Deployment failed, rolled back to previous version"
---
```

The `on_failure` hook executes only when the run reaches `status: "failed"` (all retries exhausted or a non-retryable error).

### 10.4 Step Timeout

Each step has a `maxTurns` limit to prevent runaway execution:
- Default: **30 turns** (each turn = one LLM call + tool execution cycle)
- Configurable per-step via frontmatter or step annotation: `[max_turns: 50]`
- When exceeded, the step is marked `status: "timeout"` and treated as a step failure (see 10.1)

## 11. Migration Strategy

1. Keep existing DAG workflow as `legacy-workflow` command
2. Implement new Dynamic Workflows as `workflow` command
3. Add migration tool to convert simple DAG workflows to Markdown format
4. Deprecate legacy after 2 release cycles

**迁移步骤**：
1. 运行 `claude workflow convert <legacy-id>` 将 DAG 转换为 Markdown
2. 检查转换结果，手动调整不兼容的步骤
3. 测试新 workflow
4. 删除旧 DAG 定义

## 12. LOC Estimation and Complexity

| File | Operation | Est. LOC | Difficulty |
|------|-----------|----------|------------|
| `src/tools/WorkflowTool/WorkflowTool.ts` | Rewrite | ~400 | **Hard** — core engine: step parser, execution loop, permission gating, retry logic |
| `src/tools/WorkflowTool/constants.ts` | Extend | ~30 | Easy — add directory name and file extension constants |
| `src/tools/WorkflowTool/createWorkflowCommand.ts` | Rewrite | ~120 | Medium — slash command wiring, subcommand dispatch |
| `src/tools/WorkflowTool/WorkflowPermissionRequest.tsx` | Rewrite | ~150 | Medium — approval dialog UI with Ink components |
| `src/tools/WorkflowTool/workflowTypes.ts` | Delete | -200 | Easy — remove unused DAG types |
| `src/tools/WorkflowTool/index.ts` | Delete | -20 | Easy — barrel export no longer needed |
| `src/utils/workflowRuns.ts` | New | ~180 | Medium — JSON persistence, run record CRUD, cleanup |
| `src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts` | Rewrite | ~250 | **Hard** — background task lifecycle, progress tracking, approval wait, error recovery |
| `src/components/tasks/WorkflowDetailDialog.tsx` | Rewrite | ~200 | Medium — step list, status indicators, approval buttons |
| `src/commands/workflows/index.ts` | Rewrite | ~100 | Medium — command registration and help text |
| `src/tools.ts` | Adjust | ~5 | Easy — feature gate one-liner |
| `src/constants/tools.ts` | Adjust | ~5 | Easy — feature gate consistency |
| `scripts/build.ts` | Add | ~10 | Easy — add WORKFLOW_SCRIPTS feature flag |
| **Total (new/rewritten)** | | **~1,450** | |

**Overall difficulty**: **Hard** — Core engine rewrite with LLM-driven execution, permission system, background task integration, and error recovery. Estimated 3-5 days for a single developer familiar with the codebase.
