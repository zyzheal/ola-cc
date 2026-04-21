import { c as _c } from "react/compiler-runtime";
import React from 'react';
import stripAnsi from 'strip-ansi';
import { Box, Text } from '../../ink.js';
import { formatFileSize } from '../../utils/format.js';
import { MessageResponse } from '../MessageResponse.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { ShellTimeDisplay } from './ShellTimeDisplay.js';

type Props = {
  output: string;
  fullOutput: string;
  elapsedTimeSeconds?: number;
  totalLines?: number;
  totalBytes?: number;
  timeoutMs?: number;
  taskId?: string;
  verbose: boolean;
};

export function ShellProgressMessage(t0) {
  const $ = _c(32);
  const {
    output,
    fullOutput,
    elapsedTimeSeconds,
    totalLines,
    totalBytes,
    timeoutMs,
    verbose
  } = t0;
  let t1;
  if ($[0] !== fullOutput) {
    t1 = stripAnsi(fullOutput.trim());
    $[0] = fullOutput;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const strippedFullOutput = t1;
  let lines;
  let t2;
  if ($[2] !== output || $[3] !== strippedFullOutput || $[4] !== verbose) {
    const strippedOutput = stripAnsi(output.trim());
    lines = strippedOutput.split("\n").filter(_temp);
    t2 = verbose ? strippedFullOutput : lines.slice(-5).join("\n");
    $[2] = output;
    $[3] = strippedFullOutput;
    $[4] = verbose;
    $[5] = lines;
    $[6] = t2;
  } else {
    lines = $[5];
    t2 = $[6];
  }
  const displayLines = t2;

  // Check if we're close to timeout (within 30 seconds)
  const elapsedMs = elapsedTimeSeconds !== undefined ? elapsedTimeSeconds * 1000 : 0;
  const timeRemainingMs = timeoutMs ? timeoutMs - elapsedMs : undefined;
  const nearTimeout = timeRemainingMs !== undefined && timeRemainingMs > 0 && timeRemainingMs < 30000;
  const showCountdown = nearTimeout;

  if (!lines.length) {
    // No output yet — show explicit running indicator with time
    let runningText: React.ReactNode;
    if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
      // Use a pulsing indicator to clearly show the command is still running
      runningText = <Text dimColor={true}>[running] Running… </Text>;
      $[7] = runningText;
    } else {
      runningText = $[7];
    }
    let t4;
    if ($[8] !== elapsedTimeSeconds || $[9] !== timeoutMs || $[10] !== showCountdown) {
      t4 = <MessageResponse><OffscreenFreeze>{runningText}<ShellTimeDisplay elapsedTimeSeconds={elapsedTimeSeconds} timeoutMs={timeoutMs} showCountdown={showCountdown} /></OffscreenFreeze></MessageResponse>;
      $[8] = elapsedTimeSeconds;
      $[9] = timeoutMs;
      $[10] = showCountdown;
      $[11] = t4;
    } else {
      t4 = $[11];
    }
    return t4;
  }

  const extraLines = totalLines ? Math.max(0, totalLines - 5) : 0;
  let lineStatus = "";
  if (!verbose && totalBytes && totalLines) {
    lineStatus = `~${totalLines} lines`;
  } else {
    if (!verbose && extraLines > 0) {
      lineStatus = `+${extraLines} lines`;
    }
  }
  const t3 = verbose ? undefined : Math.min(5, lines.length);
  let t4;
  if ($[12] !== displayLines) {
    t4 = <Text dimColor={true}>{displayLines}</Text>;
    $[12] = displayLines;
    $[13] = t4;
  } else {
    t4 = $[13];
  }
  let t5;
  if ($[14] !== t3 || $[15] !== t4) {
    t5 = <Box height={t3} flexDirection="column" overflow="hidden">{t4}</Box>;
    $[14] = t3;
    $[15] = t4;
    $[16] = t5;
  } else {
    t5 = $[16];
  }
  let t6;
  if ($[17] !== lineStatus) {
    t6 = lineStatus ? <Text dimColor={true}>{lineStatus}</Text> : null;
    $[17] = lineStatus;
    $[18] = t6;
  } else {
    t6 = $[18];
  }
  let t7;
  if ($[19] !== elapsedTimeSeconds || $[20] !== timeoutMs || $[21] !== showCountdown) {
    t7 = <ShellTimeDisplay elapsedTimeSeconds={elapsedTimeSeconds} timeoutMs={timeoutMs} showCountdown={showCountdown} />;
    $[19] = elapsedTimeSeconds;
    $[20] = timeoutMs;
    $[21] = showCountdown;
    $[22] = t7;
  } else {
    t7 = $[22];
  }
  let t8;
  if ($[23] !== totalBytes) {
    t8 = totalBytes ? <Text dimColor={true}>{formatFileSize(totalBytes)}</Text> : null;
    $[23] = totalBytes;
    $[24] = t8;
  } else {
    t8 = $[24];
  }
  let t9;
  if ($[25] !== t6 || $[26] !== t7 || $[27] !== t8) {
    t9 = <Box flexDirection="row" gap={1}>{t6}{t7}{t8}</Box>;
    $[25] = t6;
    $[26] = t7;
    $[27] = t8;
    $[28] = t9;
  } else {
    t9 = $[28];
  }
  let t10;
  if ($[29] !== t5 || $[30] !== t9) {
    t10 = <MessageResponse><OffscreenFreeze><Box flexDirection="column">{t5}{t9}</Box></OffscreenFreeze></MessageResponse>;
    $[29] = t5;
    $[30] = t9;
    $[31] = t10;
  } else {
    t10 = $[31];
  }
  return t10;
}

function _temp(line) {
  return line;
}
