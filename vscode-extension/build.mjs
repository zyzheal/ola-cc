/**
 * Build script for the Claude Code VSCode extension.
 * Uses esbuild to bundle the extension and webview code.
 */
import * as esbuild from 'esbuild';
import { join, dirname } from 'path';
import { rmSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isWatch = process.argv.includes('--watch');
const projectRoot = join(__dirname, '..');
const extRoot = __dirname;
const srcDir = join(extRoot, 'src');
const distDir = join(extRoot, 'dist');
const webviewDistDir = join(distDir, 'webview');

// Clean and recreate dist
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
mkdirSync(webviewDistDir, { recursive: true });

const commonConfig = {
  bundle: true,
  minify: !isWatch,
  sourcemap: isWatch ? 'inline' : false,
  target: 'node18',
  platform: 'node',
  external: [
    'vscode',
    // Native modules we don't bundle
    'node-pty',
    'sharp',
  ],
};

async function build() {
  const ctx = await esbuild.context({
    ...commonConfig,
    entryPoints: [join(srcDir, 'extension.ts')],
    outfile: join(distDir, 'extension.js'),
    format: 'cjs',
    external: [...commonConfig.external, 'ws', 'axios', 'react', 'react-dom'],
    banner: {
      js: `
// VSCode Extension - Claude Code
// Bundled from ${projectRoot}/src/vscode
`,
    },
  });

  if (isWatch) {
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log('Extension bundled to dist/extension.js');
  }

  // Build webview bundle (separate context for browser target)
  const webviewCtx = await esbuild.context({
    bundle: true,
    minify: !isWatch,
    sourcemap: isWatch ? 'inline' : false,
    target: 'chrome100',
    platform: 'browser',
    format: 'iife',
    entryPoints: [join(srcDir, 'webview', 'app.tsx')],
    outfile: join(webviewDistDir, 'app.js'),
    loader: {
      '.png': 'dataurl',
      '.svg': 'dataurl',
      '.css': 'text',
    },
  });

  if (isWatch) {
    await webviewCtx.watch();
    console.log('Watching webview for changes...');
  } else {
    await webviewCtx.rebuild();
    await webviewCtx.dispose();
    console.log('Webview bundled to dist/webview/app.js');
  }
}

build().catch(e => {
  console.error('Build failed:', e);
  process.exit(1);
});
