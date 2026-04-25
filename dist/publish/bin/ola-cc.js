#!/usr/bin/env node
'use strict'
var path = require('path')
var fs = require('fs')
var childProcess = require('child_process')
var pkgDir = path.dirname(__dirname)
var binDir = path.join(pkgDir, 'bin')
var nativeBin = process.platform === 'win32' ? path.join(binDir, 'ola-cc.exe') : path.join(binDir, 'ola-cc')
var cliMjs = path.join(pkgDir, 'cli.mjs')
if (fs.existsSync(nativeBin)) {
  try { childProcess.execFileSync(nativeBin, process.argv.slice(2), { stdio: 'inherit' }); process.exit(0) }
  catch (err) { process.exit(err.status || 1) }
} else if (fs.existsSync(cliMjs)) {
  try { childProcess.execFileSync(process.execPath, [cliMjs].concat(process.argv.slice(2)), { stdio: 'inherit' }); process.exit(0) }
  catch (err) { process.exit(err.status || 1) }
} else {
  console.error('Error: ola-cc not found. Run: node install.cjs')
  process.exit(1)
}
