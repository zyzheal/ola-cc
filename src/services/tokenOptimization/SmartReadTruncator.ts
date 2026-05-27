/**
 * Smart Read Truncation
 *
 * 实现 Read 工具的智能截断策略，根据文件类型和应用场景进行不同的压缩
 */

import type { ReadTruncationConfig, TruncationStrategy } from './types';
import { TEXT_UTILS, TOKEN_ESTIMATION_UTILS, DEBUG_UTILS } from './utils';
import { DEFAULT_CONFIG } from './constants';

export class SmartReadTruncator {
  private config: ReadTruncationConfig;

  constructor(config?: Partial<ReadTruncationConfig>) {
    this.config = {
      ...DEFAULT_CONFIG.readTruncation,
      ...config,
    };
  }

  /**
   * 智能截断文件内容
   */
  async truncate(
    filePath: string,
    content: string,
    fileType: string = this.detectFileType(filePath)
  ): Promise<{ truncated: string; savings: number; strategy: string }> {
    DEBUG_UTILS.logDebug('SmartReadTruncator', `Processing file: ${filePath}, type: ${fileType}`);

    // 获取该文件类型的截断策略
    const strategy = this.config.priority[fileType as keyof typeof this.config.priority] || 'keep_signatures';

    // 应用截断
    const truncated = await this.applyTruncation(content, strategy, fileType);

    // 计算节省量
    const originalTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(content);
    const optimizedTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(truncated);
    const savings = originalTokens - optimizedTokens;

    DEBUG_UTILS.logDebug('SmartReadTruncator',
      `Truncation complete: ${originalTokens} -> ${optimizedTokens} tokens (${savings} saved)`,
      { strategy, fileType, filePath }
    );

    return {
      truncated,
      savings,
      strategy,
    };
  }

  /**
   * 检测文件类型
   */
  private detectFileType(filePath: string): keyof typeof this.config.priority {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    // 根据扩展名映射到配置中的文件类型
    const typeMap: Record<string, keyof typeof this.config.priority> = {
      // 配置文件
      'json': 'config',
      'yaml': 'config',
      'yml': 'config',
      'toml': 'config',
      'ini': 'config',
      'conf': 'config',

      // 测试文件
      'test.spec.ts': 'test',
      'test.spec.js': 'test',
      'test.ts': 'test',
      'test.js': 'test',
      'spec.ts': 'test',
      'spec.js': 'test',

      // 源代码文件
      'ts': 'source',
      'tsx': 'source',
      'js': 'source',
      'jsx': 'source',
      'rs': 'source',
      'go': 'source',
      'py': 'source',
      'java': 'source',
      'cpp': 'source',
      'c': 'source',
      'h': 'source',

      // 文档文件
      'md': 'docs',
      'txt': 'docs',
      'rst': 'docs',

      // TypeScript 类型定义
      'd.ts': 'source',
    };

    return typeMap[ext] || 'source';
  }

  /**
   * 应用截断策略
   */
  private async applyTruncation(
    content: string,
    strategy: TruncationStrategy,
    fileType: string
  ): Promise<string> {
    // 如果内容大小小于最大限制，直接返回
    const estimatedTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(content);
    if (estimatedTokens <= this.config.maxSize) {
      return content;
    }

    switch (strategy) {
      case 'keep_all':
        return this.keepAll(content);

      case 'keep_signatures':
        return this.keepSignatures(content, fileType);

      case 'summary_only':
        return this.generateSummary(content, fileType);

      case 'head_tail':
        return TEXT_UTILS.smartTruncate(content, this.config.maxSize, 'head_tail');

      default:
        return TEXT_UTILS.smartTruncate(content, this.config.maxSize);
    }
  }

  /**
   * 保持所有内容（仅在需要时添加元数据）
   */
  private keepAll(content: string): string {
    const estimatedTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(content);

    if (estimatedTokens <= this.config.maxSize) {
      return content;
    }

    // 添加截断说明
    return `# File content truncated due to size limit
# Original size: ${estimatedTokens} tokens
# Max allowed: ${this.config.maxSize} tokens
# Content truncated to most recent parts

${TEXT_UTILS.smartTruncate(content, this.config.maxSize, 'head_tail')}`;
  }

  /**
   * 保留签名（函数、类、接口等）
   */
  private keepSignatures(content: string, fileType: string): string {
    const lines = content.split('\n');
    const importantLines: string[] = [];
    let braceCount = 0;
    let inClass = false;
    let inFunction = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // 跳过空行和注释（除非是文档注释）
      if (!trimmed || trimmed.startsWith('//')) {
        // 保留文档注释
        if (trimmed.startsWith('//') && trimmed.length > 2) {
          importantLines.push(line);
        }
        continue;
      }

      // 检测类定义
      if (fileType === 'source' && trimmed.match(/^(class|interface|type|enum)\s+\w+/)) {
        importantLines.push(line);
        inClass = trimmed.startsWith('class') || trimmed.startsWith('interface');
        continue;
      }

      // 检测函数定义
      if (fileType === 'source' && trimmed.match(/^(async\s+)?function\s+\w+|^\w+\s*\([^)]*\)\s*[:=]\s*|=>/)) {
        importantLines.push(line);
        inFunction = true;
        continue;
      }

      // 检测导入语句
      if (fileType === 'source' && trimmed.match(/^import\s+from|^\*\s+as\s+\w+\s+from/)) {
        importantLines.push(line);
        continue;
      }

      // 检测导出语句
      if (fileType === 'source' && trimmed.match(/^export\s+(default\s+)?|export\s*\{/)) {
        importantLines.push(line);
        continue;
      }

      // 保持类和函数的签名和开始部分
      if (inClass && braceCount > 0) {
        importantLines.push(line);
        if (line.includes('{')) braceCount++;
        if (line.includes('}')) braceCount--;
        continue;
      }

      if (inFunction && braceCount > 0) {
        importantLines.push(line);
        if (line.includes('{')) braceCount++;
        if (line.includes('}')) braceCount--;
        continue;
      }

      // 保持函数结束位置
      if (inFunction && line.includes('}') && braceCount === 1) {
        importantLines.push(line);
        inFunction = false;
        braceCount = 0;
        continue;
      }
    }

    const signatureContent = importantLines.join('\n');
    const signatureTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(signatureContent);

    if (signatureTokens <= this.config.maxSize) {
      return signatureContent;
    }

    // 如果签名仍然太大，进行进一步截断
    return TEXT_UTILS.smartTruncate(signatureContent, this.config.maxSize);
  }

  /**
   * 生成摘要
   */
  private generateSummary(content: string, fileType: string): string {
    const lines = content.split('\n');
    const summary: string[] = [];

    // 添加文件头信息
    summary.push(`# ${fileType.toUpperCase()} File Summary`);
    summary.push(`## Basic Information`);
    summary.push(`- File type: ${fileType}`);
    summary.push(`- Total lines: ${lines.length}`);
    summary.push(`- Total tokens: ${TOKEN_ESTIMATION_UTILS.estimateTokens(content)}`);

    // 根据文件类型提取关键信息
    switch (fileType) {
      case 'config':
        this.extractConfigSummary(lines, summary);
        break;

      case 'test':
        this.extractTestSummary(lines, summary);
        break;

      case 'source':
        this.extractSourceSummary(lines, summary);
        break;

      case 'docs':
        this.extractDocsSummary(lines, summary);
        break;

      default:
        summary.push('## Content Preview');
        const preview = lines.slice(0, 20).join('\n');
        summary.push(preview);
        if (lines.length > 20) {
          summary.push(`[... ${lines.length - 20} more lines]`);
        }
    }

    const summaryContent = summary.join('\n');
    const summaryTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(summaryContent);

    if (summaryTokens <= this.config.maxSize) {
      return summaryContent;
    }

    // 如果摘要仍然太大，进一步压缩
    return TEXT_UTILS.smartTruncate(summaryContent, this.config.maxSize);
  }

  /**
   * 提取配置文件摘要
   */
  private extractConfigSummary(lines: string[], summary: string[]): void {
    const configInfo = {
      imports: 0,
      exports: 0,
      interfaces: 0,
      types: 0,
      classes: 0,
      functions: 0,
    };

    const important: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('import')) {
        configInfo.imports++;
      } else if (trimmed.startsWith('export')) {
        configInfo.exports++;
      } else if (trimmed.includes('interface')) {
        configInfo.interfaces++;
      } else if (trimmed.includes('type ')) {
        configInfo.types++;
      } else if (trimmed.startsWith('class ')) {
        configInfo.classes++;
      } else if (trimmed.match(/(async\s+)?function\s+\w+/)) {
        configInfo.functions++;
      }
    }

    summary.push('## Configuration Details');
    summary.push(`- Import statements: ${configInfo.imports}`);
    summary.push(`- Export statements: ${configInfo.exports}`);
    summary.push(`- Interfaces: ${configInfo.interfaces}`);
    summary.push(`- Type definitions: ${configInfo.types}`);
    summary.push(`- Classes: ${configInfo.classes}`);
    summary.push(`- Functions: ${configInfo.functions}`);

    // 提取重要的配置项
    const configKeys = lines.filter(line =>
      line.includes(':') && !line.includes('//') && line.trim().length < 100
    ).slice(0, 10);

    if (configKeys.length > 0) {
      summary.push('## Key Configuration Items');
      summary.push(...configKeys.map(key => `- ${key.trim()}`));
    }
  }

  /**
   * 提取测试文件摘要
   */
  private extractTestSummary(lines: string[], summary: string[]): void {
    const testInfo = {
      testCases: 0,
      assertions: 0,
      mocks: 0,
      describeBlocks: 0,
    };

    const tests: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.match(/test\(/i) || trimmed.includes('describe(')) {
        testInfo.testCases++;
        if (trimmed.includes('describe(')) {
          testInfo.describeBlocks++;
        }
      } else if (trimmed.includes('expect(')) {
        testInfo.assertions++;
      } else if (trimmed.includes('mock') || trimmed.includes('stub')) {
        testInfo.mocks++;
      }
    }

    summary.push('## Test Statistics');
    summary.push(`- Test cases: ${testInfo.testCases}`);
    summary.push(`- Assertions: ${testInfo.assertions}`);
    summary.push(`- Mocks/stubs: ${testInfo.mocks}`);
    summary.push(`- Describe blocks: ${testInfo.describeBlocks}`);

    // 提取测试名称
    const testNames = lines
      .filter(line =>
        line.includes('test(') || line.includes('describe(')
      )
      .map(line => {
        const match = line.match(/(?:test|describe)\(['"`]([^'"`]+)['"`]/);
        return match ? match[1] : 'Unnamed test';
      })
      .slice(0, 5);

    if (testNames.length > 0) {
      summary.push('## Test Names');
      summary.push(...testNames.map(name => `- ${name}`));
    }
  }

  /**
   * 提取源代码摘要
   */
  private extractSourceSummary(lines: string[], summary: string[]): void {
    const sourceInfo = {
      imports: 0,
      exports: 0,
      functions: 0,
      classes: 0,
      interfaces: 0,
      variables: 0,
    };

    const functions: string[] = [];
    const classes: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('import')) {
        sourceInfo.imports++;
      } else if (trimmed.startsWith('export')) {
        sourceInfo.exports++;
      } else if (trimmed.match(/^(async\s+)?function\s+\w+/)) {
        sourceInfo.functions++;
        const funcName = trimmed.match(/function\s+(\w+)/)?.[1] ||
                        trimmed.match(/(?:async\s+)?(\w+)\s*\(/)?.[1];
        if (funcName) functions.push(funcName);
      } else if (trimmed.startsWith('class ')) {
        sourceInfo.classes++;
        const className = trimmed.match(/class\s+(\w+)/)?.[1];
        if (className) classes.push(className);
      } else if (trimmed.startsWith('interface ')) {
        sourceInfo.interfaces++;
      } else if (trimmed.match(/^(const|let|var)\s+\w+/)) {
        sourceInfo.variables++;
      }
    }

    summary.push('## Code Statistics');
    summary.push(`- Import statements: ${sourceInfo.imports}`);
    summary.push(`- Export statements: ${sourceInfo.exports}`);
    summary.push(`- Functions: ${sourceInfo.functions}`);
    summary.push(`- Classes: ${sourceInfo.classes}`);
    summary.push(`- Interfaces: ${sourceInfo.interfaces}`);
    summary.push(`- Variables: ${sourceInfo.variables}`);

    if (functions.length > 0) {
      summary.push('## Functions');
      summary.push(...functions.slice(0, 5).map(f => `- ${f}`));
      if (functions.length > 5) {
        summary.push(`[... and ${functions.length - 5} more]`);
      }
    }

    if (classes.length > 0) {
      summary.push('## Classes');
      summary.push(...classes.slice(0, 3).map(c => `- ${c}`));
      if (classes.length > 3) {
        summary.push(`[... and ${classes.length - 3} more]`);
      }
    }
  }

  /**
   * 提取文档摘要
   */
  private extractDocsSummary(lines: string[], summary: string[]): void {
    const docInfo = {
      headings: 0,
      codeBlocks: 0,
      links: 0,
      lists: 0,
    };

    const headings: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('#')) {
        docInfo.headings++;
        if (trimmed.startsWith('## ')) {
          headings.push(trimmed.substring(3));
        }
      } else if (trimmed.includes('```')) {
        docInfo.codeBlocks++;
      } else if (trimmed.includes('http') || trimmed.includes('[')) {
        docInfo.links++;
      } else if (trimmed.match(/^[\*\-\+]\s+/)) {
        docInfo.lists++;
      }
    }

    summary.push('## Document Structure');
    summary.push(`- Headings: ${docInfo.headings}`);
    summary.push(`- Code blocks: ${docInfo.codeBlocks}`);
    summary.push(`- Links: ${docInfo.links}`);
    summary.push(`- Lists: ${docInfo.lists}`);

    if (headings.length > 0) {
      summary.push('## Main Sections');
      summary.push(...headings.slice(0, 5));
      if (headings.length > 5) {
        summary.push(`[... and ${headings.length - 5} more sections]`);
      }
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<ReadTruncationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): ReadTruncationConfig {
    return { ...this.config };
  }
}