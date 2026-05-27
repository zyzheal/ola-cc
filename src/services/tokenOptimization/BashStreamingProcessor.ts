/**
 * Bash Streaming Processor
 *
 * 实现 Bash 命令的流式处理，实时监控和截断输出，避免加载过大的输出到内存
 */

import { spawn, ChildProcess } from 'child_process';
import { BashStreamingConfig } from './types';
import { TOKEN_ESTIMATION_UTILS, DEBUG_UTILS, PERFORMANCE_UTILS } from './utils';
import { DEFAULT_CONFIG } from './constants';

export interface StreamingResult {
  content: string;
  truncated: boolean;
  fullOutputPath?: string;
  originalSize: number;
  truncatedSize: number;
  processingTime: number;
}

export class BashStreamingProcessor {
  private config: BashStreamingConfig;
  private activeProcesses = new Set<ChildProcess>();

  constructor(config?: Partial<BashStreamingConfig>) {
    this.config = {
      ...DEFAULT_CONFIG.bashStreaming,
      ...config,
    };
  }

  /**
   * 执行命令并流式处理输出
   */
  async execute(
    command: string,
    args: string[] = [],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    } = {}
  ): Promise<StreamingResult> {
    const startTime = performance.now();
    let output = '';
    let lineCount = 0;
    let tokenCount = 0;
    let shouldTruncate = false;
    let fullOutputPath: string | undefined;

    DEBUG_UTILS.logDebug('BashStreamingProcessor', `Executing command: ${command}`, { args });

    // 创建子进程
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: true,
    });

    this.activeProcesses.add(child);

    // 设置超时
    const timeoutId = setTimeout(() => {
      DEBUG_UTILS.logDebug('BashStreamingProcessor', 'Command timeout, killing process');
      child.kill('SIGTERM');
    }, options.timeout || 30000);

    // 处理输出
    const outputPromise = new Promise<StreamingResult>((resolve) => {
      // 处理标准输出
      child.stdout.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        const chunkLines = chunkStr.split('\n');

        for (const line of chunkLines) {
          if (this.shouldKeepLine(line)) {
            output += line + '\n';
            lineCount++;
            tokenCount += TOKEN_ESTIMATION_UTILS.estimateTokens(line + '\n');

            // 检查是否需要截断
            if (this.shouldTruncate(lineCount, tokenCount)) {
              shouldTruncate = true;

              if (this.config.immediateTruncate) {
                this.handleTruncate(output, command, args);
                resolve(this.createResult(output, true, fullOutputPath, startTime));
                return;
              }
            }
          }
        }
      });

      // 处理错误输出
      child.stderr.on('data', (chunk) => {
        const chunkStr = chunk.toString();

        // 错误信息始终保留
        output += chunkStr;
        lineCount += chunkStr.split('\n').length;
        tokenCount += TOKEN_ESTIMATION_UTILS.estimateTokens(chunkStr);
      });

      // 处理进程结束
      child.on('close', (code) => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(child);

        // 如果没有立即截断，检查是否需要在最后截断
        if (shouldTruncate && !this.config.immediateTruncate) {
          this.handleTruncate(output, command, args);
          resolve(this.createResult(output, true, fullOutputPath, startTime));
        } else {
          resolve(this.createResult(output, false, undefined, startTime));
        }
      });

      // 处理进程错误
      child.on('error', (error) => {
        clearTimeout(timeoutId);
        this.activeProcesses.delete(child);

        DEBUG_UTILS.logDebug('BashStreamingProcessor', 'Command execution error', { error });

        // 错误时返回完整的错误输出
        resolve({
          content: error.message,
          truncated: false,
          originalSize: error.message.length,
          truncatedSize: error.message.length,
          processingTime: performance.now() - startTime,
        });
      });
    });

    // 如果配置了TEE模式，在需要时保存完整输出
    if (this.config.teeMode !== 'never' && this.shouldSaveFullOutput()) {
      fullOutputPath = await this.setupTee(command, args);
    }

    return outputPromise;
  }

  /**
   * 判断是否应该保留行
   */
  private shouldKeepLine(line: string): boolean {
    const trimmed = line.trim();

    // 空行跳过（除非是重要的分隔符）
    if (!trimmed) {
      return line.match(/^[=\-]{3,}$/) !== null;
    }

    // 忽略进度条和状态行
    if (this.isProgressLine(line)) {
      return false;
    }

    // 忽略调试信息
    if (this.isDebugLine(line)) {
      return false;
    }

    // 忽略大量连续的相同字符（通常是装饰线）
    if (this.isDecorationLine(line)) {
      return false;
    }

    return true;
  }

  /**
   * 判断是否需要截断
   */
  private shouldTruncate(lineCount: number, tokenCount: number): boolean {
    return (
      lineCount >= this.config.maxLines ||
      tokenCount >= this.config.maxTokens ||
      this.checkFileSize(tokenCount)
    );
  }

  /**
   * 处理截断
   */
  private handleTruncate(output: string, command: string, args: string[]): void {
    // 根据TEE模式决定是否保存完整输出
    if (this.config.teeMode === 'always' ||
        (this.config.teeMode === 'failures' && this.hasErrors(output))) {
      this.saveFullOutput(output, command, args);
    }
  }

  /**
   * 创建结果对象
   */
  private createResult(
    content: string,
    truncated: boolean,
    fullOutputPath?: string,
    startTime?: number
  ): StreamingResult {
    const endTime = performance.now();
    const processingTime = startTime ? endTime - startTime : 0;
    const truncatedContent = this.applyFinalTruncation(content);

    return {
      content: truncatedContent,
      truncated,
      fullOutputPath,
      originalSize: content.length,
      truncatedSize: truncatedContent.length,
      processingTime,
    };
  }

  /**
   * 应用最终截断
   */
  private applyFinalTruncation(content: string): string {
    if (TOKEN_ESTIMATION_UTILS.estimateTokens(content) <= this.config.maxTokens) {
      return content;
    }

    // 使用智能截断
    // Use head-tail truncation
    const lines = content.split('\n');
    const maxLines = Math.floor(this.config.maxTokens / 10);
    const head = lines.slice(0, Math.ceil(maxLines * 0.6)).join('\n');
    const tail = lines.slice(-Math.floor(maxLines * 0.4)).join('\n');
    return `${head}\n[... truncated ...]\n${tail}`;
  }

  /**
   * 判断是否为进度条
   */
  private isProgressLine(line: string): boolean {
    const trimmed = line.trim();

    // 常见进度条模式
    const progressPatterns = [
      /\[\s*#{0,50}\s*\]{0,2}\s*\d+%/, // [###      ] 50%
      /\(\s*\d+\/\d+\s*\)/, // (123/456)
      /\d+%/, // 直接百分比
      /^Progress: \d+%/, // 明确的进度标记
      /\.\.{3,}/, // 省略号表示进度
    ];

    return progressPatterns.some(pattern => pattern.test(trimmed));
  }

  /**
   * 判断是否为调试信息
   */
  private isDebugLine(line: string): boolean {
    const trimmed = line.trim();

    // 调试信息模式
    const debugPatterns = [
      /^DEBUG:/,
      /^TRACE:/,
      /^\[DEBUG\]/,
      /^\[TRACE\]/,
      /^verbose:/,
      /^debug:/i,
    ];

    return debugPatterns.some(pattern => pattern.test(trimmed));
  }

  /**
   * 判断是否为装饰线
   */
  private isDecorationLine(line: string): boolean {
    const trimmed = line.trim();

    // 大量连续相同字符的装饰线
    if (/^[-=#*]{10,}$/.test(trimmed)) {
      return true;
    }

    // 纯数字组成的分隔线
    if (/^\d+$/.test(trimmed) && trimmed.length > 10) {
      return true;
    }

    return false;
  }

  /**
   * 检查文件大小
   */
  private checkFileSize(tokenCount: number): boolean {
    const estimatedBytes = tokenCount * 4; // 假设每个token约4字节
    return estimatedBytes >= this.config.maxFileSize;
  }

  /**
   * 判断是否应该保存完整输出
   */
  private shouldSaveFullOutput(): boolean {
    return this.config.teeMode === 'always';
  }

  /**
   * 判断输出中是否有错误
   */
  private hasErrors(content: string): boolean {
    const errorPatterns = [
      /error/i,
      /failed/i,
      /exception/i,
      /traceback/i,
      /stack trace/i,
    ];

    return errorPatterns.some(pattern => pattern.test(content));
  }

  /**
   * 保存完整输出到文件
   */
  private async saveFullOutput(content: string, command: string, args: string[] = []): Promise<string> {
    const timestamp = Date.now();
    const safeCommand = command.replace(/[^a-zA-Z0-9-_]/g, '_');
    const argsStr = args.join('-').substring(0, 50);
    const filename = `${safeCommand}_${argsStr}_${timestamp}.log`;

    // 在用户主目录创建缓存目录
    const cacheDir = process.env.XDG_CACHE_HOME
      ? `${process.env.XDG_CACHE_HOME}/ola-cc`
      : `${process.env.HOME}/.cache/ola-cc`;

    const fullPath = `${cacheDir}/tee_outputs/${filename}`;

    try {
      // 确保目录存在
      await import('fs').then(fs => {
        fs.mkdirSync(`${cacheDir}/tee_outputs`, { recursive: true });
      });

      // 写入文件
      await import('fs').then(fs => {
        fs.writeFileSync(fullPath, content, 'utf-8');
      });

      DEBUG_UTILS.logDebug('BashStreamingProcessor', `Saved full output to: ${fullPath}`);
      return fullPath;
    } catch (error) {
      DEBUG_UTILS.logDebug('BashStreamingProcessor', 'Failed to save full output', { error });
      return '';
    }
  }

  /**
   * 设置TEE模式（预创建输出目录）
   */
  private async setupTee(command: string, args: string[]): Promise<string> {
    if (!this.shouldSaveFullOutput()) {
      return '';
    }

    const timestamp = Date.now();
    const safeCommand = command.replace(/[^a-zA-Z0-9-_]/g, '_');
    const argsStr = args.join('-').substring(0, 50);
    const filename = `${safeCommand}_${argsStr}_${timestamp}.log`;

    const cacheDir = process.env.XDG_CACHE_HOME
      ? `${process.env.XDG_CACHE_HOME}/ola-cc`
      : `${process.env.HOME}/.cache/ola-cc`;

    const fullPath = `${cacheDir}/tee_outputs/${filename}`;

    try {
      await import('fs').then(fs => {
        fs.mkdirSync(`${cacheDir}/tee_outputs`, { recursive: true });
      });

      DEBUG_UTILS.logDebug('BashStreamingProcessor', `TEE mode enabled for: ${fullPath}`);
      return fullPath;
    } catch (error) {
      DEBUG_UTILS.logDebug('BashStreamingProcessor', 'Failed to setup TEE', { error });
      return '';
    }
  }

  /**
   * 终止所有活动的进程
   */
  async terminateAll(): Promise<void> {
    const processes = Array.from(this.activeProcesses);
    for (const child of processes) {
      child.kill('SIGTERM');
    }
    this.activeProcesses.clear();

    DEBUG_UTILS.logDebug('BashStreamingProcessor', 'All processes terminated');
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<BashStreamingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): BashStreamingConfig {
    return { ...this.config };
  }

  /**
   * 获取活动进程数量
   */
  getActiveProcessCount(): number {
    return this.activeProcesses.size;
  }
}

// 导出常量
export { TOKEN_ESTIMATION_UTILS } from './utils';