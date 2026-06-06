/**
 * CallbackSynthesizerTypes — 共享类型、正则、工具函数
 *
 * 从 codegraph/src/resolution/callback-synthesizer.ts 移植的共享基础设施。
 * Phase 6b: callback-synthesizer 完整移植 (11+3 种回调模式)
 */

import type { GraphStore, EdgeMeta, NodeMetadata, EdgeType } from './GraphStore.js'

// ============================================================
// Synthesized edge type (provenance 标记为 heuristic)
// ============================================================

export interface SynthesizedEdge {
  source: string
  target: string
  kind: EdgeType
  line?: number
  provenance: 'heuristic'
  metadata: Record<string, unknown>
}

// ============================================================
// Constants
// ============================================================

export const MAX_CALLBACKS_PER_CHANNEL = 40
export const EVENT_FANOUT_CAP = 6
export const MAX_JSX_CHILDREN = 30
export const CC_FANOUT_CAP = 8

// ============================================================
// Regex patterns (移植自 codegraph callback-synthesizer)
// ============================================================

export const REGISTRAR_NAME = /^(on[A-Z]\w*|subscribe|addListener|addEventListener|register|watch|listen|addCallback)$/
export const DISPATCHER_NAME = /(emit|trigger|notify|dispatch|fire|publish|flush)/i

export const ON_RE = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*(?:function\s+(\w+)|(?:this\.)?(\w+))/g
export const EMIT_RE = /\.(?:emit|fire|dispatchEvent)\(\s*['"]([^'"]+)['"]/g
export const SETSTATE_RE = /this\.setState\s*\(/
export const FLUTTER_SETSTATE_RE = /\bsetState\s*\(/
export const JSX_TAG_RE = /<([A-Z][A-Za-z0-9_]*)[\s/>]/g

// Vue SFC
export const VUE_KEBAB_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g
export const VUE_HANDLER_RE = /(?:@|v-on:)([a-zA-Z][\w-]*)(?:\.[\w]+)*\s*=\s*"([^"]+)"/g
export const VUE_DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(\w+)\s*\(/g

// Closure-collection
export const CC_DISPATCH_RE = /(\w+)\.forEach\s*\{\s*(?:\$0|it)\s*\(/g
export const CC_APPEND_WRITE_RE = /(\w+)\.write\s*\{\s*\$0(?:\.(\w+))?\.(?:append|add|push|insert)\s*\(/g
export const CC_APPEND_DIRECT_RE = /(\w+)\.(?:append|add|push|insert)\s*\(/g

// React Native
export const RN_OBJC_SEND_RE = /\bsendEventWithName\s*:\s*@"([^"]+)"/g
export const RN_SWIFT_SEND_RE = /\bsendEvent\s*\(\s*withName\s*:\s*"([^"]+)"/g
export const RN_JVM_EMIT_RE = /\.emit\s*\(\s*"([^"]+)"\s*,/g

// Fabric
export const FABRIC_NATIVE_SUFFIXES = ['', 'View', 'ViewManager', 'ComponentView', 'Manager']

// Gin
export const GIN_DISPATCH_RE = /\.handlers\s*\[[^\]]*\]\s*\(/
export const GIN_REG_RE = /\.(?:Use|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\s*\(/g

// Node kinds
export const FN_KINDS = new Set(['method', 'function', 'component'])

// ============================================================
// Adapter utilities
// ============================================================

export function kebabToPascal(s: string): string {
  return s.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

export function sliceLines(content: string, startLine?: number, endLine?: number): string | null {
  if (!startLine || !endLine) return null
  return content.split('\n').slice(startLine - 1, endLine).join('\n')
}

export function registrarField(src: string): string | null {
  const m = src.match(/this\.(\w+)\.(?:add|push|set)\(/)
  return m ? m[1]! : null
}

export function dispatcherField(src: string): string | null {
  const forOf = src.match(/\bof\s+(?:Array\.from\(\s*)?this\.(\w+)/)
  if (forOf && /\b\w+\s*\(/.test(src)) return forOf[1]!
  const forEach = src.match(/this\.(\w+)\.forEach\(/)
  if (forEach) return forEach[1]!
  return null
}

/** Innermost function/method node whose line range contains `line`. */
export function enclosingFn(nodesInFile: NodeMetadata[], line: number): NodeMetadata | null {
  let best: NodeMetadata | null = null
  for (const n of nodesInFile) {
    if (!FN_KINDS.has(n.kind)) continue
    const end = n.end_line ?? n.line
    if (n.line <= line && end >= line) {
      if (!best || n.line >= best.line) best = n
    }
  }
  return best
}

// ============================================================
// isGeneratedFile — 路径模式匹配
// ============================================================

const GENERATED_PATTERNS: ReadonlyArray<RegExp> = [
  /\.pb\.go$/, /\.pulsar\.go$/, /_grpc\.pb\.go$/,
  /_mock\.go$/, /_mocks\.go$/, /^mock_[^/]+\.go$/,
  /\.generated\.[jt]sx?$/, /\.gen\.[jt]sx?$/,
  /\.g\.dart$/, /_pb2\.py$/, /_pb2_grpc\.py$/,
  /\.pb\.cc$/, /\.pb\.h$/,
]

export function isGeneratedFile(filePath: string): boolean {
  return GENERATED_PATTERNS.some((p) => p.test(filePath))
}

// ============================================================
// stripCommentsForRegex — 简化版 (Go + JS/TS 支持)
// ============================================================

export function stripCommentsForRegex(content: string, lang: string): string {
  if (lang === 'go') {
    return content
      .replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length))
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  }
  // JS/TS
  return content
    .replace(/\/\/.*$/gm, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

// ============================================================
// Go helper functions (Gin middleware chain)
// ============================================================

export function goBalancedArgs(s: string, openIdx: number): string | null {
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return s.slice(openIdx + 1, i) }
  }
  return null
}

export function goSplitArgs(args: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const c of args) {
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c }
    else if (c === ')' || c === ']' || c === '}') { depth--; cur += c }
    else if (c === ',' && depth === 0) { out.push(cur); cur = '' }
    else cur += c
  }
  if (cur.trim()) out.push(cur)
  return out
}

export function goHandlerIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\(\s*\)$/, '')
  if (!cleaned || cleaned.startsWith('"') || cleaned.startsWith('`') || cleaned.startsWith('func')) return null
  const m = cleaned.match(/(?:\.|^)([A-Za-z_]\w*)$/)
  return m ? m[1]! : null
}

// ============================================================
// GraphStore adapter — 模拟 codegraph QueryBuilder 接口
// ============================================================

export class GraphStoreAdapter {
  constructor(private store: GraphStore) {}

  /** 获取指定 kind 的所有节点 */
  getNodesByKind(kind: string): NodeMetadata[] {
    const result: NodeMetadata[] = []
    for (const [, meta] of this.store.nodeMeta) {
      if (meta.kind === kind) result.push(meta)
    }
    return result
  }

  /** 按 ID 获取节点 */
  getNodeById(id: string): NodeMetadata | undefined {
    return this.store.nodeMeta.get(id)
  }

  /** 获取节点的出边（可选类型过滤） */
  getOutgoingEdges(nodeId: string, types?: EdgeType[]): Array<{ target: string; type: EdgeType; metadata?: Record<string, unknown> }> {
    const edges: Array<{ target: string; type: EdgeType; metadata?: Record<string, unknown> }> = []
    const fromMap = this.store.adjacency.get(nodeId)
    if (!fromMap) return edges
    for (const [target, metaArr] of fromMap) {
      for (const meta of metaArr) {
        if (!types || types.includes(meta.type)) {
          edges.push({ target, type: meta.type, metadata: meta.metadata })
        }
      }
    }
    return edges
  }

  /** 获取节点的入边（可选类型过滤） */
  getIncomingEdges(nodeId: string, types?: EdgeType[]): Array<{ source: string; type: EdgeType; line?: number; metadata?: Record<string, unknown> }> {
    const edges: Array<{ source: string; type: EdgeType; line?: number; metadata?: Record<string, unknown> }> = []
    const toMap = this.store.reverse.get(nodeId)
    if (!toMap) return edges
    for (const [source, metaArr] of toMap) {
      for (const meta of metaArr) {
        if (!types || types.includes(meta.type)) {
          edges.push({ source, type: meta.type, metadata: meta.metadata })
        }
      }
    }
    return edges
  }

  /** 按名称查找节点（需要线性扫描，构建 name index 优化） */
  getNodesByName(name: string): NodeMetadata[] {
    const result: NodeMetadata[] = []
    for (const [, meta] of this.store.nodeMeta) {
      if (meta.name === name) result.push(meta)
    }
    return result
  }

  /** 获取指定文件中的所有节点 */
  getNodesInFile(filePath: string): NodeMetadata[] {
    const result: NodeMetadata[] = []
    for (const [, meta] of this.store.nodeMeta) {
      if (meta.file === filePath) result.push(meta)
    }
    return result
  }

  /** 获取所有文件路径 */
  getAllFiles(): string[] {
    const files = new Set<string>()
    for (const [, meta] of this.store.nodeMeta) {
      files.add(meta.file)
    }
    return [...files]
  }

  /** 插入合成边 */
  insertSynthesizedEdges(edges: SynthesizedEdge[]): number {
    let count = 0
    for (const e of edges) {
      this.store.addEdge(e.source, e.target, e.kind, 1, 'INFERRED')
      count++
    }
    return count
  }
}
