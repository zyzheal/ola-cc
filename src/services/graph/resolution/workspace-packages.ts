/**
 * JS/TS workspace (monorepo) package resolution.
 *
 * Maps each member package's declared `name` to its directory so the
 * resolver can rewrite `@scope/ui/widgets` -> `packages/ui/widgets`.
 *
 * Migrated from codegraph/src/resolution/workspace-packages.ts.
 */

import * as fs from 'fs'
import * as path from 'path'
import { logForDebugging } from '../../../utils/debug.js'

export interface WorkspacePackages {
  /** Member package `name` -> directory relative to projectRoot (posix). */
  byName: Map<string, string>
}

/**
 * Load workspace member packages for `projectRoot`. Returns `null` when
 * the project declares no workspaces.
 */
export function loadWorkspacePackages(projectRoot: string): WorkspacePackages | null {
  const patterns = readWorkspaceGlobs(projectRoot)
  if (patterns.length === 0) return null

  const byName = new Map<string, string>()
  for (const pattern of patterns) {
    for (const dir of expandWorkspaceGlob(projectRoot, pattern)) {
      const pkgName = readPackageName(path.join(projectRoot, dir))
      if (pkgName && !byName.has(pkgName)) byName.set(pkgName, dir)
    }
  }
  if (byName.size === 0) return null

  logForDebugging('workspace packages loaded', { count: byName.size })
  return { byName }
}

/**
 * Rewrite a bare workspace import to a path relative to projectRoot.
 * Returns `null` when no member package name matches.
 */
export function resolveWorkspaceImport(
  importPath: string,
  ws: WorkspacePackages
): string | null {
  let bestName: string | null = null
  for (const name of ws.byName.keys()) {
    if (importPath === name || importPath.startsWith(name + '/')) {
      if (!bestName || name.length > bestName.length) bestName = name
    }
  }
  if (!bestName) return null
  const dir = ws.byName.get(bestName)!
  const subpath = importPath.slice(bestName.length)
  return (dir + subpath).replace(/\/{2,}/g, '/')
}

/** Read workspace glob patterns from package.json + pnpm-workspace.yaml. */
function readWorkspaceGlobs(projectRoot: string): string[] {
  const out: string[] = []

  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
    )
    const ws = pkg?.workspaces
    if (Array.isArray(ws)) {
      out.push(...ws.filter((w: unknown): w is string => typeof w === 'string'))
    } else if (ws && Array.isArray(ws.packages)) {
      out.push(...ws.packages.filter((w: unknown): w is string => typeof w === 'string'))
    }
  } catch {
    /* no / invalid package.json */
  }

  try {
    const yaml = fs.readFileSync(path.join(projectRoot, 'pnpm-workspace.yaml'), 'utf-8')
    out.push(...parsePnpmPackages(yaml))
  } catch {
    /* no pnpm-workspace.yaml */
  }

  return out
}

/**
 * Minimal pnpm-workspace.yaml `packages:` extractor.
 */
function parsePnpmPackages(yaml: string): string[] {
  const out: string[] = []
  const lines = yaml.split(/\r?\n/)
  let inPackages = false
  for (const line of lines) {
    if (/^\s*packages\s*:/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      const item = line.match(/^\s*-\s*(.+?)\s*$/)
      if (item) {
        out.push(item[1]!.replace(/^['"]|['"]$/g, ''))
        continue
      }
      if (line.trim() !== '' && !/^\s/.test(line)) inPackages = false
    }
  }
  return out
}

/** Expand one level of a `packages/*` / `apps/**` glob to member dirs. */
function expandWorkspaceGlob(projectRoot: string, pattern: string): string[] {
  const norm = pattern.replace(/\\/g, '/').replace(/\/+$/, '')
  const star = norm.indexOf('*')
  if (star === -1) return [norm]

  const base = norm.slice(0, star).replace(/\/+$/, '')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(projectRoot, base), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
    out.push(base ? `${base}/${e.name}` : e.name)
  }
  return out
}

/** Read the `name` field from a member directory's package.json. */
function readPackageName(dirAbs: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dirAbs, 'package.json'), 'utf-8'))
    return typeof pkg?.name === 'string' && pkg.name ? pkg.name : null
  } catch {
    return null
  }
}
