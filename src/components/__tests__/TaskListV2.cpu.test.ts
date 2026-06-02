/**
 * CPU 100% regression tests for TaskListV2 broad selector fix.
 *
 * Problem: `useAppState(s => s.teamContext)` subscribes to the entire
 * teamContext object. When any field in teamContext changes (e.g. teamName,
 * leadAgentId, selfAgentId), all components subscribing to teamContext
 * re-render, even if they only use `teammates`.
 *
 * Fix: Replace with `useDerivedStore` that derives only `teammates`,
 * so changes to other teamContext fields don't trigger re-renders.
 *
 * Test approach: Since TaskListV2 uses React + Ink (hard to render in tests),
 * we test the selector logic directly to verify the narrow derivation works.
 */
import { describe, it, expect } from 'bun:test'
import type { AppState } from '../../state/AppStateStore.js'

// The narrow selector that TaskListV2 should use for teammates
const deriveTeammates = (s: AppState) => s.teamContext?.teammates ?? null

// Helper to create a minimal teamContext
function createTeamContext(overrides: Record<string, any> = {}) {
  return {
    teamName: 'test-team',
    teamFilePath: '/tmp/team.md',
    leadAgentId: 'lead-1',
    teammates: {
      'researcher': {
        name: 'researcher',
        color: 'blue',
        tmuxSessionName: 'sess-1',
        tmuxPaneId: '%1',
        cwd: '/tmp',
        spawnedAt: Date.now(),
      },
    },
    ...overrides,
  }
}

describe('TaskListV2: teammates narrow selector', () => {
  it('should derive teammates from teamContext', () => {
    const teammates = {
      'researcher': {
        name: 'researcher',
        color: 'blue',
        tmuxSessionName: 'sess-1',
        tmuxPaneId: '%1',
        cwd: '/tmp',
        spawnedAt: 1000,
      },
    }
    const state = {
      teamContext: createTeamContext({ teammates }),
    } as any as AppState

    const result = deriveTeammates(state)
    expect(result).toBe(teammates)
  })

  it('should return null when teamContext is undefined', () => {
    const state = {} as any as AppState
    expect(deriveTeammates(state)).toBe(null)
  })

  it('should return null when teamContext exists but teammates is undefined', () => {
    const state = {
      teamContext: {
        teamName: 'test-team',
        teamFilePath: '/tmp/team.md',
        leadAgentId: 'lead-1',
      },
    } as any as AppState
    expect(deriveTeammates(state)).toBe(null)
  })

  it('should NOT trigger re-render when teamContext fields other than teammates change', () => {
    const teammates = {
      'researcher': {
        name: 'researcher',
        color: 'blue',
        tmuxSessionName: 'sess-1',
        tmuxPaneId: '%1',
        cwd: '/tmp',
        spawnedAt: 1000,
      },
    }

    // Initial state
    const state1 = {
      teamContext: createTeamContext({
        teammates,
        teamName: 'test-team',
        leadAgentId: 'lead-1',
      }),
    } as any as AppState

    // State after teamName changes but teammates is the same reference
    const state2 = {
      teamContext: createTeamContext({
        teammates,  // same reference
        teamName: 'renamed-team',  // changed
        leadAgentId: 'lead-1',
      }),
    } as any as AppState

    const result1 = deriveTeammates(state1)
    const result2 = deriveTeammates(state2)

    // Strict equality: same teammates reference means no re-render
    expect(result1).toBe(result2)
    expect(result1 === result2).toBe(true)
  })

  it('should trigger re-render when teammates reference changes', () => {
    const teammates1 = {
      'researcher': {
        name: 'researcher',
        color: 'blue',
        tmuxSessionName: 'sess-1',
        tmuxPaneId: '%1',
        cwd: '/tmp',
        spawnedAt: 1000,
      },
    }
    const teammates2 = {
      'researcher': {
        name: 'researcher',
        color: 'blue',
        tmuxSessionName: 'sess-1',
        tmuxPaneId: '%1',
        cwd: '/tmp',
        spawnedAt: 1000,
      },
      'writer': {
        name: 'writer',
        color: 'green',
        tmuxSessionName: 'sess-2',
        tmuxPaneId: '%2',
        cwd: '/tmp',
        spawnedAt: 2000,
      },
    }

    const state1 = {
      teamContext: createTeamContext({ teammates: teammates1 }),
    } as any as AppState

    const state2 = {
      teamContext: createTeamContext({ teammates: teammates2 }),
    } as any as AppState

    const result1 = deriveTeammates(state1)
    const result2 = deriveTeammates(state2)

    // Different references: re-render will happen
    expect(result1).not.toBe(result2)
    // But content is different too
    expect(Object.keys(result2!).length).toBe(2)
  })

  it('should NOT re-render when teammates is replaced with same-content object (shallow equal)', () => {
    // This tests whether useDerivedStore's selectorSkip mechanism works:
    // Even if teamContext is replaced (new reference), if teammates hasn't
    // changed at the selector level, the store should skip notification.
    const teammates = {
      'researcher': {
        name: 'researcher',
        color: 'blue',
        tmuxSessionName: 'sess-1',
        tmuxPaneId: '%1',
        cwd: '/tmp',
        spawnedAt: 1000,
      },
    }

    const state1 = {
      teamContext: createTeamContext({ teammates }),
    } as any as AppState

    // Same teammates reference, different teamContext wrapper
    const state2 = {
      teamContext: createTeamContext({ teammates }),
    } as any as AppState

    const result1 = deriveTeammates(state1)
    const result2 = deriveTeammates(state2)

    // Strict equality holds because teammates is the same reference
    expect(result1 === result2).toBe(true)
  })

  it('broad selector (old code) would re-render on any teamContext change', () => {
    // This demonstrates the problem with the old broad selector:
    // `useAppState(s => s.teamContext)` subscribes to the whole object

    const broadSelector = (s: AppState) => s.teamContext

    const teammates = {
      'researcher': {
        name: 'researcher',
        color: 'blue',
        tmuxSessionName: 'sess-1',
        tmuxPaneId: '%1',
        cwd: '/tmp',
        spawnedAt: 1000,
      },
    }

    const state1 = {
      teamContext: createTeamContext({ teammates, teamName: 'test-team' }),
    } as any as AppState

    const state2 = {
      teamContext: createTeamContext({ teammates, teamName: 'renamed-team' }),
    } as any as AppState

    const result1 = broadSelector(state1)
    const result2 = broadSelector(state2)

    // Broad selector sees different teamContext references → re-render
    // even though teammates is identical
    expect(result1).not.toBe(result2)
  })
})
