/**
 * Directory Cache
 *
 * 实现目录结构缓存，避免重复的 ls 操作，提高性能和减少 token 消耗
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { DirectoryCacheConfig } from './types';
import { TOKEN_ESTIMATION_UTILS, DEBUG_UTILS, CACHE_UTILS } from './utils';
import { DEFAULT_CONFIG } from './constants';

export interface CachedDirectory {
  path: string;
  structure: string;
  size: number;
  lastUpdated: number;
  metadata: {
    fileCount: number;
    dirCount: number;
    totalSize: number;
    modifiedFiles: string[];
  };
}

export class DirectoryCache {
  private config: DirectoryCacheConfig;
  private cache = new Map<string, CachedDirectory>();
  private lruCache = CACHE_UTILS.createLRUCache<string, CachedDirectory>(50);
  private allowedBasePath: string;

  constructor(config?: Partial<DirectoryCacheConfig>) {
    this.config = {
      ...DEFAULT_CONFIG.directoryCache,
      ...config,
    };
    this.allowedBasePath = process.cwd();
  }

  /**
   * 获取或缓存目录结构
   */
  async getDirectoryStructure(
    path: string,
    options: {
      maxDepth?: number;
      includeHidden?: boolean;
      forceRefresh?: boolean;
    } = {}
  ): Promise<CachedDirectory> {
    const validatedPath = this.validatePath(path);
    const normalizedPath = this.normalizePath(validatedPath);
    const cached = this.cache.get(normalizedPath);

    // 检查缓存是否有效
    if (
      cached &&
      !options.forceRefresh &&
      !this.isCacheExpired(cached.lastUpdated)
    ) {
      DEBUG_UTILS.logDebug('DirectoryCache', `Cache hit for: ${normalizedPath}`);
      return cached;
    }

    DEBUG_UTILS.logDebug('DirectoryCache', `Cache miss or expired for: ${normalizedPath}`);
    return await this.refreshDirectoryCache(normalizedPath, options);
  }

  /**
   * 刷新目录缓存
   */
  private async refreshDirectoryCache(
    path: string,
    options: { maxDepth?: number; includeHidden?: boolean; forceRefresh?: boolean } = {}
  ): Promise<CachedDirectory> {
    const startTime = performance.now();

    const maxDepth = options.maxDepth || this.config.maxDepth;
    const includeHidden = options.includeHidden ?? this.config.includeHidden;

    DEBUG_UTILS.logDebug('DirectoryCache', `Refreshing cache for: ${path}`, {
      maxDepth,
      includeHidden,
    });

    try {
      // 使用 ls 命令获取目录结构
      const structure = await this.buildDirectoryStructure(path, maxDepth, includeHidden);

      // 计算元数据
      const metadata = this.extractMetadata(structure);
      const size = TOKEN_ESTIMATION_UTILS.estimateTokens(structure);

      const cachedDir: CachedDirectory = {
        path,
        structure,
        size,
        lastUpdated: Date.now(),
        metadata,
      };

      // 更新缓存
      this.cache.set(path, cachedDir);
      this.lruCache.set(path, cachedDir);

      const duration = performance.now() - startTime;
      DEBUG_UTILS.logDebug('DirectoryCache',
        `Cache refreshed: ${path} (${size} tokens, ${metadata.fileCount} files, ${duration}ms)`,
        { metadata }
      );

      return cachedDir;
    } catch (error) {
      DEBUG_UTILS.logDebug('DirectoryCache', `Failed to refresh cache for: ${path}`, { error });
      throw error;
    }
  }

  /**
   * 构建目录结构
   */
  private async buildDirectoryStructure(
    path: string,
    maxDepth: number,
    includeHidden: boolean
  ): Promise<string> {
    const result: string[] = [];
    result.push(`# Directory Structure: ${path}`);
    result.push('');

    await this.buildTree(path, '', maxDepth, includeHidden, result);

    // 如果结构太大，进行压缩
    const fullStructure = result.join('\n');
    if (TOKEN_ESTIMATION_UTILS.estimateTokens(fullStructure) > this.config.maxSize) {
      return this.compressStructure(fullStructure);
    }

    return fullStructure;
  }

  /**
   * 递归构建目录树
   */
  private async buildTree(
    currentPath: string,
    indent: string,
    remainingDepth: number,
    includeHidden: boolean,
    result: string[]
  ): Promise<void> {
    if (remainingDepth < 0) return;

    try {
      // 使用 ls 命令获取文件列表
      const output = await this.executeLsCommand(currentPath, includeHidden);
      const lines = output.split('\n').filter(line => line.trim());

      // 排序：目录在前
      const dirs: string[] = [];
      const files: string[] = [];

      for (const line of lines) {
        const isDir = line.endsWith('/');
        if (isDir) {
          dirs.push(line);
        } else {
          files.push(line);
        }
      }

      // 处理目录
      for (const dir of dirs) {
        const cleanName = dir.replace(/\/$/, '');
        result.push(`${indent}📁 ${cleanName}/`);

        const subPath = `${currentPath}/${cleanName}`.replace(/^\//, '');
        await this.buildTree(
          subPath,
          indent + '  ',
          remainingDepth - 1,
          includeHidden,
          result
        );
      }

      // 处理文件
      for (const file of files) {
        const fileInfo = await this.getFileInfo(currentPath, file);
        const sizeStr = this.formatFileSize(fileInfo.size);
        const modTime = new Date(fileInfo.mtime).toLocaleDateString();

        result.push(`${indent}📄 ${file} (${sizeStr}, ${modTime})`);
      }

    } catch (error) {
      result.push(`${indent}❌ Error accessing directory`);
      DEBUG_UTILS.logDebug('DirectoryCache', `Error accessing ${currentPath}`, { error });
    }
  }

  /**
   * 执行 ls 命令
   */
  private async executeLsCommand(path: string, includeHidden: boolean): Promise<string> {
    const args = ['la'];
    if (!includeHidden) {
      args[0] = 'l';
    }

    return new Promise((resolve, reject) => {
      const child = spawn('ls', args, { cwd: path });
      let output = '';

      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        output += chunk.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          // 过滤掉总行和非文件行
          const lines = output.split('\n')
            .filter(line => line.trim() && !line.startsWith('total'))
            .slice(1); // 跳过权限行

          resolve(lines.join('\n'));
        } else {
          reject(new Error(`ls command failed with code ${code}`));
        }
      });

      child.on('error', reject);

      // 超时处理
      setTimeout(() => {
        child.kill();
        reject(new Error('ls command timeout'));
      }, 5000);
    });
  }

  /**
   * 获取文件信息
   */
  private async getFileInfo(path: string, filename: string): Promise<{ size: number; mtime: number }> {
    const filePath = `${path}/${filename}`.replace(/^\//, '');

    return new Promise((resolve, reject) => {
      const child = spawn('stat', ['-f', '%m %z', filePath]);

      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          const [mtime, size] = output.trim().split(' ');
          resolve({
            size: parseInt(size),
            mtime: parseInt(mtime),
          });
        } else {
          reject(new Error(`stat command failed for ${filePath}`));
        }
      });

      child.on('error', reject);
    });
  }

  /**
   * 格式化文件大小
   */
  private formatFileSize(size: number): string {
    if (size < 1024) return `${size}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)}MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }

  /**
   * 提取元数据
   */
  private extractMetadata(structure: string): CachedDirectory['metadata'] {
    const lines = structure.split('\n');
    let fileCount = 0;
    let dirCount = 0;
    let totalSize = 0;
    const modifiedFiles: string[] = [];

    for (const line of lines) {
      if (line.includes('📄')) {
        fileCount++;
        // 尝试提取文件大小
        const sizeMatch = line.match(/\(([\d.]+(?:KB|MB|GB|B))/);
        if (sizeMatch) {
          const sizeStr = sizeMatch[1];
          const size = this.parseFileSize(sizeStr);
          if (size) totalSize += size;
        }
      } else if (line.includes('📁')) {
        dirCount++;
      }
    }

    return {
      fileCount,
      dirCount,
      totalSize,
      modifiedFiles,
    };
  }

  /**
   * 解析文件大小
   */
  private parseFileSize(sizeStr: string): number | null {
    const match = sizeStr.match(/^([\d.]+)(B|KB|MB|GB)$/);
    if (!match) return null;

    const value = parseFloat(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'B': return value;
      case 'KB': return value * 1024;
      case 'MB': return value * 1024 * 1024;
      case 'GB': return value * 1024 * 1024 * 1024;
      default: return value;
    }
  }

  /**
   * 压缩目录结构
   */
  private compressStructure(structure: string): string {
    const lines = structure.split('\n');
    const result: string[] = [];

    // 保留顶层
    const topLevelLines = lines.filter(line =>
      !line.startsWith('  ') || line === lines[0]
    );

    // 统计子目录和文件
    const summary: { [key: string]: { files: number; size: number } } = {};

    for (const line of lines) {
      const match = line.match(/📁 ([^/]+)\/$/);
      if (match) {
        const dirName = match[1];
        summary[dirName] = { files: 0, size: 0 };
      }
    }

    // 统计文件
    for (const line of lines) {
      const dirMatch = line.match(/📁 ([^/]+)\/$/);
      const fileMatch = line.match(/📄 ([^(]+)/);

      if (dirMatch && fileMatch) {
        const dirName = dirMatch[1];
        const fileName = fileMatch[1];

        if (summary[dirName]) {
          summary[dirName].files++;

          const sizeMatch = line.match(/\(([\d.]+(?:KB|MB|GB|B))/);
          if (sizeMatch) {
            const size = this.parseFileSize(sizeMatch[1]);
            if (size) summary[dirName].size += size;
          }
        }
      }
    }

    result.push(...topLevelLines);

    // 添加汇总信息
    result.push('');
    result.push('## Summary');
    result.push(`Total directories: ${Object.keys(summary).length}`);
    result.push(`Total files: ${Object.values(summary).reduce((sum, dir) => sum + dir.files, 0)}`);

    // 显示每个目录的汇总
    for (const [dirName, info] of Object.entries(summary)) {
      result.push(`\n### ${dirName}/`);
      result.push(`- Files: ${info.files}`);
      result.push(`- Size: ${this.formatFileSize(info.size)}`);
    }

    return result.join('\n');
  }

  /**
   * 检查缓存是否过期
   */
  private isCacheExpired(timestamp: number): boolean {
    return CACHE_UTILS.isExpired(timestamp, this.config.ttl);
  }

  /**
   * 规范化路径
   */
  private normalizePath(p: string): string {
    return p.replace(/\/+/g, '/').replace(/\/$/, '');
  }

  /**
   * 验证路径安全性（防止路径遍历）
   */
  private validatePath(p: string): string {
    const resolved = path.resolve(this.allowedBasePath, p);
    if (!resolved.startsWith(this.allowedBasePath)) {
      throw new Error(`Path traversal detected: ${p} resolves outside allowed base ${this.allowedBasePath}`);
    }
    return resolved;
  }

  /**
   * 清理过期缓存
   */
  cleanup(): void {
    const now = Date.now();
    let deletedCount = 0;

    const entries = Array.from(this.cache.entries());
    for (const [path, dir] of entries) {
      if (this.isCacheExpired(dir.lastUpdated)) {
        this.cache.delete(path);
        this.lruCache.delete(path);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      DEBUG_UTILS.logDebug('DirectoryCache', `Cleaned up ${deletedCount} expired entries`);
    }
  }

  /**
   * 获取缓存统计
   */
  getStats(): {
    totalEntries: number;
    totalSize: number;
    oldestEntry: number;
    hitRate: number;
  } {
    const entries = Array.from(this.cache.values());
    const totalSize = entries.reduce((sum, dir) => sum + dir.size, 0);
    const oldestEntry = Math.min(...entries.map(dir => dir.lastUpdated));

    return {
      totalEntries: this.cache.size,
      totalSize,
      oldestEntry,
      hitRate: this.lruCache.size() / Math.max(1, this.cache.size),
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<DirectoryCacheConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  getConfig(): DirectoryCacheConfig {
    return { ...this.config };
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.lruCache.clear();
    DEBUG_UTILS.logDebug('DirectoryCache', 'Cache cleared');
  }
}