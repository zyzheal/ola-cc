#!/usr/bin/env node
/**
 * CLI wrapper — fallback bin entry when native binary is not installed.
 * Delegates to cli.mjs (Node.js bundle) if available, otherwise prints error.
 */

const { execSync } = require('child_process')
const { existsSync } = require('fs')
const { join, dirname } = require('path')

const pkgDir = dirname(require.resolve('./package.json'))
const cliMjs = join(pkgDir, 'cli.mjs')

if (existsSync(cliMjs)) {
  // Re-spawn under Node.js to handle the ESM bundle
  const node = process.execPath
  try {
    require('child_process').execFileSync(node, [cliMjs, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env },
    })
    process.exit(0)
  } catch (err) {
    process.exit(err.status || 1)
  }
} else {
  console.error('Error: ola-cc CLI bundle not found.')
  console.error('Ensure the package was installed correctly: npm install @zyzheal/ola-cc')
  process.exit(1)
}
