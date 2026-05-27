/**
 * CodegraphManager — 管理 codegraph CLI 的自动下载与子进程调用
 *
 * 核心设计：
 * 1. 首次使用时自动下载对应平台的 codegraph 预编译包（~45MB）到 vendor/
 * 2. 打开项目时自动检测 .codegraph/，不存在时自动初始化
 * 3. 所有查询通过子进程调用（codegraph 自带 Node 运行时 + node:sqlite）
 * 4. 后台 watcher 由 codegraph 自身管理（serve --mcp 模式）
 */

import { spawn, exec } from 'child_process';
import { existsSync, createWriteStream, mkdirSync } from 'fs';
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

function getBinaryPath(): string {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return join(VENDOR_DIR, `codegraph-${CODEGRAPH_VERSION}-${platform}-${arch}`, 'codegraph');
}

// ============================================================
// 自动下载
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
    const extractDir = join(VENDOR_DIR, `codegraph-${CODEGRAPH_VERSION}-${platform}-${arch}`);

    mkdirSync(VENDOR_DIR, { recursive: true });

    const tempFile = join(VENDOR_DIR, `download-temp-${Date.now()}.tar.gz`);
    await downloadFile(downloadUrl, tempFile);
    await extractTarGz(tempFile, VENDOR_DIR);

    try { await unlink(tempFile); } catch { /* ignore */ }
    try { await chmod(binPath, 0o755); } catch { /* ignore */ }
  })();

  await downloadPromise;
  downloadPromise = null;
  return binPath;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, { followRedirects: true }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        https.get(response.headers.location!, (redirected) => {
          redirected.pipe(file);
          file.on('finish', () => file.close(resolve));
        }).on('error', reject);
      } else {
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      }
    }).on('error', reject);
  });
}

async function extractTarGz(tarPath: string, dest: string): Promise<void> {
  await execAsync(`tar -xzf "${tarPath}" -C "${dest}"`);
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
