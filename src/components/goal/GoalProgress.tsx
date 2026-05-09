import { c as _c } from 'react/compiler-runtime';
import * as React from 'react';
import { useAppState } from '../../state/AppState.js';
import { ThreadGoalStatus } from '../../commands/goal/types.js';

export function GoalProgress() {
  const $ = _c(5);
  const goal = useAppState(_temp);

  let t0;
  if (goal.id === '') {
    t0 = null;
  } else {
    const statusEmoji = {
      [ThreadGoalStatus.Active]: '🎯',
      [ThreadGoalStatus.Paused]: '⏸️',
      [ThreadGoalStatus.BudgetLimited]: '⚠️',
      [ThreadGoalStatus.Complete]: '✅',
    }[goal.status] || '📌'  // Default for empty/idle status;

    const progress = goal.tokenBudget
      ? Math.min(100, (goal.tokensUsed / goal.tokenBudget) * 100)
      : 0;

    t0 = (
      <div className="goal-progress">
        <div className="goal-header">
          <span>{statusEmoji}</span>
          <span className="goal-objective">{goal.objective}</span>
          <span className="goal-status">({goal.status})</span>
        </div>

        {goal.tokenBudget && (
          <div className="goal-budget">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span>{goal.tokensUsed} / {goal.tokenBudget} tokens</span>
          </div>
        )}

        <div className="goal-stats">
          <span>⏱️ {goal.timeUsedSeconds}s</span>
        </div>
      </div>
    );
  }

  if ($[0] !== t0) {
    $[0] = t0;
  }
  return t0;
}

function _temp(s) {
  return s.goal;
}