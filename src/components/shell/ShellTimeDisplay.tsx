import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Text } from '../../ink.js';
import { formatDuration } from '../../utils/format.js';

type Props = {
  elapsedTimeSeconds?: number;
  timeoutMs?: number;
  /** When true, show remaining time until timeout as countdown */
  showCountdown?: boolean;
};

export function ShellTimeDisplay(t0) {
  const $ = _c(14);
  const {
    elapsedTimeSeconds,
    timeoutMs,
    showCountdown
  } = t0;
  if (elapsedTimeSeconds === undefined && !timeoutMs) {
    return null;
  }
  let t1;
  if ($[0] !== timeoutMs) {
    t1 = timeoutMs ? formatDuration(timeoutMs, {
      hideTrailingZeros: true
    }) : undefined;
    $[0] = timeoutMs;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const timeout = t1;

  // Compute remaining time when countdown is requested
  const remainingMs = (showCountdown && timeoutMs && elapsedTimeSeconds !== undefined && !Number.isNaN(elapsedTimeSeconds))
    ? timeoutMs - (elapsedTimeSeconds * 1000)
    : undefined;
  const remainingSeconds = remainingMs !== undefined && !Number.isNaN(remainingMs) ? Math.max(0, Math.ceil(remainingMs / 1000)) : undefined;

  if (elapsedTimeSeconds === undefined) {
    const t2 = `(timeout ${timeout})`;
    let t3;
    if ($[2] !== t2) {
      t3 = <Text dimColor={true}>{t2}</Text>;
      $[2] = t2;
      $[3] = t3;
    } else {
      t3 = $[3];
    }
    return t3;
  }

  const t2 = elapsedTimeSeconds * 1000;
  let t3;
  if ($[4] !== t2) {
    t3 = formatDuration(t2);
    $[4] = t2;
    $[5] = t3;
  } else {
    t3 = $[5];
  }
  const elapsed = t3;

  if (timeout) {
    let displayText: string;
    if (showCountdown && remainingSeconds !== undefined && remainingSeconds > 0 && remainingSeconds < 60) {
      // Show countdown when less than 60 seconds remain
      displayText = `(${elapsed} · timeout in ${remainingSeconds}s)`;
    } else if (showCountdown && remainingMs !== undefined && remainingMs <= 0) {
      // Timeout reached
      displayText = `(${elapsed} · timed out)`;
    } else {
      displayText = `(${elapsed} · timeout ${timeout})`;
    }
    let t5;
    if ($[6] !== displayText) {
      t5 = <Text dimColor={true}>{displayText}</Text>;
      $[6] = displayText;
      $[7] = t5;
    } else {
      t5 = $[7];
    }
    return t5;
  }

  const t4 = `(${elapsed})`;
  let t5;
  if ($[8] !== t4) {
    t5 = <Text dimColor={true}>{t4}</Text>;
    $[8] = t4;
    $[9] = t5;
  } else {
    t5 = $[9];
  }
  return t5;
}
