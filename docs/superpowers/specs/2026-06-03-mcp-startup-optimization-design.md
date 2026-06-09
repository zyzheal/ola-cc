# MCP Startup Optimization Design

## Problem Statement

When ola-cc CLI starts, MCP servers auto-connect at REPL mount time, blocking stdin raw-mode initialization and causing 3-6 second input delay. Users cannot type or interact with the TUI until MCP connections complete or timeout.

### Root Cause Analysis

1. **Timing conflict**: `useManageMCPConnections` hook triggers `loadAndConnectMcpConfigs()` immediately at REPL mount (L1012)
2. **Effect #1 also blocks**: `initializeServersAsPending()` (L843) is called immediately too, fetching all MCP configs synchronously before connections even start
3. **stdin blocking**: MCP connection callbacks trigger React re-renders before Ink's stdin raw-mode setup completes
4. **Batch overhead**: `MCP_BATCH_FLUSH_MS = 16` causes frequent state updates and re-renders (ola-cc value; openclaude uses 100ms)
5. **No cancellation**: Once started, MCP connections cannot be cancelled or deprioritized

### Evidence from Debug Logs

- REPL mounted at 13:45:42.266Z
- Query loop started at 13:45:48.212Z (~6s gap)
- MCP playwright: 2.6s fail → 2.6s retry fail
- MCP context7: 2.3s fail → 1.9s retry fail
- Total blocking time: ~5-6 seconds

## Reference Implementations

Three projects were analyzed for MCP startup optimization:

| Feature | claude-code (official) | openclaude | oh-my-claudecode |
|---------|------------------------|------------|------------------|
| Delayed connection | No (immediate `void loadAndConnectMcpConfigs()`) | `setTimeout(0)` defer | N/A (in-process) |
| Batch flush interval | 16ms (same as ola-cc) | `MCP_BATCH_FLUSH_MS=100` | N/A |
| Non-blocking mode | No env var exists (verified by code search) | Default non-blocking via defer | Zero REPL impact |
| On-demand loading | `ToolSearchTool` deferred tools | `ToolSearchTool` deferred tools | `createSdkMcpServer` in-process |
| Connection timeout | 30s (`MCP_TIMEOUT` env var) | 30s (`MCP_TIMEOUT` env var) | N/A |
| Failure handling | 5 retries + exponential backoff (1s→16s) | 5 retries + exponential backoff (1s→16s) | N/A |
| Memoized connection | `lodash memoize` on `connectToServer` | `lodash memoize` on `connectToServer` | N/A |

**Key insight**: openclaude's `setTimeout(0)` + `MCP_BATCH_FLUSH_MS=100` directly solves the stdin blocking issue (issue #603). All three projects connect all MCP servers at first startup—no "smart selection" based on history.

**Correction**: The original design referenced `MCP_CONNECTION_NONBLOCKING` from claude-code. Code search confirms this env var does NOT exist in either ola-cc or claude-code source. L2's non-blocking design must be implemented from scratch, not "extended" from an existing feature.

## Design: Progressive Refactoring (4 Layers)

### L0: Quick Fix (Immediate Relief)

**Goal**: Eliminate stdin blocking at REPL mount

**Changes**:

1. **Defer MCP connections by 1 event-loop tick**
   - File: `src/services/mcp/useManageMCPConnections.ts` L1012
   - Current: `void loadAndConnectMcpConfigs()`
   - Change to: `setTimeout(() => { if (!cancelled) void loadAndConnectMcpConfigs() }, 0)`
   - Reason: Let stdin raw-mode complete initialization first (openclaude issue #603)
   - This is a direct port of openclaude's fix at L1011-1021 of their `useManageMCPConnections.ts`

2. **Also defer `initializeServersAsPending` effect**
   - File: `src/services/mcp/useManageMCPConnections.ts` L843
   - Current: `void initializeServersAsPending().catch(...)`
   - Change to: `setTimeout(() => { if (!cancelled) void initializeServersAsPending().catch(...) }, 0)`
   - Reason: Effect #1 (`initializeServersAsPending`) also runs synchronously at mount and fetches all MCP configs via `getClaudeCodeMcpConfigs()`, which can take 100-500ms. Deferring it ensures both effects yield to stdin setup.

3. **Adjust batch flush interval**
   - File: `src/services/mcp/useManageMCPConnections.ts`
   - Current: `const MCP_BATCH_FLUSH_MS = 16`
   - Change to: `const MCP_BATCH_FLUSH_MS = 100`
   - Reason: Reduce state update frequency, lower re-render overhead
   - Trade-off: Individual MCP server status updates appear with up to 100ms delay (vs 16ms). This is acceptable since users don't need real-time feedback during background connection.
   - Reference: openclaude uses 100ms with no reported issues

**Expected outcome**: Startup delay from 3-6s to < 500ms

**Reference**: openclaude `useManageMCPConnections.ts` L1011-1021 (defer), L207 (batch interval)

### L1: Fast-Skip for Failing Servers

**Goal**: Skip reconnection for servers that consistently fail

**Changes**:

1. **Track connection failure count in memory**
   - File: `src/services/mcp/useManageMCPConnections.ts`
   - Add: `consecutiveFailures: number` to `MCPServerConnection` type
   - Increment on connection failure, reset to 0 on success
   - Note: This counts failures within the current session only (no cross-session persistence to avoid stale state)

2. **Skip reconnection after 2 consecutive failures**
   - File: `src/services/mcp/useManageMCPConnections.ts`
   - In reconnection logic: if `consecutiveFailures >= 2` (i.e., initial connect + 1 retry both fail), set `type: 'failed'` and skip further reconnection
   - User can manually reconnect via `/mcp connect <name>`
   - Note: The initial connection attempt counts as failure #1; the first retry counts as failure #2

3. **Persist failure state across sessions** (simplified)
   - File: `~/.claude/mcp-failure-state.json`
   - Store: `{ serverName: { failCount, lastFailTime } }`
   - Load at startup: servers with `failCount >= 2` AND `lastFailTime` within last 7 days are marked as `type: 'failed'` immediately (skip connection attempt)
   - TTL: 7 days — entries older than 7 days are cleared, allowing automatic retry
   - Security: File is user-local only (`~/.claude/`), no sensitive data stored
   - Reset on success: `failCount` reset to 0 when connection succeeds

**Expected outcome**: Failing servers don't block startup after first failure

**Reference**: openclaude reconnection logic with exponential backoff

### L2: User Control (Cancel + Background Connection)

**Goal**: Allow users to cancel MCP connections and ensure REPL always remains responsive

**Changes**:

1. **Implement background MCP connection mode**
   - File: `src/services/mcp/useManageMCPConnections.ts`
   - New env var: `MCP_STARTUP_DELAY_MS` (default: 0, meaning `setTimeout(0)`)
   - When set > 0, MCP connections are delayed by the specified milliseconds
   - This provides a fallback if `setTimeout(0)` alone doesn't resolve the stdin race on some terminals
   - MCP connections always run in background — REPL is never blocked waiting for them

2. **Add `/mcp cancel` command**
   - File: `src/commands/mcp/cancel.ts` (new)
   - Behavior: Cancel all in-progress MCP connections via AbortController
   - Output: Show which connections were cancelled, which already completed
   - Already-completed connections remain available

3. **Add AbortController to connection flow**
   - File: `src/services/mcp/client.ts`
   - Add `AbortSignal` parameter to `connectToServer`
   - **Conflict with memoize**: `connectToServer` is wrapped with `lodash memoize` (L595). Adding `AbortSignal` as a parameter would break memoization (signal objects are never equal).
   - **Solution**: Keep `connectToServer` memoized signature unchanged. Add a separate `abortConnection(name: string)` function that:
     1. Clears the memoize cache for the given server (`clearConnectToServerCache` already exists at L1648)
     2. Closes the underlying transport if a connection is in progress
     3. Sets the server state to `type: 'cancelled'`
   - The AbortController is managed at the hook level (`useManageMCPConnections`), not passed through `connectToServer`

**Expected outcome**: Users can cancel stuck connections, REPL always responsive

**Reference**: ola-cc `clearConnectToServerCache` (client.ts L1648) for abort mechanism

### L3: In-Process MCP (Optional Optimization)

**Goal**: Zero REPL impact for high-frequency MCP servers

**Changes**:

1. **Identify high-frequency MCP servers**
   - Candidates: filesystem, memory, custom tools
   - Criteria: Used in >50% of sessions, <100ms response time

2. **Convert to `createSdkMcpServer` in-process mode**
   - File: `src/services/mcp/inProcessServers.ts` (new)
   - Use Agent SDK's `createSdkMcpServer` to create in-process servers
   - No network/stdio overhead, zero REPL impact

3. **Hybrid mode: in-process + external**
   - High-frequency servers: in-process
   - Other servers: external (current behavior)

4. **Third-party alternative: harshal-mcp-proxy gateway pattern**
   - Uses 6 gateway tools (`search`, `describe`, `invoke`, `invoke_async`, `invoke_status`, `get_result`)
   - Tool schemas loaded from disk snapshots, servers started only on first call
   - Claims ~99% context savings and ~2.7GB RAM savings
   - Can be evaluated as a future enhancement if L3 in-process approach is insufficient

**Expected outcome**: Zero connection overhead for core MCP servers

**Reference**: oh-my-claudecode `omc-tools-server.ts`, harshal-mcp-proxy gateway pattern

## Implementation Priority

| Layer | Priority | Effort | Impact |
|-------|----------|--------|--------|
| L0 | P0 (immediate) | 1 hour | Fixes core issue |
| L1 | P1 (next sprint) | 2 hours | Improves reliability |
| L2 | P2 (user request) | 4 hours | User control |
| L3 | P3 (optional) | 8 hours | Performance optimization |

## Success Criteria

1. **Startup delay < 500ms**: From REPL mount to stdin responsive
2. **Backward compatible**: All existing MCP functionality works unchanged
3. **No regression**: MCP tools available within same timeframe as before
4. **User control**: `/mcp cancel` command works to abort connections

## Testing Plan

1. **L0 verification**:
   - Start ola-cc with 5+ MCP servers configured
   - Measure time from REPL mount to first keystroke accepted
   - Compare before/after with `console.time` markers
   - Test with failing MCP servers to verify deferred startup still works

2. **L1 verification**:
   - Configure a failing MCP server (invalid command)
   - Verify it's skipped after 2 failures within session
   - Verify `/mcp connect <name>` can manually reconnect
   - Verify failure state persists across sessions (restart ola-cc)
   - Verify 7-day TTL: manually set `lastFailTime` to 8 days ago, confirm server reconnects

3. **L2 verification**:
   - Start ola-cc, immediately type `/mcp cancel`
   - Verify connections are cancelled
   - Verify REPL remains responsive during connection
   - Verify `MCP_STARTUP_DELAY_MS=500` delays connection start
   - Verify `clearConnectToServerCache` is called on cancel

4. **L3 verification**:
   - Convert one MCP server to in-process mode
   - Measure connection time (should be <10ms)
   - Verify tool functionality unchanged

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `setTimeout(0)` doesn't fully resolve race on all terminals | Add configurable `MCP_STARTUP_DELAY_MS` env var |
| Both effects deferred may cause brief "no MCP servers" state | Acceptable: MCP servers appear within 100-500ms, same as openclaude |
| Failure state persistence gets stale (server fixed but still skipped) | 7-day TTL auto-expires; `/mcp connect` manual override |
| `/mcp cancel` leaves partial state (memoize cache) | Call `clearConnectToServerCache` on cancel |
| AbortSignal incompatible with memoize | Use hook-level AbortController + `clearConnectToServerCache` instead of passing signal through |
| `MCP_BATCH_FLUSH_MS=100` delays status updates | Acceptable trade-off: users don't need real-time connection feedback |
| In-process servers have different behavior | Extensive testing before enabling by default |
| `initializeServersAsPending` deferral may affect disabled server cleanup | Test that disabled servers are still properly removed from state |

## References

- openclaude issue #603: stdin rawMode race condition
- openclaude `useManageMCPConnections.ts` L1011-1021: setTimeout defer
- oh-my-claudecode `omc-tools-server.ts`: createSdkMcpServer pattern
- ola-cc `src/services/mcp/client.ts` L595: memoize on `connectToServer`
- ola-cc `src/services/mcp/client.ts` L1648: `clearConnectToServerCache`
- ola-cc `src/services/mcp/useManageMCPConnections.ts` L843: `initializeServersAsPending`
- ola-cc `src/services/mcp/useManageMCPConnections.ts` L1012: `void loadAndConnectMcpConfigs()`
- harshal-mcp-proxy: gateway pattern with disk snapshots for lazy loading
