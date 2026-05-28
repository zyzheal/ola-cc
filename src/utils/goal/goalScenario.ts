/**
 * Goal Scenario Identification Module
 *
 * Identifies which scenario type a goal belongs to (code_change, doc_writing,
 * troubleshooting, design_improve, refactoring) based on keyword matching
 * with confidence scoring.
 *
 * Design spec: docs/superpowers/specs/2026-05-28-goal-react-orchestrator-design.md §4.3
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ScenarioType =
	| "code_change"
	| "doc_writing"
	| "troubleshooting"
	| "design_improve"
	| "refactoring";

export interface PhaseConfig {
	name: "ANALYZE" | "SKILL" | "REVIEW" | "FIX" | "VERIFY";
	weight: number;
	required: boolean;
	preferredSkills: string[];
}

export interface ScenarioConfig {
	type: ScenarioType;
	phases: PhaseConfig[];
	maxRoundsPerTask: number;
	convergenceThreshold: number;
	requiredTools: string[];
	preferredSkills: string[];
	skillAffinity: Record<string, number>;
	circuitBreaker: { maxRounds: number; timeoutMs: number };
}

export interface KeywordEntry {
	keyword: string;
	weight: number;
	type: "exclusive" | "shared";
}

export interface ScenarioMatch {
	type: ScenarioType;
	confidence: number;
	matchedKeywords: { exclusive: string[]; shared: string[] };
}

// ─── Keyword Table ───────────────────────────────────────────────────────────

export const SCENARIO_KEYWORDS: Record<ScenarioType, KeywordEntry[]> = {
	troubleshooting: [
		// Exclusive (weight 3)
		{ keyword: "bug", weight: 3, type: "exclusive" },
		{ keyword: "crash", weight: 3, type: "exclusive" },
		{ keyword: "error", weight: 3, type: "exclusive" },
		{ keyword: "exception", weight: 3, type: "exclusive" },
		{ keyword: "regression", weight: 3, type: "exclusive" },
		{ keyword: "排查", weight: 3, type: "exclusive" },
		{ keyword: "漏洞", weight: 3, type: "exclusive" },
		{ keyword: "异常", weight: 3, type: "exclusive" },
		{ keyword: "崩溃", weight: 3, type: "exclusive" },
		{ keyword: "debug", weight: 3, type: "exclusive" },
		// Shared (weight 1)
		{ keyword: "fix", weight: 1, type: "shared" },
		{ keyword: "修复", weight: 1, type: "shared" },
		{ keyword: "问题", weight: 1, type: "shared" },
		{ keyword: "issue", weight: 1, type: "shared" },
	],
	doc_writing: [
		{ keyword: "README", weight: 3, type: "exclusive" },
		{ keyword: "documentation", weight: 3, type: "exclusive" },
		{ keyword: "文档", weight: 3, type: "exclusive" },
		{ keyword: "guide", weight: 3, type: "exclusive" },
		{ keyword: "设计文档", weight: 3, type: "exclusive" },
		{ keyword: "design doc", weight: 3, type: "exclusive" },
		{ keyword: "spec", weight: 2, type: "exclusive" },
		{ keyword: "写", weight: 1, type: "shared" },
		{ keyword: "编写", weight: 1, type: "shared" },
	],
	refactoring: [
		{ keyword: "重构", weight: 3, type: "exclusive" },
		{ keyword: "refactor", weight: 3, type: "exclusive" },
		{ keyword: "clean up", weight: 3, type: "exclusive" },
		{ keyword: "tech debt", weight: 3, type: "exclusive" },
		{ keyword: "解耦", weight: 3, type: "exclusive" },
		{ keyword: "simplify", weight: 2, type: "exclusive" },
		{ keyword: "优化", weight: 1, type: "shared" },
		{ keyword: "optimize", weight: 1, type: "shared" },
	],
	design_improve: [
		{ keyword: "设计", weight: 3, type: "exclusive" },
		{ keyword: "design", weight: 3, type: "exclusive" },
		{ keyword: "architecture", weight: 3, type: "exclusive" },
		{ keyword: "架构", weight: 3, type: "exclusive" },
		{ keyword: "方案", weight: 3, type: "exclusive" },
		{ keyword: "trade-off", weight: 3, type: "exclusive" },
		{ keyword: "改进", weight: 1, type: "shared" },
		{ keyword: "完善", weight: 1, type: "shared" },
	],
	code_change: [
		{ keyword: "实现", weight: 2, type: "exclusive" },
		{ keyword: "implement", weight: 2, type: "exclusive" },
		{ keyword: "添加", weight: 2, type: "exclusive" },
		{ keyword: "feature", weight: 2, type: "exclusive" },
		{ keyword: "修改", weight: 1, type: "shared" },
		{ keyword: "change", weight: 1, type: "shared" },
	],
};

// ─── Scenario Configs ────────────────────────────────────────────────────────

export const SCENARIO_CONFIGS: Record<ScenarioType, ScenarioConfig> = {
	code_change: {
		type: "code_change",
		phases: [
			{ name: "ANALYZE", weight: 0.8, required: true, preferredSkills: [] },
			{ name: "SKILL", weight: 0.6, required: false, preferredSkills: [] },
			{ name: "REVIEW", weight: 0.7, required: true, preferredSkills: [] },
			{ name: "FIX", weight: 0.9, required: true, preferredSkills: [] },
			{ name: "VERIFY", weight: 0.9, required: true, preferredSkills: [] },
		],
		maxRoundsPerTask: 5,
		convergenceThreshold: 5,
		requiredTools: ["Bash", "Edit", "Read"],
		preferredSkills: [
			"test-driven-development",
			"verification-before-completion",
		],
		skillAffinity: {},
		circuitBreaker: { maxRounds: 5, timeoutMs: 20 * 60 * 1000 },
	},
	doc_writing: {
		type: "doc_writing",
		phases: [
			{ name: "ANALYZE", weight: 0.5, required: true, preferredSkills: [] },
			{
				name: "SKILL",
				weight: 0.7,
				required: false,
				preferredSkills: ["brainstorming"],
			},
			{
				name: "REVIEW",
				weight: 0.9,
				required: true,
				preferredSkills: ["design-doc-reviewer"],
			},
			{ name: "FIX", weight: 0.8, required: true, preferredSkills: [] },
			{ name: "VERIFY", weight: 0.4, required: false, preferredSkills: [] },
		],
		maxRoundsPerTask: 3,
		convergenceThreshold: 3,
		requiredTools: ["Read", "Write"],
		preferredSkills: [
			"brainstorming",
			"design-doc-reviewer",
			"docs-navigator",
		],
		skillAffinity: {},
		circuitBreaker: { maxRounds: 3, timeoutMs: 15 * 60 * 1000 },
	},
	troubleshooting: {
		type: "troubleshooting",
		phases: [
			{
				name: "ANALYZE",
				weight: 1.0,
				required: true,
				preferredSkills: ["systematic-debugging"],
			},
			{
				name: "SKILL",
				weight: 0.8,
				required: true,
				preferredSkills: ["systematic-debugging"],
			},
			{ name: "REVIEW", weight: 0.6, required: false, preferredSkills: [] },
			{ name: "FIX", weight: 0.9, required: true, preferredSkills: [] },
			{ name: "VERIFY", weight: 0.9, required: true, preferredSkills: [] },
		],
		maxRoundsPerTask: 8,
		convergenceThreshold: 8,
		requiredTools: ["Bash", "Read", "Grep"],
		preferredSkills: ["systematic-debugging", "orion-deep-audit"],
		skillAffinity: {},
		circuitBreaker: { maxRounds: 8, timeoutMs: 45 * 60 * 1000 },
	},
	design_improve: {
		type: "design_improve",
		phases: [
			{ name: "ANALYZE", weight: 0.9, required: true, preferredSkills: [] },
			{
				name: "SKILL",
				weight: 0.9,
				required: true,
				preferredSkills: ["brainstorming"],
			},
			{
				name: "REVIEW",
				weight: 0.8,
				required: true,
				preferredSkills: ["code-design-analyzer"],
			},
			{ name: "FIX", weight: 0.7, required: true, preferredSkills: [] },
			{ name: "VERIFY", weight: 0.5, required: false, preferredSkills: [] },
		],
		maxRoundsPerTask: 5,
		convergenceThreshold: 5,
		requiredTools: ["Read", "Write"],
		preferredSkills: [
			"brainstorming",
			"design-constraint",
			"design-doc-reviewer",
			"code-design-analyzer",
		],
		skillAffinity: {},
		circuitBreaker: { maxRounds: 5, timeoutMs: 25 * 60 * 1000 },
	},
	refactoring: {
		type: "refactoring",
		phases: [
			{
				name: "ANALYZE",
				weight: 1.0,
				required: true,
				preferredSkills: ["code-design-analyzer"],
			},
			{ name: "SKILL", weight: 0.7, required: false, preferredSkills: [] },
			{
				name: "REVIEW",
				weight: 0.9,
				required: true,
				preferredSkills: ["code-design-analyzer"],
			},
			{ name: "FIX", weight: 0.8, required: true, preferredSkills: [] },
			{ name: "VERIFY", weight: 1.0, required: true, preferredSkills: [] },
		],
		maxRoundsPerTask: 6,
		convergenceThreshold: 6,
		requiredTools: ["Bash", "Edit", "Read", "Grep"],
		preferredSkills: [
			"simplify",
			"code-design-analyzer",
			"design-constraint",
		],
		skillAffinity: {},
		circuitBreaker: { maxRounds: 6, timeoutMs: 30 * 60 * 1000 },
	},
};

// ─── Skill-Scenario Affinity Matrix ──────────────────────────────────────────

export const SKILL_SCENARIO_AFFINITY: Record<
	string,
	Record<ScenarioType, number>
> = {
	// Superpowers
	"systematic-debugging": {
		code_change: 0.3,
		doc_writing: 0.0,
		troubleshooting: 1.0,
		design_improve: 0.1,
		refactoring: 0.3,
	},
	brainstorming: {
		code_change: 0.4,
		doc_writing: 0.3,
		troubleshooting: 0.1,
		design_improve: 1.0,
		refactoring: 0.2,
	},
	"test-driven-development": {
		code_change: 0.9,
		doc_writing: 0.0,
		troubleshooting: 0.5,
		design_improve: 0.1,
		refactoring: 0.8,
	},
	"verification-before-completion": {
		code_change: 0.8,
		doc_writing: 0.4,
		troubleshooting: 0.6,
		design_improve: 0.3,
		refactoring: 0.8,
	},
	"requesting-code-review": {
		code_change: 0.7,
		doc_writing: 0.3,
		troubleshooting: 0.4,
		design_improve: 0.4,
		refactoring: 0.7,
	},
	"writing-plans": {
		code_change: 0.5,
		doc_writing: 0.5,
		troubleshooting: 0.2,
		design_improve: 0.8,
		refactoring: 0.6,
	},
	"executing-plans": {
		code_change: 0.7,
		doc_writing: 0.3,
		troubleshooting: 0.2,
		design_improve: 0.4,
		refactoring: 0.6,
	},
	// Design
	"design-constraint": {
		code_change: 0.5,
		doc_writing: 0.2,
		troubleshooting: 0.2,
		design_improve: 0.9,
		refactoring: 0.7,
	},
	"design-doc-reviewer": {
		code_change: 0.2,
		doc_writing: 0.8,
		troubleshooting: 0.1,
		design_improve: 0.9,
		refactoring: 0.3,
	},
	"code-design-analyzer": {
		code_change: 0.4,
		doc_writing: 0.1,
		troubleshooting: 0.5,
		design_improve: 0.8,
		refactoring: 0.8,
	},
	"task-decomposer": {
		code_change: 0.6,
		doc_writing: 0.3,
		troubleshooting: 0.3,
		design_improve: 0.7,
		refactoring: 0.5,
	},
	// Orion
	"orion-deep-audit": {
		code_change: 0.5,
		doc_writing: 0.0,
		troubleshooting: 0.8,
		design_improve: 0.4,
		refactoring: 0.7,
	},
	"orion-repairing": {
		code_change: 0.5,
		doc_writing: 0.0,
		troubleshooting: 0.7,
		design_improve: 0.1,
		refactoring: 0.4,
	},
	"orion-reviewing": {
		code_change: 0.6,
		doc_writing: 0.2,
		troubleshooting: 0.4,
		design_improve: 0.4,
		refactoring: 0.6,
	},
	// Feature Dev
	"feature-dev:feature-dev": {
		code_change: 0.9,
		doc_writing: 0.1,
		troubleshooting: 0.2,
		design_improve: 0.4,
		refactoring: 0.4,
	},
	// Other
	simplify: {
		code_change: 0.3,
		doc_writing: 0.0,
		troubleshooting: 0.2,
		design_improve: 0.2,
		refactoring: 0.9,
	},
	"docs-navigator": {
		code_change: 0.1,
		doc_writing: 0.7,
		troubleshooting: 0.0,
		design_improve: 0.4,
		refactoring: 0.1,
	},
};

// ─── Core Functions ──────────────────────────────────────────────────────────

/**
 * Identify scenarios from an objective string using keyword matching
 * with confidence scoring.
 *
 * Confidence calculation:
 *   confidence = min(1, matchedScore / maxPossibleScore)
 *   exclusive hits get 1.5x multiplier on effective score
 *   exclusive floor confidence = 0.35
 *   all scenarios < 0.3 confidence → code_change fallback
 */
export function identifyScenarios(objective: string): ScenarioMatch[] {
	const input = objective.toLowerCase().trim();
	const results: ScenarioMatch[] = [];

	for (const [scenarioType, keywords] of Object.entries(SCENARIO_KEYWORDS)) {
		const matchedExclusive: string[] = [];
		const matchedShared: string[] = [];
		let matchedScore = 0;
		let maxPossibleScore = 0;

		for (const kw of keywords) {
			maxPossibleScore += kw.weight;
			if (input.includes(kw.keyword.toLowerCase())) {
				matchedScore += kw.weight;
				if (kw.type === "exclusive") matchedExclusive.push(kw.keyword);
				else matchedShared.push(kw.keyword);
			}
		}

		const hasExclusive = matchedExclusive.length > 0;
		const effectiveScore = hasExclusive ? matchedScore * 1.5 : matchedScore;
		const effectiveMax = hasExclusive ? maxPossibleScore * 1.5 : maxPossibleScore;
		let confidence =
			effectiveMax > 0 ? Math.min(1, effectiveScore / effectiveMax) : 0;
		// Exclusive floor (v3: 0.35, lowered from 0.5)
		if (hasExclusive && confidence < 0.35) confidence = 0.35;

		if (confidence > 0) {
			results.push({
				type: scenarioType as ScenarioType,
				confidence: Math.round(confidence * 1000) / 1000,
				matchedKeywords: { exclusive: matchedExclusive, shared: matchedShared },
			});
		}
	}

	results.sort((a, b) => b.confidence - a.confidence);

	if (results.length === 0 || results[0].confidence < 0.3) {
		return [
			{
				type: "code_change",
				confidence: 0.3,
				matchedKeywords: { exclusive: [], shared: [] },
			},
		];
	}
	return results;
}

/**
 * Select the best scenario config from identified matches.
 *
 * - confidence > 0.7 → direct use of that scenario
 * - 0.3 <= confidence <= 0.7 → primary + inject secondary preferredSkills
 * - < 0.3 → code_change fallback
 */
export function selectScenarioConfig(matches: ScenarioMatch[]): ScenarioConfig {
	const primary = matches[0];
	if (primary.confidence > 0.7) return getScenarioConfig(primary.type);

	if (primary.confidence >= 0.3) {
		const base = getScenarioConfig(primary.type);
		const secondaries = matches.filter(
			(m, i) =>
				i > 0 &&
				m.confidence >= 0.3 &&
				m.confidence >= primary.confidence * 0.6,
		);
		if (secondaries.length > 0) {
			const extraSkills = secondaries.flatMap(
				(m) => getScenarioConfig(m.type).preferredSkills,
			);
			return {
				...base,
				preferredSkills: [
					...new Set([...base.preferredSkills, ...extraSkills]),
				],
				maxRoundsPerTask: Math.max(
					base.maxRoundsPerTask,
					...secondaries.map(
						(m) => getScenarioConfig(m.type).maxRoundsPerTask,
					),
				),
			};
		}
		return base;
	}
	return getScenarioConfig("code_change");
}

/**
 * Task-level scenario identification. Parent scenario provides a prior (+0.2 bonus).
 * Child task confidence > 0.4 can override parent scenario.
 */
export function identifyTaskScenario(
	taskContent: string,
	parentScenario: ScenarioType,
): ScenarioMatch {
	const matches = identifyScenarios(taskContent);
	if (
		matches.length === 0 ||
		(matches[0].type === "code_change" && matches[0].confidence === 0.3)
	) {
		return {
			type: parentScenario,
			confidence: 0.5,
			matchedKeywords: { exclusive: [], shared: [] },
		};
	}
	const primary = matches[0];
	if (primary.type === parentScenario) {
		return {
			...primary,
			confidence: Math.min(1, primary.confidence + 0.2),
		};
	}
	if (primary.confidence > 0.4) return primary;
	return {
		type: parentScenario,
		confidence: 0.4,
		matchedKeywords: primary.matchedKeywords,
	};
}

/** Look up a scenario config by type. */
export function getScenarioConfig(type: ScenarioType): ScenarioConfig {
	return SCENARIO_CONFIGS[type];
}

/** Main entry point: resolve an objective string to a ScenarioConfig. */
export function resolveScenario(objective: string): ScenarioConfig {
	return selectScenarioConfig(identifyScenarios(objective));
}
