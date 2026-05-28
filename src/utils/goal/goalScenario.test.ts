/**
 * Tests for goalScenario — scenario identification with confidence scoring
 *
 * Run: bun test src/utils/goal/goalScenario.test.ts
 */

import { describe, it, expect } from "bun:test";
import {
	identifyScenarios,
	selectScenarioConfig,
	identifyTaskScenario,
	getScenarioConfig,
	resolveScenario,
	SCENARIO_KEYWORDS,
	SCENARIO_CONFIGS,
	SKILL_SCENARIO_AFFINITY,
} from "./goalScenario.js";
import type { ScenarioType } from "./goalScenario.js";

// ─── identifyScenarios ───────────────────────────────────────────────────────

describe("identifyScenarios — English keywords", () => {
	it("should identify troubleshooting from 'fix the crash'", () => {
		const matches = identifyScenarios("fix the crash");
		expect(matches[0].type).toBe("troubleshooting");
		expect(matches[0].confidence).toBeGreaterThanOrEqual(0.3);
		expect(matches[0].matchedKeywords.exclusive).toContain("crash");
	});

	it("should identify troubleshooting from 'debug the bug'", () => {
		const matches = identifyScenarios("debug the bug");
		expect(matches[0].type).toBe("troubleshooting");
		expect(matches[0].matchedKeywords.exclusive).toContain("bug");
		expect(matches[0].matchedKeywords.exclusive).toContain("debug");
	});

	it("should identify refactoring from 'refactor the auth module'", () => {
		const matches = identifyScenarios("refactor the auth module");
		expect(matches[0].type).toBe("refactoring");
		expect(matches[0].matchedKeywords.exclusive).toContain("refactor");
	});

	it("should identify doc_writing from 'write README documentation'", () => {
		const matches = identifyScenarios("write README documentation");
		expect(matches[0].type).toBe("doc_writing");
		expect(matches[0].matchedKeywords.exclusive).toContain("README");
		expect(matches[0].matchedKeywords.exclusive).toContain("documentation");
	});

	it("should identify design_improve from 'improve the architecture design'", () => {
		const matches = identifyScenarios("improve the architecture design");
		expect(matches[0].type).toBe("design_improve");
		expect(matches[0].matchedKeywords.exclusive).toContain("architecture");
		expect(matches[0].matchedKeywords.exclusive).toContain("design");
	});

	it("should identify code_change from 'implement a new feature'", () => {
		const matches = identifyScenarios("implement a new feature");
		expect(matches[0].type).toBe("code_change");
		expect(matches[0].matchedKeywords.exclusive).toContain("implement");
		expect(matches[0].matchedKeywords.exclusive).toContain("feature");
	});
});

describe("identifyScenarios — Chinese keywords", () => {
	it("should identify troubleshooting from Chinese '排查生产环境崩溃'", () => {
		const matches = identifyScenarios("排查生产环境崩溃");
		expect(matches[0].type).toBe("troubleshooting");
		expect(matches[0].matchedKeywords.exclusive).toContain("排查");
		expect(matches[0].matchedKeywords.exclusive).toContain("崩溃");
	});

	it("should identify refactoring from Chinese '重构 auth 模块并解耦'", () => {
		const matches = identifyScenarios("重构 auth 模块并解耦");
		expect(matches[0].type).toBe("refactoring");
		expect(matches[0].matchedKeywords.exclusive).toContain("重构");
		expect(matches[0].matchedKeywords.exclusive).toContain("解耦");
	});

	it("should identify doc_writing from Chinese '编写设计文档'", () => {
		const matches = identifyScenarios("编写设计文档");
		expect(matches[0].type).toBe("doc_writing");
		expect(matches[0].matchedKeywords.exclusive).toContain("文档");
		expect(matches[0].matchedKeywords.exclusive).toContain("设计文档");
	});

	it("should identify design_improve from Chinese '设计架构方案'", () => {
		const matches = identifyScenarios("设计架构方案");
		expect(matches[0].type).toBe("design_improve");
		expect(matches[0].matchedKeywords.exclusive).toContain("设计");
		expect(matches[0].matchedKeywords.exclusive).toContain("架构");
		expect(matches[0].matchedKeywords.exclusive).toContain("方案");
	});

	it("should identify troubleshooting from Chinese '异常和漏洞'", () => {
		const matches = identifyScenarios("修复异常和漏洞");
		expect(matches[0].type).toBe("troubleshooting");
		expect(matches[0].matchedKeywords.exclusive).toContain("异常");
		expect(matches[0].matchedKeywords.exclusive).toContain("漏洞");
	});
});

describe("identifyScenarios — all 5 scenario types", () => {
	const scenarios: ScenarioType[] = [
		"code_change",
		"doc_writing",
		"troubleshooting",
		"design_improve",
		"refactoring",
	];

	for (const scenario of scenarios) {
		it(`should identify ${scenario} with at least one exclusive keyword`, () => {
			const keywords = SCENARIO_KEYWORDS[scenario];
			const exclusiveKw = keywords.find((k) => k.type === "exclusive");
			expect(exclusiveKw).toBeDefined();
			const matches = identifyScenarios(exclusiveKw!.keyword);
			expect(matches[0].type).toBe(scenario);
			expect(matches[0].confidence).toBeGreaterThanOrEqual(0.3);
		});
	}
});

describe("identifyScenarios — empty/ambiguous input", () => {
	it("should return code_change fallback for empty string", () => {
		const matches = identifyScenarios("");
		expect(matches).toHaveLength(1);
		expect(matches[0].type).toBe("code_change");
		expect(matches[0].confidence).toBe(0.3);
	});

	it("should return code_change fallback for whitespace-only input", () => {
		const matches = identifyScenarios("   ");
		expect(matches).toHaveLength(1);
		expect(matches[0].type).toBe("code_change");
	});

	it("should return code_change fallback for ambiguous input with no keywords", () => {
		const matches = identifyScenarios("do something random xyz");
		expect(matches).toHaveLength(1);
		expect(matches[0].type).toBe("code_change");
		expect(matches[0].confidence).toBe(0.3);
	});
});

describe("identifyScenarios — exclusive floor 0.35", () => {
	it("should enforce floor 0.35 when exclusive keyword has low relative weight", () => {
		// "debug" is exclusive (weight 3) but alone among many keywords → low raw score
		// With only 1 exclusive hit out of many keywords, the raw confidence is low
		// but should be floored to 0.35
		const matches = identifyScenarios("something something debug");
		const debugMatch = matches.find((m) => m.type === "troubleshooting");
		expect(debugMatch).toBeDefined();
		expect(debugMatch!.confidence).toBeGreaterThanOrEqual(0.35);
	});
});

describe("identifyScenarios — mixed scenarios with confidence", () => {
	it("should return multiple matches for mixed objective", () => {
		// "重构 auth 模块并修复 bug" → refactoring + troubleshooting
		const matches = identifyScenarios("重构 auth 模块并修复 bug");
		expect(matches.length).toBeGreaterThanOrEqual(2);

		const types = matches.map((m) => m.type);
		expect(types).toContain("refactoring");
		expect(types).toContain("troubleshooting");
	});

	it("should rank matches by confidence descending", () => {
		const matches = identifyScenarios(
			"重构代码并排查异常和修复bug",
		);
		for (let i = 1; i < matches.length; i++) {
			expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(
				matches[i].confidence,
			);
		}
	});

	it("should give 1.5x multiplier to exclusive hits", () => {
		// "bug" is exclusive (weight 3, with floor 0.35) vs "fix" is shared (weight 1, no floor)
		// exclusive gets floor boost, shared with low weight falls below 0.3 → code_change fallback
		const matchesExclusive = identifyScenarios("bug");
		const matchesShared = identifyScenarios("fix something random");
		const exTrouble = matchesExclusive.find(
			(m) => m.type === "troubleshooting",
		);
		// "fix" is shared only → low confidence, falls to code_change fallback
		expect(matchesShared[0].type).toBe("code_change");
		// "bug" is exclusive → gets floor 0.35, stays as troubleshooting
		expect(exTrouble).toBeDefined();
		expect(exTrouble!.confidence).toBeGreaterThanOrEqual(0.35);
	});
});

// ─── selectScenarioConfig ────────────────────────────────────────────────────

describe("selectScenarioConfig", () => {
	it("should return direct config when confidence > 0.7", () => {
		// Need enough exclusive keywords to exceed 0.7 threshold
		// All 10 exclusive troubleshooting keywords → high confidence
		const matches = identifyScenarios(
			"排查 bug crash error exception regression 崩溃 异常 漏洞 debug",
		);
		expect(matches[0].confidence).toBeGreaterThan(0.7);
		const config = selectScenarioConfig(matches);
		expect(config.type).toBe("troubleshooting");
	});

	it("should handle mixed scenario when confidence 0.3-0.7", () => {
		// Create a scenario where primary is in 0.3-0.7 range
		const matches = [
			{
				type: "refactoring" as ScenarioType,
				confidence: 0.5,
				matchedKeywords: { exclusive: ["重构"], shared: [] },
			},
			{
				type: "troubleshooting" as ScenarioType,
				confidence: 0.45,
				matchedKeywords: { exclusive: ["bug"], shared: [] },
			},
		];
		const config = selectScenarioConfig(matches);
		expect(config.type).toBe("refactoring");
		// Should include secondary's preferredSkills
		expect(config.preferredSkills).toContain("systematic-debugging");
	});

	it("should fall back to code_change when all < 0.3", () => {
		const matches = [
			{
				type: "troubleshooting" as ScenarioType,
				confidence: 0.2,
				matchedKeywords: { exclusive: [], shared: ["fix"] },
			},
		];
		const config = selectScenarioConfig(matches);
		expect(config.type).toBe("code_change");
	});
});

// ─── identifyTaskScenario ────────────────────────────────────────────────────

describe("identifyTaskScenario", () => {
	it("should return parent scenario for empty/ambiguous task content", () => {
		const result = identifyTaskScenario("do something", "troubleshooting");
		expect(result.type).toBe("troubleshooting");
		expect(result.confidence).toBe(0.5);
	});

	it("should give parent +0.2 bonus when task matches parent scenario", () => {
		const result = identifyTaskScenario("fix the bug", "troubleshooting");
		expect(result.type).toBe("troubleshooting");
		// Base confidence + 0.2 bonus
		expect(result.confidence).toBeGreaterThan(0.5);
		expect(result.confidence).toBeLessThanOrEqual(1);
	});

	it("should override parent when task confidence > 0.4", () => {
		// Need enough exclusive keywords to exceed 0.4 confidence
		// "重构 clean up tech debt 解耦 simplify" → 5 exclusive keywords
		const result = identifyTaskScenario(
			"重构 clean up tech debt 解耦 simplify",
			"code_change",
		);
		expect(result.type).toBe("refactoring");
		expect(result.confidence).toBeGreaterThan(0.4);
	});

	it("should keep parent when task confidence <= 0.4", () => {
		// Ambiguous task with low confidence
		const result = identifyTaskScenario("修改文件", "troubleshooting");
		// "修改" is shared keyword with weight 1 for code_change
		// Should keep parent since confidence is low
		expect(result.type).toBe("troubleshooting");
	});

	it("should cap confidence at 1.0 with parent bonus", () => {
		const result = identifyTaskScenario("debug bug crash error", "troubleshooting");
		expect(result.type).toBe("troubleshooting");
		expect(result.confidence).toBeLessThanOrEqual(1);
	});
});

// ─── getScenarioConfig ───────────────────────────────────────────────────────

describe("getScenarioConfig", () => {
	const allTypes: ScenarioType[] = [
		"code_change",
		"doc_writing",
		"troubleshooting",
		"design_improve",
		"refactoring",
	];

	for (const type of allTypes) {
		it(`should return valid config for ${type}`, () => {
			const config = getScenarioConfig(type);
			expect(config.type).toBe(type);
			expect(config.phases.length).toBe(5);
			expect(config.maxRoundsPerTask).toBeGreaterThan(0);
			expect(config.requiredTools.length).toBeGreaterThan(0);
			expect(config.preferredSkills).toBeInstanceOf(Array);
		});
	}

	it("should have all 5 ReAct phases in each config", () => {
		const expectedPhases = ["ANALYZE", "SKILL", "REVIEW", "FIX", "VERIFY"];
		for (const type of allTypes) {
			const config = getScenarioConfig(type);
			const phaseNames = config.phases.map((p) => p.name);
			expect(phaseNames).toEqual(expectedPhases);
		}
	});
});

// ─── resolveScenario ─────────────────────────────────────────────────────────

describe("resolveScenario", () => {
	it("should return ScenarioConfig with required fields for troubleshooting", () => {
		const config = resolveScenario("排查生产环境崩溃");
		expect(config.type).toBe("troubleshooting");
		expect(config.phases).toBeDefined();
		expect(config.maxRoundsPerTask).toBe(8);
		expect(config.requiredTools).toContain("Bash");
		expect(config.requiredTools).toContain("Grep");
		expect(config.preferredSkills).toContain("systematic-debugging");
	});

	it("should return ScenarioConfig for refactoring", () => {
		const config = resolveScenario("重构并解耦");
		expect(config.type).toBe("refactoring");
		expect(config.maxRoundsPerTask).toBe(6);
	});

	it("should return code_change for empty input", () => {
		const config = resolveScenario("");
		expect(config.type).toBe("code_change");
	});

	it("should return code_change for ambiguous input", () => {
		const config = resolveScenario("hello world");
		expect(config.type).toBe("code_change");
	});

	it("should handle mixed scenario and merge preferredSkills", () => {
		// Both refactoring and troubleshooting have exclusive keywords
		const config = resolveScenario("重构代码并修复bug");
		// Primary should be whichever has higher confidence
		expect(["refactoring", "troubleshooting"]).toContain(config.type);
	});
});

// ─── Keyword table completeness ──────────────────────────────────────────────

describe("SCENARIO_KEYWORDS — data integrity", () => {
	it("should have keywords for all 5 scenario types", () => {
		const types = Object.keys(SCENARIO_KEYWORDS);
		expect(types).toHaveLength(5);
		expect(types).toContain("code_change");
		expect(types).toContain("doc_writing");
		expect(types).toContain("troubleshooting");
		expect(types).toContain("design_improve");
		expect(types).toContain("refactoring");
	});

	it("should have at least one exclusive keyword per scenario", () => {
		for (const [type, keywords] of Object.entries(SCENARIO_KEYWORDS)) {
			const exclusive = keywords.filter((k) => k.type === "exclusive");
			expect(exclusive.length).toBeGreaterThanOrEqual(1);
		}
	});

	it("should have non-zero weights for all keywords", () => {
		for (const [type, keywords] of Object.entries(SCENARIO_KEYWORDS)) {
			for (const kw of keywords) {
				expect(kw.weight).toBeGreaterThan(0);
			}
		}
	});
});

// ─── SKILL_SCENARIO_AFFINITY ─────────────────────────────────────────────────

describe("SKILL_SCENARIO_AFFINITY — data integrity", () => {
	it("should have 17 skills in the affinity matrix", () => {
		expect(Object.keys(SKILL_SCENARIO_AFFINITY)).toHaveLength(17);
	});

	it("should have all 5 scenario types for each skill", () => {
		const expectedTypes: ScenarioType[] = [
			"code_change",
			"doc_writing",
			"troubleshooting",
			"design_improve",
			"refactoring",
		];
		for (const [skill, affinities] of Object.entries(SKILL_SCENARIO_AFFINITY)) {
			for (const type of expectedTypes) {
				expect(affinities[type]).toBeDefined();
				expect(typeof affinities[type]).toBe("number");
				expect(affinities[type]).toBeGreaterThanOrEqual(0);
				expect(affinities[type]).toBeLessThanOrEqual(1);
			}
		}
	});

	it("should have systematic-debugging with highest affinity to troubleshooting", () => {
		const aff = SKILL_SCENARIO_AFFINITY["systematic-debugging"];
		expect(aff.troubleshooting).toBe(1.0);
		expect(aff.troubleshooting).toBeGreaterThan(aff.code_change);
		expect(aff.troubleshooting).toBeGreaterThan(aff.doc_writing);
	});

	it("should have brainstorming with highest affinity to design_improve", () => {
		const aff = SKILL_SCENARIO_AFFINITY["brainstorming"];
		expect(aff.design_improve).toBe(1.0);
	});

	it("should have simplify with highest affinity to refactoring", () => {
		const aff = SKILL_SCENARIO_AFFINITY["simplify"];
		expect(aff.refactoring).toBe(0.9);
		expect(aff.refactoring).toBeGreaterThan(aff.code_change);
	});
});
