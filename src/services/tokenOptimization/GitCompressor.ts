/**
 * Git Compressor
 *
 * 实现 Git 命令输出的压缩，减少不必要的详细信息
 */

import { GitCompressionConfig } from './types';
import { TOKEN_ESTIMATION_UTILS, DEBUG_UTILS } from './utils';
import { DEFAULT_CONFIG, GIT_COMMAND_PATTERNS } from './constants';

interface FileStates {
  modified: string[];
  added: string[];
  deleted: string[];
  renamed: string[];
  untracked: string[];
}

export interface CompressionResult {
  content: string;
  compressionRatio: number;
  strategyUsed: string;
  savings: number;
}

export class GitCompressor {
  private config: GitCompressionConfig;

  constructor(config?: Partial<GitCompressionConfig>) {
    this.config = {
      ...DEFAULT_CONFIG.gitCompression,
      ...config,
    };
  }

  /**
   * 压缩 Git 命令输出
   */
  async compress(command: string, args: string[] = [], rawOutput: string): Promise<CompressionResult> {
    DEBUG_UTILS.logDebug('GitCompressor', `Compressing git command: ${command}`, { args });

    // 识别 Git 命令类型
    const commandType = this.identifyGitCommand(command, args);
    let compressed: string;

    switch (commandType) {
      case 'status':
        compressed = await this.compressStatus(rawOutput);
        break;
      case 'diff':
        compressed = await this.compressDiff(rawOutput);
        break;
      case 'log':
        compressed = await this.compressLog(rawOutput, args);
        break;
      case 'add':
        compressed = this.compressAdd(rawOutput);
        break;
      case 'commit':
        compressed = this.compressCommit(rawOutput);
        break;
      case 'push':
        compressed = this.compressPush(rawOutput);
        break;
      case 'pull':
        compressed = this.compressPull(rawOutput);
        break;
      default:
        compressed = this.compressGeneric(rawOutput);
    }

    // 计算压缩效果
    const originalTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(rawOutput);
    const compressedTokens = TOKEN_ESTIMATION_UTILS.estimateTokens(compressed);
    const savings = originalTokens - compressedTokens;
    const ratio = compressedTokens / originalTokens;

    DEBUG_UTILS.logDebug('GitCompressor',
      `Compression complete: ${originalTokens} -> ${compressedTokens} tokens (${savings} saved, ${Math.round((1 - ratio) * 100)}%)`
    );

    return {
      content: compressed,
      compressionRatio: ratio,
      strategyUsed: commandType,
      savings,
    };
  }

  /**
   * 识别 Git 命令类型
   */
  private identifyGitCommand(command: string, args: string[]): keyof typeof GIT_COMMAND_PATTERNS {
    const fullCommand = [command, ...args].join(' ');

    for (const [type, pattern] of Object.entries(GIT_COMMAND_PATTERNS)) {
      if (pattern.test(fullCommand)) {
        return type as keyof typeof GIT_COMMAND_PATTERNS;
      }
    }

    return 'status'; // 默认作为 status 处理
  }

  /**
   * 压缩 git status 输出
   */
  private async compressStatus(rawOutput: string): Promise<string> {
    const lines = rawOutput.split('\n');
    const summary: string[] = ['Git Status Summary'];

    // 解析不同状态
    const states: FileStates = {
      modified: [],
      added: [],
      deleted: [],
      renamed: [],
      untracked: [],
    };

    // 解析输出
    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.includes('On branch') || trimmed.includes('Your branch is')) {
        continue;
      }

      if (trimmed.startsWith('modified:')) {
        states.modified.push(trimmed.substring(9).trim());
      } else if (trimmed.startsWith('new file:')) {
        states.added.push(trimmed.substring(10).trim());
      } else if (trimmed.startsWith('deleted:')) {
        states.deleted.push(trimmed.substring(9).trim());
      } else if (trimmed.startsWith('renamed:')) {
        states.renamed.push(trimmed.substring(8).trim());
      } else if (trimmed.startsWith('??')) {
        states.untracked.push(trimmed.substring(2).trim());
      }
    }

    // 生成统计
    summary.push('');
    summary.push('## Changes Summary');

    const totalChanges = Object.values(states).reduce((sum, files) => sum + files.length, 0);
    summary.push(`Total changes: ${totalChanges} files`);

    // 按类型显示文件数量
    for (const [type, files] of Object.entries(states)) {
      if (files.length > 0) {
        summary.push(`${type.charAt(0).toUpperCase() + type.slice(1)}: ${files.length} files`);
      }
    }

    // 根据配置决定是否显示具体文件
    if (this.config.status === 'full') {
      this.addFileList(summary, states);
    } else if (this.config.status === 'minimal' && totalChanges <= 10) {
      this.addFileList(summary, states);
    } else {
      this.addCompactList(summary, states);
    }

    return summary.join('\n');
  }

  /**
   * 添加文件列表
   */
  private addFileList(summary: string[], states: FileStates): void {
    summary.push('');
    summary.push('## Files Changed');

    const order: Array<keyof typeof states> = ['modified', 'added', 'deleted', 'renamed', 'untracked'];

    for (const type of order) {
      const files = states[type];
      if (files.length > 0) {
        summary.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}`);
        for (const file of files) {
          summary.push(`  • ${file}`);
        }
      }
    }
  }

  /**
   * 添加紧凑列表
   */
  private addCompactList(summary: string[], states: FileStates): void {
    for (const [type, files] of Object.entries(states)) {
      if (files.length > 0) {
        const label = type === 'untracked' ? 'Untracked' : type.charAt(0).toUpperCase() + type.slice(1);
        summary.push(`  ${label}: ${files.length} files`);
      }
    }

    // 如果文件太多，提示数量
    const totalFiles = Object.values(states).reduce((sum, files) => sum + files.length, 0);
    if (totalFiles > 20) {
      summary.push(`  [and ${totalFiles - 20} more files]`);
    }
  }

  /**
   * 压缩 git diff 输出
   */
  private async compressDiff(rawOutput: string): Promise<string> {
    if (this.config.diff === 'summary') {
      return this.diffSummary(rawOutput);
    } else if (this.config.diff === 'stat') {
      return this.diffStat(rawOutput);
    } else {
      return this.diffUnified(rawOutput);
    }
  }

  /**
   * 生成 diff 摘要
   */
  private diffSummary(rawOutput: string): string {
    const lines = rawOutput.split('\n');
    const changes: { [file: string]: { additions: number; deletions: number } } = {};

    // 解析 diffstat 输出，分别统计增减行
    for (const line of lines) {
      const match = line.match(/^(\S+)\s+\|\s+(\d+)(\s*[+-]+)/);
      if (match) {
        const [, file, totalStr, markers] = match;
        const totalChanges = parseInt(totalStr);
        // 基于 + 和 - 符号的比例来分配增减行数
        if (markers) {
          const plusCount = (markers.match(/\+/g) || []).length;
          const minusCount = (markers.match(/-/g) || []).length;
          const totalMarkers = plusCount + minusCount;
          if (totalMarkers > 0) {
            changes[file] = {
              additions: Math.round(totalChanges * plusCount / totalMarkers),
              deletions: Math.round(totalChanges * minusCount / totalMarkers),
            };
          } else {
            changes[file] = { additions: 0, deletions: totalChanges };
          }
        } else {
          changes[file] = { additions: 0, deletions: totalChanges };
        }
      }
    }

    const summary = ['## Files Changed Summary'];
    summary.push(`Total files: ${Object.keys(changes).length}`);

    // 显示文件列表
    for (const [file, stats] of Object.entries(changes)) {
      summary.push(`  ${file} (+${stats.additions} -${stats.deletions})`);
    }

    return summary.join('\n');
  }

  /**
   * 生成统计信息
   */
  private diffStat(rawOutput: string): string {
    const lines = rawOutput.split('\n');
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const line of lines) {
      const additionsMatch = line.match(/\+(\d+)/);
      const deletionsMatch = line.match(/-(\d+)/);

      if (additionsMatch) {
        totalAdditions += parseInt(additionsMatch[1]);
      }
      if (deletionsMatch) {
        totalDeletions += parseInt(deletionsMatch[1]);
      }
    }

    return [
      '## Diff Statistics',
      `Files modified: ${Object.keys(this.extractFileChanges(rawOutput)).length}`,
      `Lines added: ${totalAdditions}`,
      `Lines deleted: ${totalDeletions}`,
      `Net change: ${totalAdditions - totalDeletions > 0 ? '+' : ''}${totalAdditions - totalDeletions}`,
    ].join('\n');
  }

  /**
   * 生成统一格式 diff（简化版）
   */
  private diffUnified(rawOutput: string): string {
    const lines = rawOutput.split('\n');
    const result: string[] = [];

    // 只保留关键行
    for (const line of lines) {
      // 保留文件头
      if (line.startsWith('+++ ') || line.startsWith('--- ')) {
        result.push(line);
        continue;
      }

      // 保留位置信息
      if (line.includes('@@')) {
        result.push(line);
        continue;
      }

      // 只保留实际的更改（+和-开头的行）
      if (line.startsWith('+') || line.startsWith('-')) {
        result.push(line);

        // 如果更改太多，截断
        if (result.length > 50) {
          result.push('[... diff output truncated]');
          break;
        }
      }
    }

    return ['## Diff Changes (simplified)', ...result].join('\n');
  }

  /**
   * 提取文件变更（辅助函数）
   */
  private extractFileChanges(rawOutput: string): { [file: string]: any } {
    // 实现文件变更提取逻辑
    return {};
  }

  /**
   * 压缩 git log 输出
   */
  private async compressLog(rawOutput: string, args: string[]): Promise<string> {
    const lines = rawOutput.split('\n');
    const commits = [];

    // 解析 commit
    let currentCommit = null;
    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('commit ')) {
        if (currentCommit) {
          commits.push(currentCommit);
        }
        currentCommit = {
          hash: trimmed.substring(7),
          message: '',
          author: '',
          date: '',
        };
      } else if (trimmed.startsWith('Author:')) {
        currentCommit!.author = trimmed.substring(7).trim();
      } else if (trimmed.startsWith('Date:')) {
        currentCommit!.date = trimmed.substring(5).trim();
      } else if (trimmed && !trimmed.startsWith('Merge:')) {
        currentCommit!.message = trimmed;
      }
    }

    if (currentCommit) {
      commits.push(currentCommit);
    }

    // 根据配置生成不同格式的输出
    switch (this.config.log) {
      case 'hash-only':
        return this.logHashOnly(commits);
      case 'oneline':
        return this.logOneLine(commits);
      default:
        return this.logShort(commits);
    }
  }

  /**
   * 只显示 commit hash
   */
  private logHashOnly(commits: any[]): string {
    const hashes = commits.map(c => c.hash).slice(0, 20); // 最多显示20个
    return `## Recent Commits (${commits.length})\n${hashes.join('\n')}`;
  }

  /**
   * 显示单行格式
   */
  private logOneLine(commits: any[]): string {
    const result = ['## Recent Commits'];

    for (const commit of commits.slice(0, 10)) {
      const message = commit.message.length > 50
        ? commit.message.substring(0, 47) + '...'
        : commit.message;

      result.push(`${commit.hash.substring(0, 7)} ${message}`);
    }

    if (commits.length > 10) {
      result.push(`[... and ${commits.length - 10} more commits]`);
    }

    return result.join('\n');
  }

  /**
   * 显示短格式
   */
  private logShort(commits: any[]): string {
    const result = ['## Recent Commits'];

    for (const commit of commits.slice(0, 5)) {
      result.push(`### ${commit.hash}`);
      result.push(`**Message:** ${commit.message}`);
      result.push(`**Author:** ${commit.author}`);
      result.push(`**Date:** ${commit.date}`);
      result.push('');
    }

    if (commits.length > 5) {
      result.push(`[... and ${commits.length - 5} more commits]`);
    }

    return result.join('\n');
  }

  /**
   * 压缩 git add
   */
  private compressAdd(rawOutput: string): string {
    if (!rawOutput.trim()) {
      return 'Files added successfully.';
    }

    const files = rawOutput.split('\n').filter(line => line.trim());
    return `Added ${files.length} files${files.length <= 5 ? ': ' + files.join(', ') : ''}`;
  }

  /**
   * 压缩 git commit
   */
  private compressCommit(rawOutput: string): string {
    if (this.config.commit === 'hash-only') {
      const match = rawOutput.match(/([a-f0-9]{7,40})/);
      return match ? `ok ${match[1]}` : 'ok';
    }

    return rawOutput.split('\n')[0] || 'Commit successful.';
  }

  /**
   * 压缩 git push
   */
  private compressPush(rawOutput: string): string {
    const match = rawOutput.match(/([a-f0-9]{7,40})/);
    return match ? `ok ${match[1].substring(0, 7)}` : 'ok';
  }

  /**
   * 压缩 git pull
   */
  private compressPull(rawOutput: string): string {
    const changes = {
      added: (rawOutput.match(/\+\s+(\d+)/g) || []).length,
      deleted: (rawOutput.match(/-\s+(\d+)/g) || []).length,
    };

    if (changes.added > 0 || changes.deleted > 0) {
      return `ok ${changes.added} +${changes.added} -${changes.deleted}`;
    }

    return 'ok';
  }

  /**
   * 通用压缩
   */
  private compressGeneric(rawOutput: string): string {
    const lines = rawOutput.split('\n');
    const firstLine = lines[0] || '';
    const lastLines = lines.slice(-3).join('\n');

    return [
      '## Git Command Output',
      firstLine,
      '---',
      lastLines,
      `[... output truncated to ${TOKEN_ESTIMATION_UTILS.estimateTokens(rawOutput)} -> ${TOKEN_ESTIMATION_UTILS.estimateTokens(lastLines)} tokens]`
    ].join('\n');
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<GitCompressionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): GitCompressionConfig {
    return { ...this.config };
  }
}