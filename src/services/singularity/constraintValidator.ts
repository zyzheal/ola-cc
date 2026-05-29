import { execSync } from 'node:child_process'
import type { DiverseStrategy } from './EvolutionEngine'

// EVOLUTION.* 结构化日志
const logger = {
  info: (meta: Record<string, unknown>, msg: string) => {
    if (process.env.OLA_CC_DEBUG_EVOLUTION === 'true') {
      console.log(`[EVOLUTION] ${msg}`, JSON.stringify(meta))
    }
  },
  warn: (meta: Record<string, unknown>, msg: string) => {
    console.warn(`[EVOLUTION] ${msg}`, JSON.stringify(meta))
  },
  error: (meta: Record<string, unknown>, msg: string) => {
    console.error(`[EVOLUTION] ${msg}`, JSON.stringify(meta))
  },
}

/** 额外验证选项，保持 validateAll 向后兼容 */
export interface ValidateOptions {
  /** SurgicalPatch 策略，与 totalLines 一起使用 */
  strategy?: DiverseStrategy
  /** 当前文件总行数，与 strategy 一起使用 */
  totalLines?: number
  /** 项目根目录，提供时运行 bun test 门控 */
  projectRoot?: string
}

export interface ConstraintResult {
  passed: boolean
  constraintName: string
  message: string
  details?: string
}

export interface ConstraintConfig {
  maxSkillSize: number
  maxToolDescSize: number
  maxPromptGrowth: number
  maxAbsoluteLines: number
  maxChangeRatio: number
}

const DEFAULT_CONSTRAINT_CONFIG: ConstraintConfig = {
  maxSkillSize: 15000,
  maxToolDescSize: 500,
  maxPromptGrowth: 0.2,
  maxAbsoluteLines: 30,
  maxChangeRatio: 0.15,
}

function getConfig(overrides?: Partial<ConstraintConfig>): ConstraintConfig {
  return {
    maxSkillSize:
      parseInt(process.env.CONSTRAINT_MAX_SKILL_SIZE ?? '') ||
      overrides?.maxSkillSize ||
      DEFAULT_CONSTRAINT_CONFIG.maxSkillSize,
    maxToolDescSize:
      parseInt(process.env.CONSTRAINT_MAX_TOOL_DESC ?? '') ||
      overrides?.maxToolDescSize ||
      DEFAULT_CONSTRAINT_CONFIG.maxToolDescSize,
    maxPromptGrowth:
      parseFloat(process.env.CONSTRAINT_MAX_GROWTH ?? '') ||
      overrides?.maxPromptGrowth ||
      DEFAULT_CONSTRAINT_CONFIG.maxPromptGrowth,
    maxAbsoluteLines:
      parseInt(process.env.CONSTRAINT_MAX_LINES ?? '') ||
      overrides?.maxAbsoluteLines ||
      DEFAULT_CONSTRAINT_CONFIG.maxAbsoluteLines,
    maxChangeRatio:
      parseFloat(process.env.CONSTRAINT_MAX_RATIO ?? '') ||
      overrides?.maxChangeRatio ||
      DEFAULT_CONSTRAINT_CONFIG.maxChangeRatio,
  }
}

export class ConstraintValidator {
  async validateAll(
    artifactText: string,
    artifactType: 'skill' | 'tool' | 'prompt',
    baselineText?: string,
    configOverrides?: Partial<ConstraintConfig>,
    options?: ValidateOptions,
  ): Promise<ConstraintResult[]> {
    if (process.env.OLA_CC_DISABLE_CONSTRAINT_VALIDATOR === 'true') {
      return [
        {
          passed: true,
          constraintName: 'disabled',
          message: 'ConstraintValidator disabled via env',
        },
      ]
    }

    const config = getConfig(configOverrides)
    const results: ConstraintResult[] = []

    const nonEmpty = this.checkNonEmpty(artifactText)
    results.push(nonEmpty)

    const sizeResult = this.checkSize(artifactText, artifactType, config)
    results.push(sizeResult)
    if (!sizeResult.passed) {
      logger.info(
        { code: 'EVOLUTION.CONSTRAINT.SIZE_EXCEEDED', artifactType, details: sizeResult.details },
        `Constraint failed: ${sizeResult.message}`,
      )
    }

    if (baselineText) {
      const growthResult = this.checkGrowth(artifactText, baselineText, config)
      results.push(growthResult)
      if (!growthResult.passed) {
        logger.info(
          { code: 'EVOLUTION.CONSTRAINT.GROWTH_EXCEEDED', details: growthResult.details },
          `Constraint failed: ${growthResult.message}`,
        )
      }
    }

    if (artifactType === 'skill') {
      const structureResult = this.checkSkillStructure(artifactText)
      results.push(structureResult)
      if (!structureResult.passed) {
        logger.info(
          { code: 'EVOLUTION.CONSTRAINT.INVALID_STRUCTURE', artifactType },
          `Constraint failed: ${structureResult.message}`,
        )
      }
    }

    // 5. SurgicalPatch 约束（仅在提供 strategy + totalLines 时执行）
    if (options?.strategy && options?.totalLines != null) {
      const surgicalResult = this.checkSurgicalPatch(options.strategy, options.totalLines, config)
      results.push(surgicalResult)
      if (!surgicalResult.passed) {
        logger.info(
          { code: 'EVOLUTION.CONSTRAINT.SURGICAL_PATCH_EXCEEDED', details: surgicalResult.details },
          `Constraint failed: ${surgicalResult.message}`,
        )
      }
    }

    // 6. 测试套件门控（仅在提供 projectRoot 时执行）
    if (options?.projectRoot) {
      const testResult = await this.runTestSuite(options.projectRoot)
      results.push(testResult)
      if (!testResult.passed) {
        logger.info(
          { code: 'EVOLUTION.CONSTRAINT.TEST_SUITE_FAILED', details: testResult.details },
          `Constraint failed: ${testResult.message}`,
        )
      }
    }

    return results
  }

  private checkNonEmpty(text: string): ConstraintResult {
    const passed = text.trim().length > 0
    return {
      passed,
      constraintName: 'non_empty',
      message: passed ? 'Artifact is non-empty' : 'Artifact is empty',
    }
  }

  private checkSize(
    text: string,
    type: string,
    config: ConstraintConfig,
  ): ConstraintResult {
    const limit = type === 'tool' ? config.maxToolDescSize : config.maxSkillSize
    const size = text.length
    const passed = size <= limit
    return {
      passed,
      constraintName: 'size_limit',
      message: passed
        ? `Size ${size} within limit ${limit}`
        : `Size ${size} exceeds limit ${limit}`,
      details: `${size}/${limit} characters`,
    }
  }

  private checkGrowth(
    text: string,
    baseline: string,
    config: ConstraintConfig,
  ): ConstraintResult {
    const baselineSize = baseline.length
    const currentSize = text.length
    if (baselineSize === 0) {
      return {
        passed: true,
        constraintName: 'growth_limit',
        message: 'No baseline for comparison',
      }
    }
    const growth = (currentSize - baselineSize) / baselineSize
    const passed = growth <= config.maxPromptGrowth
    return {
      passed,
      constraintName: 'growth_limit',
      message: passed
        ? `Growth ${(growth * 100).toFixed(1)}% within limit ${config.maxPromptGrowth * 100}%`
        : `Growth ${(growth * 100).toFixed(1)}% exceeds limit ${config.maxPromptGrowth * 100}%`,
      details: `${baselineSize} → ${currentSize} (${(growth * 100).toFixed(1)}%)`,
    }
  }

  private checkSkillStructure(text: string): ConstraintResult {
    const hasFrontmatter =
      /^---\s*\n/.test(text) &&
      /\nname:\s*\S/.test(text) &&
      /\ndescription:\s*\S/.test(text)
    return {
      passed: hasFrontmatter,
      constraintName: 'skill_structure',
      message: hasFrontmatter
        ? 'Skill has valid frontmatter (name + description)'
        : 'Skill missing YAML frontmatter with name and description',
    }
  }

  /**
   * 5. SurgicalPatch 约束
   * 检查策略的预估改动行数是否在允许范围内：
   *   estimatedLines <= min(totalLines * maxChangeRatio, maxAbsoluteLines)
   */
  private checkSurgicalPatch(
    strategy: DiverseStrategy,
    totalLines: number,
    config: ConstraintConfig,
  ): ConstraintResult {
    const maxByRatio = Math.floor(totalLines * config.maxChangeRatio)
    const limit = Math.min(maxByRatio, config.maxAbsoluteLines)
    const estimated = strategy.estimatedLines
    const passed = estimated <= limit
    return {
      passed,
      constraintName: 'surgical_patch',
      message: passed
        ? `Estimated ${estimated} lines within limit ${limit}`
        : `Estimated ${estimated} lines exceeds limit ${limit}`,
      details: `estimatedLines=${estimated}, limit=min(${totalLines}*${config.maxChangeRatio}=${maxByRatio}, ${config.maxAbsoluteLines})=${limit}`,
    }
  }

  /**
   * 6. 测试套件门控
   * 运行 `bun test` 并检查 100% 通过，超时 300 秒
   */
  private async runTestSuite(projectRoot: string): Promise<ConstraintResult> {
    try {
      const output = execSync('bun test', {
        cwd: projectRoot,
        timeout: 300_000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return {
        passed: true,
        constraintName: 'test_suite',
        message: 'All tests passed',
        details: output.slice(-500), // 保留最后 500 字符作为证据
      }
    } catch (error: unknown) {
      const err = error as { stderr?: string; stdout?: string; message?: string }
      const details = err.stderr || err.stdout || err.message || 'Unknown test failure'
      return {
        passed: false,
        constraintName: 'test_suite',
        message: 'Test suite failed',
        details: details.slice(-500),
      }
    }
  }
}
