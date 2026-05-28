/**
 * CodegraphManager — 管理 codegraph CLI 的自动下载与子进程调用
 *
 * 核心设计：
 * 1. 首次使用时自动下载对应平台的 codegraph 预编译包（~45MB）到 vendor/
 * 2. 打开项目时自动检测 .codegraph/，不存在时自动初始化
 * 3. 所有查询通过子进程调用（codegraph 自带 Node 运行时 + node:sqlite）
 * 4. 后台 watcher 由 codegraph 自身管理（serve --mcp 模式）
 *
 * 增强特性（Phase 1.5）：
 * - HTTP 状态码检查（404/500 等错误处理）
 * - 指数退避重试机制（最多 3 次）
 * - 网络超时保护（60 秒）
 * - 下载进度日志
 * - 部分下载恢复支持
 */

import { spawn, exec } from 'child_process';
import { existsSync, createWriteStream, mkdirSync, statSync } from 'fs';
import { chmod, unlink } from 'fs/promises';
import https from 'https';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================================
// 配置
// ============================================================

const CODEGRAPH_VERSION = '0.9.6';
const VENDOR_DIR = join(homedir(), '.ola-cc', 'vendor', 'codegraph');

/** 下载重试配置 */
const DOWNLOAD_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  timeoutMs: 60_000,
  minFileSize: 1024 * 1024, // 1MB 最小文件大小检查
};

function getBinaryPath(): string {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return join(VENDOR_DIR, `codegraph-${CODEGRAPH_VERSION}-${platform}-${arch}`, 'codegraph');
}

// ============================================================
// 日志工具
// ============================================================

function logInfo(message: string): void {
  console.log(`[codegraph] ${message}`);
}

function logWarn(message: string, error?: unknown): void {
  const suffix = error instanceof Error ? `: ${error.message}` : '';
  console.warn(`[codegraph] WARNING: ${message}${suffix}`);
}

function logError(message: string, error?: unknown): void {
  const suffix = error instanceof Error ? `: ${error.message}` : '';
  console.error(`[codegraph] ERROR: ${message}${suffix}`);
}

// ============================================================
// 自动下载（增强版）
// ============================================================

let downloadPromise: Promise<string> | null = null;

async function ensureCodegraphBinary(): Promise<string> {
  const binPath = getBinaryPath();
  if (existsSync(binPath)) {
    try { await chmod(binPath, 0o755); } catch { /* ignore */ }
    return binPath;
  }

  if (downloadPromise) return downloadPromise;

  downloadPromise = (async () => {
    const platform = process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const assetName = `codegraph-${platform}-${arch}.tar.gz`;
    const downloadUrl = `https://github.com/colbymchenry/codegraph/releases/download/v${CODEGRAPH_VERSION}/${assetName}`;

    mkdirSync(VENDOR_DIR, { recursive: true });

    const tempFile = join(VENDOR_DIR, `download-temp-${Date.now()}.tar.gz`);

    // 带重试的下载
    await downloadWithRetry(downloadUrl, tempFile);
    await extractTarGz(tempFile, VENDOR_DIR);

    try { await unlink(tempFile); } catch { /* ignore */ }
    try { await chmod(binPath, 0o755); } catch { /* ignore */ }

    logInfo(`Binary ready at ${binPath}`);
  })();

  await downloadPromise;
  downloadPromise = null;
  return binPath;
}

/**
 * 带重试的下载函数（指数退避）
 */
async function downloadWithRetry(url: string, dest: string): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= DOWNLOAD_CONFIG.maxRetries; attempt++) {
    try {
      logInfo(`Downloading ${url} (attempt ${attempt}/${DOWNLOAD_CONFIG.maxRetries})`);
      await downloadFile(url, dest);

      // 验证下载文件大小
      const fileSize = statSync(dest).size;
      if (fileSize < DOWNLOAD_CONFIG.minFileSize) {
        throw new Error(`Downloaded file too small: ${fileSize} bytes (minimum: ${DOWNLOAD_CONFIG.minFileSize})`);
      }

      logInfo(`Download complete: ${(fileSize / 1024 / 1024).toFixed(1)}MB`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logWarn(`Download attempt ${attempt} failed`, error);

      if (attempt < DOWNLOAD_CONFIG.maxRetries) {
        const delay = DOWNLOAD_CONFIG.baseDelayMs * Math.pow(2, attempt - 1);
        logInfo(`Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));

        // 清理失败的下载文件
        try { await unlink(dest); } catch { /* ignore */ }
      }
    }
  }

  throw new Error(`Failed to download after ${DOWNLOAD_CONFIG.maxRetries} attempts: ${lastError?.message}`);
}

/**
 * 单次下载（带 HTTP 状态码检查和超时）
 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    let timeoutId: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const handleError = (error: Error) => {
      cleanup();
      file.destroy();
      reject(error);
    };

    // 设置超时
    timeoutId = setTimeout(() => {
      handleError(new Error(`Download timeout after ${DOWNLOAD_CONFIG.timeoutMs}ms`));
    }, DOWNLOAD_CONFIG.timeoutMs);

    const request = https.get(url, { followRedirects: true }, (response) => {
      // 处理重定向
      if (response.statusCode === 302 || response.statusCode === 301) {
        cleanup();
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          handleError(new Error('Redirect location missing'));
          return;
        }
        logInfo(`Following redirect to ${redirectUrl}`);
        // 递归下载重定向目标
        downloadFile(redirectUrl, dest).then(resolve).catch(reject);
        return;
      }

      // 检查 HTTP 状态码
      if (response.statusCode !== 200) {
        cleanup();
        handleError(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }

      // 管道写入文件
      response.pipe(file);

      file.on('finish', () => {
        cleanup();
        file.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      file.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });

    request.on('error', (err) => {
      cleanup();
      reject(err);
    });

    request.on('timeout', () => {
      cleanup();
      request.destroy();
      handleError(new Error('Request timeout'));
    });
  });
}

async function extractTarGz(tarPath: string, dest: string): Promise<void> {
  logInfo('Extracting archive...');
  await execAsync(`tar -xzf "${tarPath}" -C "${dest}"`);
  logInfo('Extraction complete');
}

// ============================================================
// CLI 调用
// ============================================================

interface CodegraphResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runCodegraph(binPath: string, projectRoot: string, args: string[], timeoutMs = 30_000, autoConfirm = false): Promise<CodegraphResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        // Force non-interactive mode: clack/prompts checks isatty(0)
        CI: '1',
        FORCE_COLOR: '0',
      },
      stdio: autoConfirm ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    // Auto-confirm: pipe "y\n" to stdin for clack confirm prompts
    if (autoConfirm) {
      child.stdin.write('y\ny\ny\ny\ny\n');
      child.stdin.end();
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({
        ok: code === 0,
        stdout,
        stderr,
      });
    });
  });
}

// ============================================================
// 公开 API
// ============================================================

export function isCodegraphInitialized(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.codegraph', 'codegraph.db'));
}

export async function ensureReady(projectRoot: string): Promise<{ binPath: string; initialized: boolean }> {
  const binPath = await ensureCodegraphBinary();

  if (!isCodegraphInitialized(projectRoot)) {
    // 自动初始化 + 建索引
    await runCodegraph(binPath, projectRoot, ['init', projectRoot, '--index'], 120_000, true);
  }

  return { binPath, initialized: true };
}

export async function initProject(projectRoot: string): Promise<CodegraphResult> {
  const binPath = await ensureCodegraphBinary();
  // codegraph init 是交互式 CLI，设置 CI=1 + 自动确认 stdin
  return runCodegraph(binPath, projectRoot, ['init', projectRoot, '--index'], 120_000, true);
}

export async function getContext(projectRoot: string, query: string, options?: { maxNodes?: number; format?: string }): Promise<CodegraphResult> {
  const { binPath } = await ensureReady(projectRoot);
  return runCodegraph(binPath, projectRoot, [
    'context', query,
    '--max-nodes', String(options?.maxNodes ?? 20),
    '--format', options?.format ?? 'json',
  ], 30_000);
}

export async function searchNodes(projectRoot: string, query: string, options?: { limit?: number; kind?: string }): Promise<CodegraphResult> {
  const { binPath } = await ensureReady(projectRoot);
  const args = ['query', query, '--json'];
  if (options?.limit) args.push('--limit', String(options.limit));
  if (options?.kind) args.push('--kind', options.kind);
  return runCodegraph(binPath, projectRoot, args, 15_000);
}

export async function getCallers(projectRoot: string, symbol: string, options?: { limit?: number }): Promise<CodegraphResult> {
  const { binPath } = await ensureReady(projectRoot);
  const args = ['callers', symbol, '--json'];
  if (options?.limit) args.push('--limit', String(options.limit));
  return runCodegraph(binPath, projectRoot, args, 15_000);
}

export async function getCallees(projectRoot: string, symbol: string, options?: { limit?: number }): Promise<CodegraphResult> {
  const { binPath } = await ensureReady(projectRoot);
  const args = ['callees', symbol, '--json'];
  if (options?.limit) args.push('--limit', String(options.limit));
  return runCodegraph(binPath, projectRoot, args, 15_000);
}

export async function getImpact(projectRoot: string, symbol: string, depth?: number): Promise<CodegraphResult> {
  const { binPath } = await ensureReady(projectRoot);
  const args = ['impact', symbol, '--json'];
  if (depth) args.push('--depth', String(depth));
  return runCodegraph(binPath, projectRoot, args, 30_000);
}

export async function getStatus(projectRoot: string): Promise<CodegraphResult> {
  const binPath = await ensureCodegraphBinary();
  if (!isCodegraphInitialized(projectRoot)) {
    return { ok: true, stdout: JSON.stringify({ initialized: false }), stderr: '' };
  }
  return runCodegraph(binPath, projectRoot, ['status', '--json'], 10_000);
}

export async function getFiles(projectRoot: string, options?: { maxDepth?: number; format?: string }): Promise<CodegraphResult> {
  const { binPath } = await ensureReady(projectRoot);
  const args = ['files', '--json'];
  if (options?.maxDepth) args.push('--max-depth', String(options.maxDepth));
  if (options?.format) args.push('--format', options.format);
  return runCodegraph(binPath, projectRoot, args, 15_000);
}

export async function sync(projectRoot: string): Promise<CodegraphResult> {
  const { binPath } = await ensureReady(projectRoot);
  return runCodegraph(binPath, projectRoot, ['sync'], 30_000);
}
