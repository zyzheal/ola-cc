import type { TurnRecord } from "../../commands/goal/types.js";

// --- Types ---

export type ScenarioType =
  | "code_change"
  | "doc_writing"
  | "troubleshooting"
  | "design_improve"
  | "refactoring";

export interface ConvergenceState {
  informationGains: number[];
  qualityScores: number[];
  changeMagnitudes: number[];
  round: number;
}

export interface ConvergenceResult {
  converged: boolean;
  reason?: string;
  strategyHint?: string;
}

// --- Constants ---

const SCENARIO_QUALITY_WEIGHTS: Record<
  ScenarioType,
  { buildStatus: number; testPassing: number; reviewResult: number; noRegression: number }
> = {
  code_change:     { buildStatus: 0.30, testPassing: 0.35, reviewResult: 0.20, noRegression: 0.15 },
  doc_writing:     { buildStatus: 0.05, testPassing: 0.10, reviewResult: 0.55, noRegression: 0.30 },
  troubleshooting: { buildStatus: 0.15, testPassing: 0.20, reviewResult: 0.25, noRegression: 0.40 },
  design_improve:  { buildStatus: 0.10, testPassing: 0.15, reviewResult: 0.50, noRegression: 0.25 },
  refactoring:     { buildStatus: 0.25, testPassing: 0.40, reviewResult: 0.20, noRegression: 0.15 },
};

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "have", "has",
  "had", "do", "does", "did", "will", "would", "could", "should", "may",
  "might", "can", "shall", "i", "you", "he", "she", "it", "we", "they",
  "this", "that", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "not", "or", "and", "but", "if", "then", "so",
]);

// --- Tokenizer ---

/**
 * Tokenize text into a set of tokens for Jaccard similarity.
 * English: word splitting + stop word filtering.
 * Chinese: bigram + unigram tokenization.
 */
export function tokenize(text: string): Set<string> {
  const lower = text.toLowerCase();
  // English: split by non-alphanumeric, filter stop words and single chars
  const englishWords = lower
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  // Chinese: extract CJK characters, then bigram + unigram
  const chineseChars = lower.replace(/[^\u4e00-\u9fff]+/g, "");
  const chineseBigrams: string[] = [];
  for (let i = 0; i < chineseChars.length - 1; i++) {
    chineseBigrams.push(chineseChars.slice(i, i + 2));
  }
  const chineseUnigrams = [...chineseChars];

  return new Set([...englishWords, ...chineseBigrams, ...chineseUnigrams]);
}

// --- Information Gain ---

/**
 * Information gain [0, 1]. Weighted across three dimensions:
 * - toolNovelty (0.4): proportion of novel tool calls this turn
 * - observable (0.35): hadObservableChanges (binary signal)
 * - outputNovelty (0.25): Jaccard distance of outputSummary
 *
 * Empty output handling: both empty -> 0, one empty -> 1.
 */
export function computeInformationGain(
  current: TurnRecord,
  previous: TurnRecord | undefined,
): number {
  if (!previous) return 1.0;

  // Dimension 1: tool novelty
  const curr = new Set(current.toolCallsSummary ?? []);
  const prev = new Set(previous.toolCallsSummary ?? []);
  const novel = [...curr].filter((t) => !prev.has(t)).length;
  const toolNovelty = curr.size > 0 ? Math.min(novel / curr.size, 1.0) : 0;

  // Dimension 2: observable changes
  const observable = current.hadObservableChanges ? 1.0 : 0.0;

  // Dimension 3: output novelty (Jaccard distance)
  const currText = current.outputSummary ?? "";
  const prevText = previous.outputSummary ?? "";
  let outputNovelty: number;
  if (currText.length === 0 && prevText.length === 0) {
    outputNovelty = 0; // both empty = no new info
  } else if (currText.length === 0 || prevText.length === 0) {
    outputNovelty = 1; // one empty = maximum difference
  } else {
    const currWords = tokenize(currText);
    const prevWords = tokenize(prevText);
    const intersection = [...currWords].filter((w) => prevWords.has(w));
    const union = new Set([...currWords, ...prevWords]);
    const jaccard = union.size === 0 ? 1.0 : intersection.length / union.size;
    outputNovelty = 1.0 - jaccard;
  }

  return Math.max(
    0,
    Math.min(1, 0.4 * toolNovelty + 0.35 * observable + 0.25 * outputNovelty),
  );
}

// --- Quality Score ---

/**
 * Quality score [0, 100]. Four dimensions weighted by scenario.
 * Uses negative lookbehind to avoid "no error" false positives.
 */
export function computeQualityScore(turn: TurnRecord, scenario: ScenarioType): number {
  const weights = SCENARIO_QUALITY_WEIGHTS[scenario];
  const output = (turn.outputSummary ?? "").toLowerCase();

  // Build status: negative lookbehind excludes "no error" / "0 errors"
  const hasBuildError = /(?<!no |0 )(?:: error|build failed|syntax error|type error)/.test(output);
  const hasBuildSuccess = /build successful|compiled successfully|no errors|0 errors/.test(output);
  const buildScore = hasBuildError ? 0 : hasBuildSuccess ? 100 : 70;

  // Test status: negative lookbehind excludes "0 failing"
  const hasTestError = /test failed|assertion error|(?<!0 )failing/.test(output);
  const hasTestSuccess = /test passed|all tests pass|passing|0 failing/.test(output);
  const testScore = hasTestError ? 0 : hasTestSuccess ? 100 : 60;

  // Review score: error indicators (count-based)
  const errorIndicators = [
    "i cannot", "i can't", "permission denied", "error occurred",
    "failed to", "connection refused",
  ];
  const errorCount = errorIndicators.filter((p) => output.includes(p)).length;
  const reviewScore = Math.max(0, 100 - errorCount * 30);

  // Regression score
  const hasRegression = /regression|broke|broken|previously working/.test(output);
  const regressionScore = hasRegression ? 0 : 100;

  return Math.round(
    weights.buildStatus * buildScore +
    weights.testPassing * testScore +
    weights.reviewResult * reviewScore +
    weights.noRegression * regressionScore,
  );
}

// --- Change Magnitude ---

/**
 * Change magnitude [0, 100]. Log-scaled by tool type.
 * Write/FileWrite = 50 lines, Edit/FileEdit = 20 lines, Bash = 5 lines.
 * Returns 0 if no observable changes.
 */
export function computeChangeMagnitude(turn: TurnRecord): number {
  if (!turn.hadObservableChanges) return 0;
  let files = 0;
  let lines = 0;
  for (const tool of turn.toolCallsSummary ?? []) {
    if (tool === "Write" || tool === "FileWrite") {
      files++;
      lines += 50;
    } else if (tool === "Edit" || tool === "FileEdit") {
      files++;
      lines += 20;
    } else if (tool === "Bash") {
      lines += 5;
    }
  }
  const fileScore = Math.log2(1 + files) / Math.log2(21);
  const lineScore = Math.log2(1 + lines) / Math.log2(501);
  return Math.round(
    Math.max(0, Math.min(100, (0.4 * fileScore + 0.6 * lineScore) * 100)),
  );
}

// --- Convergence Detection ---

/**
 * Check convergence across three dimensions.
 *
 * v3 fixes:
 * 1. hasHadChanges guard: prevents pure-analysis-turn early convergence
 * 2. Quality gate: qualityScore >= 80 required for convergence
 * 3. maxRounds quality gate: low quality at max rounds -> max_rounds_low_quality
 */
export function checkConvergence(
  state: ConvergenceState,
  maxRounds: number = 5,
): ConvergenceResult {
  const { informationGains: ig, qualityScores: qs, changeMagnitudes: cm, round } = state;

  const infoGainConverged =
    ig.length >= 2 && ig.slice(-2).every((g) => g < 0.15);
  const qualityStable =
    qs.length >= 2 && Math.abs(qs[qs.length - 1] - qs[qs.length - 2]) < 8;
  const qualityAbove = qs.length >= 1 && qs[qs.length - 1] >= 80;
  const changesMinimal = cm.length >= 1 && cm[cm.length - 1] < 3;
  // hasHadChanges guard: at least 1 round had observable changes
  const hasHadChanges = cm.some((m) => m > 0);

  if (qualityAbove) {
    if (infoGainConverged && qualityStable) {
      return { converged: true, reason: "info_gain_stable" };
    }
    if (changesMinimal && qualityStable && hasHadChanges) {
      return { converged: true, reason: "changes_minimal" };
    }
  }

  // maxRounds quality gate
  if (round >= maxRounds) {
    if (qualityAbove) {
      return { converged: true, reason: "max_rounds" };
    }
    return {
      converged: true,
      reason: "max_rounds_low_quality",
      strategyHint: "pause",
    };
  }

  return { converged: false };
}

/**
 * Push new measurements into the convergence state and trim to window size.
 * Window size = min(5, maxRounds).
 */
export function updateConvergenceState(
  state: ConvergenceState,
  current: TurnRecord,
  prev: TurnRecord | undefined,
  scenario: ScenarioType,
  maxRounds: number = 5,
): void {
  const WINDOW = Math.min(5, maxRounds);
  state.informationGains.push(computeInformationGain(current, prev));
  state.qualityScores.push(computeQualityScore(current, scenario));
  state.changeMagnitudes.push(computeChangeMagnitude(current));
  state.round++;
  if (state.informationGains.length > WINDOW) state.informationGains.shift();
  if (state.qualityScores.length > WINDOW) state.qualityScores.shift();
  if (state.changeMagnitudes.length > WINDOW) state.changeMagnitudes.shift();
}
