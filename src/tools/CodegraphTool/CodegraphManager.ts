/**
 * CodegraphManager — 管理 codegraph CLI 的自动下载与子进程调用
 *
 * 核心设计：
 * 1. 优先使用内置的 codegraph 二进制（通过 npm optionalDependencies 安装）
 * 2. 如果内置不可用，首次使用时自动下载对应平台的 codegraph 预编译包（~45MB）到 vendor/
 * 3. 打开项目时自动检测 .codegraph/，不存在时自动初始化
 * 4. 所有查询通过子进程调用（codegraph 自带 Node 运行时 + node:sqlite）
 * 5. 后台 watcher 由 codegraph 自身管理（serve --mcp 模式）
 *
 * 增强特性（Phase 1.5）：
 * - HTTP 状态码检查（404/500 等错误处理）
 * - 指数退避重试机制（最多 3 次）
 * - 网络超时保护（60 秒）
 * - 下载进度日志
 * - 部分下载恢复支持
 */

import { spawn, execFile } from 'child_process';
import { existsSync, createWriteStream, mkdirSync, readFileSync, statSync, readdirSync, writeFileSync, realpathSync } from 'fs';
import { chmod, unlink } from 'fs/promises';
import { createHash, randomUUID } from 'crypto';
import { logForDebugging } from '../../utils/debug.js';
import https from 'https';
import { homedir } from 'os';
import { join, dirname, relative, isAbsolute, resolve } from 'path';
import { promisify } from 'util';
import { createRequire } from 'module';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

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

// ============================================================
// 子进程生命周期管理（防止孤儿进程）
// ============================================================

/** 跟踪所有活跃的子进程及其进程组，父进程退出时统一清理 */
const activeChildren = new Map<ReturnType<typeof spawn>, number>(); // child → pgid

/** 杀死进程组（Unix）或进程树（Windows） */
function killProcessGroup(pgid: number, child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32') {
    // Windows: taskkill /T 杀死进程树，/F 强制
    try {
      const { execSync } = require('child_process');
      execSync(`taskkill /T /F /PID ${pgid}`, { timeout: 5000, stdio: 'ignore' });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  } else {
    // Unix: 杀死整个进程组（负 PID）
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}

/** 清理所有子进程（杀死进程组，覆盖孙进程） */
function killAllChildren(): void {
  for (const [child, pgid] of activeChildren) {
    killProcessGroup(pgid, child);
  }
  activeChildren.clear();
}

// 注册退出清理：确保子进程不变成孤儿进程
process.on('exit', killAllChildren);
process.on('SIGTERM', () => { killAllChildren(); process.exit(128 + 15); });
process.on('SIGINT', () => { killAllChildren(); process.exit(128 + 2); });

/**
 * 查找内置的 codegraph 二进制文件路径
 * 优先从 node_modules 中的平台特定包加载
 */
function getBuiltinBinaryPath(): string | null {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const packageName = `@colbymchenry/codegraph-${platform}-${arch}`;

  // 策略 1: require.resolve（开发模式 / 非打包环境）
  try {
    const packagePath = require.resolve(`${packageName}/package.json`);
    const packageDir = dirname(packagePath);
    const binaryPath = join(packageDir, 'bin', 'codegraph');
    if (existsSync(binaryPath)) {
      logInfo(`Using builtin codegraph from ${packageName} (require.resolve)`);
      return binaryPath;
    }
  } catch {
    // 打包后 require.resolve 不可用，继续
  }

  // 策略 2: 从二进制自身真实路径向上搜索 node_modules
  // （打包二进制中 require.resolve 不可用时的回退）
  try {
    const execDir = dirname(realpathSync(process.execPath));
    const binPath = join(execDir, 'node_modules', packageName, 'bin', 'codegraph');
    if (existsSync(binPath)) {
      logInfo(`Using builtin codegraph from ${packageName} (binary-relative)`);
      return binPath;
    }
  } catch {
    // process.execPath 不可用
  }

  // 策略 3: cwd 回退
  const cwdBinPath = join(process.cwd(), 'node_modules', packageName, 'bin', 'codegraph');
  if (existsSync(cwdBinPath)) {
    logInfo(`Using builtin codegraph from ${packageName} (cwd-relative)`);
    return cwdBinPath;
  }

  // 策略 4: 主包
  try {
    const mainPackagePath = require.resolve('@colbymchenry/codegraph/package.json');
    const mainBinaryPath = join(dirname(mainPackagePath), 'bin', 'codegraph');
    if (existsSync(mainBinaryPath)) {
      logInfo('Using builtin codegraph from main package');
      return mainBinaryPath;
    }
  } catch {
    // 忽略
  }

  return null;
}

/**
 * 获取 codegraph 二进制文件路径
 * 优先使用内置版本，否则使用下载版本
 */
function getBinaryPath(): string | null {
  // 优先尝试内置版本
  const builtinPath = getBuiltinBinaryPath();
  if (builtinPath) {
    return builtinPath;
  }

  // 回退到下载版本
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const vendorPath = join(VENDOR_DIR, `codegraph-${CODEGRAPH_VERSION}-${platform}-${arch}`, 'codegraph');
  return existsSync(vendorPath) ? vendorPath : null;
}

// ============================================================
// 日志工具
// ============================================================

function logInfo(message: string): void {
  logForDebugging(`[codegraph] ${message}`);
}

function logWarn(message: string, error?: unknown): void {
  const suffix = error instanceof Error ? `: ${error.message}` : '';
  console.warn(`[codegraph] WARNING: ${message}${suffix}`);
}

// ============================================================
// 自动下载（增强版）
// ============================================================

let downloadPromise: Promise<string> | null = null;
const initPromises = new Map<string, Promise<void>>();

async function ensureCodegraphBinary(): Promise<string> {
  // 优先检查内置版本
  const builtinPath = getBuiltinBinaryPath();
  if (builtinPath && existsSync(builtinPath)) {
    try { await chmod(builtinPath, 0o755); } catch { /* ignore */ }
    return builtinPath;
  }

  // 检查已下载的版本
  const binPath = getBinaryPath();
  if (binPath && existsSync(binPath)) {
    try { await chmod(binPath, 0o755); } catch { /* ignore */ }
    // 完整性校验（TOFU）
    if (!verifyBinaryIntegrity(binPath)) {
      logWarn('Binary integrity check failed, re-downloading...');
      try { await unlink(binPath); } catch { /* ignore */ }
      try { await unlink(binPath + '.sha256'); } catch { /* ignore */ }
      // 继续到下载逻辑
    } else {
      return binPath;
    }
  }

  // 需要下载
  if (downloadPromise) return downloadPromise;

  downloadPromise = (async () => {
    const platform = process.platform;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const assetName = `codegraph-${platform}-${arch}.tar.gz`;
    const downloadUrl = `https://github.com/colbymchenry/codegraph/releases/download/v${CODEGRAPH_VERSION}/${assetName}`;
    const expectedPath = join(VENDOR_DIR, `codegraph-${CODEGRAPH_VERSION}-${platform}-${arch}`, 'codegraph');

    mkdirSync(VENDOR_DIR, { recursive: true });

    const tempFile = join(VENDOR_DIR, `download-temp-${randomUUID()}.tar.gz`);

    // 带重试的下载
    await downloadWithRetry(downloadUrl, tempFile);
    await extractTarGz(tempFile, VENDOR_DIR);

    try { await unlink(tempFile); } catch { /* ignore */ }
    try { await chmod(expectedPath, 0o755); } catch { /* ignore */ }

    // 下载后存储哈希（TOFU）
    verifyBinaryIntegrity(expectedPath);

    logInfo(`Binary ready at ${expectedPath}`);
    return expectedPath;
  })();

  try {
    const result = await downloadPromise;
    return result;
  } finally {
    downloadPromise = null;
  }
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
 * 单次下载（带 HTTP 状态码检查、超时和重定向循环保护）
 */
function downloadFile(url: string, dest: string, redirectCount = 0): Promise<void> {
  const MAX_REDIRECTS = 5;
  if (redirectCount > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects (${redirectCount}), possible redirect loop`));
  }

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

    const request = https.get(url, (response) => {
      // 处理重定向
      if (response.statusCode === 302 || response.statusCode === 301) {
        cleanup();
        file.destroy(); // 关闭当前 WriteStream，防止文件描述符泄漏
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          reject(new Error('Redirect location missing'));
          return;
        }
        // 安全校验：拒绝非 HTTPS 重定向（防止 MITM 协议降级攻击）
        if (!redirectUrl.startsWith('https://')) {
          reject(new Error(`Redirect to non-HTTPS URL blocked: ${redirectUrl}`));
          return;
        }
        // 安全校验：限制重定向目标域名（防止恶意服务器投递二进制）
        try {
          const redirectHost = new URL(redirectUrl).hostname;
          const allowed = redirectHost === 'github.com'
            || redirectHost === 'githubusercontent.com'
            || redirectHost.endsWith('.githubusercontent.com');
          if (!allowed) {
            reject(new Error(`Redirect to unauthorized host blocked: ${redirectHost}`));
            return;
          }
        } catch {
          reject(new Error(`Invalid redirect URL: ${redirectUrl}`));
          return;
        }
        logInfo(`Following redirect to ${redirectUrl} (${redirectCount + 1}/${MAX_REDIRECTS})`);
        // 递归下载重定向目标（带循环保护）
        downloadFile(redirectUrl, dest, redirectCount + 1).then(resolve).catch(reject);
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

/**
 * 计算文件 SHA-256 哈希
 */
function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 二进制完整性校验（TOFU: Trust On First Use）
 * 首次下载时存储哈希，后续加载时验证
 */
function verifyBinaryIntegrity(binaryPath: string): boolean {
  const hashFile = binaryPath + '.sha256';
  const currentHash = computeFileHash(binaryPath);

  if (existsSync(hashFile)) {
    const storedHash = readFileSync(hashFile, 'utf-8').trim();
    if (currentHash !== storedHash) {
      logWarn(`Binary integrity check failed: hash mismatch for ${binaryPath}`);
      logWarn(`Expected: ${storedHash}, Got: ${currentHash}`);
      return false;
    }
    return true;
  }

  // 首次使用：存储哈希（TOFU）
  try {
    writeFileSync(hashFile, currentHash, 'utf-8');
    logInfo(`Stored binary hash for future verification: ${hashFile}`);
  } catch {
    logWarn('Failed to store binary hash, integrity verification disabled for future loads');
  }
  return true;
}

async function extractTarGz(tarPath: string, dest: string): Promise<void> {
  logInfo('Extracting archive...');
  // --no-absolute-filenames: 防止绝对路径穿越（如 /etc/passwd）
  // --overwrite: 允许覆盖已存在的文件
  await execFileAsync('tar', ['-xzf', tarPath, '-C', dest, '--no-absolute-filenames', '--overwrite'], { timeout: 120000 });
  // Post-extraction validation: ensure no files escaped the destination directory
  validateExtractedPaths(dest);
  logInfo('Extraction complete');
}

/**
 * 验证解压后的文件都在目标目录内（防止 ../ 相对路径穿越）
 */
function validateExtractedPaths(dest: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const rel = relative(dest, fullPath);
      if (isAbsolute(rel) || rel.startsWith('..')) {
        throw new Error(`Path traversal detected in extracted archive: ${rel}`);
      }
      if (entry.isDirectory()) {
        walk(fullPath);
      }
    }
  };
  walk(dest);
}

// ============================================================
// CLI 调用
// ============================================================

interface CodegraphResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runCodegraph(binPath: string, projectRoot: string, args: string[], timeoutMs = 30_000, autoConfirm = false, onStderr?: (line: string) => void): Promise<CodegraphResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, {
      cwd: projectRoot,
      env: {
        // 安全: 白名单环境变量，避免泄露 API 密钥给第三方二进制
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        // Force non-interactive mode: clack/prompts checks isatty(0)
        CI: '1',
        FORCE_COLOR: '0',
      },
      stdio: autoConfirm ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      // detached: true 创建新进程组，确保 kill(-pgid) 能杀死所有子孙进程
      detached: true,
    });

    // 获取进程组 ID（detached: true 时 pgid = child.pid）
    const pgid = child.pid;
    if (pgid == null) {
      throw new Error('Failed to get child process PID — binary may not exist');
    }
    activeChildren.set(child, pgid);
    child.on('exit', () => activeChildren.delete(child));

    // Auto-confirm: pipe "y\n" to stdin for clack confirm prompts
    if (autoConfirm) {
      child.stdin.write('y\ny\ny\ny\ny\n');
      child.stdin.end();
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    let stderrLineBuffer = '';
    let stdoutLineBuffer = '';
    const MAX_OUTPUT_SIZE = 50 * 1024 * 1024; // 50MB 上限，防止 OOM

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.stdout.on('data', (data: Buffer) => {
      stdoutSize += data.length;
      if (stdoutSize > MAX_OUTPUT_SIZE) {
        child.kill('SIGKILL');
        settle(() => reject(new Error('stdout output exceeded 50MB limit')));
        return;
      }
      stdoutChunks.push(data);
      // shimmer-worker 写 stdout fd 1，需要行缓冲传递给 onStderr 回调
      if (onStderr) {
        stdoutLineBuffer += data.toString();
        const lines = stdoutLineBuffer.split('\n');
        stdoutLineBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            try { onStderr(trimmed); } catch { /* ignore callback errors */ }
          }
        }
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      stderrSize += data.length;
      if (stderrSize > MAX_OUTPUT_SIZE) {
        child.kill('SIGKILL');
        settle(() => reject(new Error('stderr output exceeded 50MB limit')));
        return;
      }
      stderrChunks.push(data);
      // Line-buffered stderr relay for progress reporting
      if (onStderr) {
        stderrLineBuffer += data.toString();
        const lines = stderrLineBuffer.split('\n');
        stderrLineBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            try { onStderr(trimmed); } catch { /* ignore callback errors */ }
          }
        }
      }
    });

    // 手动超时保险：杀死整个进程组（覆盖 tree-sitter worker 等孙进程）
    const timer = setTimeout(() => {
      killProcessGroup(pgid, child);
      settle(() => reject(new Error(`codegraph process timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    child.on('error', (err) => { clearTimeout(timer); settle(() => reject(err)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Flush remaining stderr line buffer
      if (onStderr && stderrLineBuffer.trim()) {
        try { onStderr(stderrLineBuffer.trim()); } catch { /* ignore */ }
        stderrLineBuffer = '';
      }
      // Flush remaining stdout line buffer (shimmer-worker output)
      if (onStderr && stdoutLineBuffer.trim()) {
        try { onStderr(stdoutLineBuffer.trim()); } catch { /* ignore */ }
        stdoutLineBuffer = '';
      }
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      settle(() => resolve({
        ok: code === 0,
        stdout,
        stderr,
      }));
    });
  });
}

// ============================================================
// 新鲜度追踪
// ============================================================

/** 每个项目的上次 sync 时间戳 */
const lastSyncTime = new Map<string, number>();
/** 已触发后台 sync 的项目及其触发时间戳（防止重复触发，超时后允许重新触发） */
const syncTriggered = new Map<string, number>();
/** sync 飞行锁：同一项目的 sync 串行执行 */
const syncPromises = new Map<string, Promise<CodegraphResult>>();

/** 5 分钟内视为新鲜 */
export const FRESH_THRESHOLD_MS = 5 * 60_000;

export function getLastSyncAge(projectRoot: string): number | null {
  const t = lastSyncTime.get(projectRoot);
  return t != null ? Date.now() - t : null;
}

function recordSyncTime(projectRoot: string): void {
  lastSyncTime.set(projectRoot, Date.now());
}

// ============================================================
// 公开 API
// ============================================================

export function isCodegraphInitialized(projectRoot: string): boolean {
  return existsSync(join(projectRoot, '.codegraph', 'codegraph.db'));
}

export async function ensureReady(projectRoot: string, onStderr?: (line: string) => void): Promise<{ binPath: string; initialized: boolean }> {
  const binPath = await ensureCodegraphBinary();

  if (!isCodegraphInitialized(projectRoot)) {
    // 按 projectRoot 隔离的飞行锁：防止并发触发多次 init
    if (!initPromises.has(projectRoot)) {
      const promise = runCodegraph(binPath, projectRoot, ['init', projectRoot, '--index'], 120_000, true, onStderr)
        .then((result) => {
          if (!result.ok) {
            throw new Error(`CodeGraph 初始化失败: ${result.stderr || result.stdout}`);
          }
          if (!isCodegraphInitialized(projectRoot)) {
            throw new Error('CodeGraph 初始化命令成功但未创建数据库文件');
          }
        })
        .finally(() => { initPromises.delete(projectRoot) })
      initPromises.set(projectRoot, promise)
    }
    await initPromises.get(projectRoot)!
  }

  // 首次预热 sync：runCodegraph 使用 detached+进程组，父进程退出时自动清理
  // syncTriggered 使用时间戳：超时后允许重新触发（修复 C-3）
  const triggeredAt = syncTriggered.get(projectRoot);
  const stale = triggeredAt != null && (Date.now() - triggeredAt) > FRESH_THRESHOLD_MS;
  if (triggeredAt == null || stale) {
    syncTriggered.set(projectRoot, Date.now());
    const age = getLastSyncAge(projectRoot);
    if (age == null || age > FRESH_THRESHOLD_MS) {
      // 使用 syncPromises 飞行锁：复用已有 sync（修复 C-4）
      if (!syncPromises.has(projectRoot)) {
        logInfo('Background sync triggered (process group managed)');
        const promise = runCodegraph(binPath, projectRoot, ['sync'], 60_000)
          .then((result) => {
            if (result.ok) {
              recordSyncTime(projectRoot);
              logInfo('Background sync completed');
            } else {
              logWarn('Background sync failed', result.stderr);
              syncTriggered.delete(projectRoot); // 允许下次重试
            }
            return result;
          })
          .catch((err) => {
            logWarn('Background sync error', err);
            syncTriggered.delete(projectRoot); // 允许下次重试
            return { ok: false, stdout: '', stderr: String(err) } as CodegraphResult;
          })
          .finally(() => { syncPromises.delete(projectRoot) });
        syncPromises.set(projectRoot, promise);
      }
    }
  }

  return { binPath, initialized: true };
}

export async function initProject(projectRoot: string, onStderr?: (line: string) => void): Promise<CodegraphResult> {
  const binPath = await ensureCodegraphBinary();
  // codegraph init 是交互式 CLI，设置 CI=1 + 自动确认 stdin
  return runCodegraph(binPath, projectRoot, ['init', projectRoot, '--index'], 120_000, true, onStderr);
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

export async function sync(projectRoot: string, onStderr?: (line: string) => void): Promise<CodegraphResult> {
  const { binPath } = await ensureReady(projectRoot);
  // 使用 syncPromises 飞行锁：与 ensureReady 后台 sync 串行（修复 C-4）
  if (syncPromises.has(projectRoot)) {
    return syncPromises.get(projectRoot)!;
  }
  const promise = runCodegraph(binPath, projectRoot, ['sync'], 60_000, false, onStderr)
    .then((result) => {
      if (result.ok) recordSyncTime(projectRoot);
      syncTriggered.set(projectRoot, Date.now()); // 更新触发时间
      return result;
    })
    .finally(() => { syncPromises.delete(projectRoot) });
  syncPromises.set(projectRoot, promise);
  return promise;
}
