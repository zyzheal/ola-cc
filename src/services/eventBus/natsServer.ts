// src/services/eventBus/natsServer.ts

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { logForDebugging } from '../../utils/debug.js'

export type NatsServerProcess = {
  process: ChildProcess
  port: number
  host: string
}

let natsServer: NatsServerProcess | null = null

const NATS_SERVER_VERSION = '2.10.25'
const NATS_BINARY_NAME = process.platform === 'win32' ? 'nats-server.exe' : 'nats-server'

export async function startLocalNatsServer(port = 4222): Promise<NatsServerProcess> {
  if (natsServer) return natsServer

  const binaryPath = await findOrDownloadNatsServer()

  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath, [
      '-p', String(port),
      '-js',  // Enable JetStream
      '--log', '/tmp/nats-server.log',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    proc.stdout?.on('data', (data) => {
      const output = data.toString()
      if (output.includes('Listening for client connections')) {
        logForDebugging(`NATS server started on port ${port}`)
      }
    })

    proc.stderr?.on('data', (data) => {
      logForDebugging(`NATS: ${data.toString()}`)
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to start NATS server: ${err.message}`))
    })

    // Wait for server to be ready
    setTimeout(() => {
      natsServer = { process: proc, port, host: 'localhost' }
      resolve(natsServer)
    }, 2000)
  })
}

export function stopLocalNatsServer(): void {
  if (natsServer) {
    natsServer.process.kill('SIGTERM')
    natsServer = null
    logForDebugging('NATS server stopped')
  }
}

export function isLocalNatsRunning(): boolean {
  return natsServer !== null
}

async function findOrDownloadNatsServer(): Promise<string> {
  // Check local system first
  const paths = [
    join(process.cwd(), '.nats', NATS_BINARY_NAME),
    join(process.env.HOME || '', '.nats', NATS_BINARY_NAME),
    '/usr/local/bin/nats-server',
    '/opt/homebrew/bin/nats-server',
  ]

  for (const path of paths) {
    if (existsSync(path)) return path
  }

  // Download if not found
  return await downloadNatsServer()
}

async function downloadNatsServer(): Promise<string> {
  const installDir = join(process.cwd(), '.nats')
  const binaryPath = join(installDir, NATS_BINARY_NAME)

  if (existsSync(binaryPath)) return binaryPath

  mkdirSync(installDir, { recursive: true })

  const platform = process.platform === 'darwin' ? 'darwin' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const url = `https://github.com/nats-io/nats-server/releases/download/v${NATS_SERVER_VERSION}/nats-server-v${NATS_SERVER_VERSION}-${platform}-${arch}.tar.gz`

  logForDebugging(`Downloading NATS server from ${url}`)

  const { execa } = await import('execa')
  await execa('curl', ['-sL', url, '-o', join(installDir, 'nats-server.tar.gz')])
  await execa('tar', ['-xzf', join(installDir, 'nats-server.tar.gz'), '-C', installDir])

  // Move binary from extracted directory
  const extractedDir = `nats-server-v${NATS_SERVER_VERSION}-${platform}-${arch}`
  await execa('mv', [
    join(installDir, extractedDir, NATS_BINARY_NAME),
    binaryPath,
  ])

  // Cleanup
  await execa('rm', ['-rf', join(installDir, 'nats-server.tar.gz')])
  await execa('rm', ['-rf', join(installDir, extractedDir)])

  return binaryPath
}
