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
}
