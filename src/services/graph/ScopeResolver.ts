/**
 * ScopeResolver — 4 阶段符号解析管道 (F-99)
 *
 * Stage 1: 构建文件级 import map
 * Stage 2: 文件内作用域解析
 * Stage 3: 跨文件 import 链解析
 * Stage 4: 全局回退 + 置信度评分
 *
 * 设计文档: Phase Z2 — Scope Resolution Pipeline
 */

import type { GraphStore, NodeMetadata } from './GraphStore.js'
import { SemanticModel, type SemanticSymbol } from './SemanticModel.js'

// ============================================================
// Types
// ============================================================

export interface ScopeContext {
  file: string
  line: number
  symbol: string
  imports: Map<string, string>  // local name → source file
}

export interface ResolvedScope {
  symbol: string
  definition: { file: string; line: number }
  references: Array<{ file: string; line: number }>
  exports: Array<{ file: string; name: string }>
  confidence: number  // 0.0 ~ 1.0
}

// ============================================================
// ScopeResolver
// ============================================================

export class ScopeResolver {
  constructor(
    private store: GraphStore,
    private model: SemanticModel,
  ) {}

  /**
   * Stage 1: 构建文件级 import map
   *
   * 从 GraphStore 的 adjacency 中提取所有 imports 边，
   * 返回 localName → sourceFile 的映射。
   */
  buildImportMap(filePath: string): Map<string, string> {
    const importMap = new Map<string, string>()
    const outEdges = this.store.getOutEdges(filePath)

    for (const [targetId, edges] of outEdges) {
      const hasImport = edges.some(e => e.type === 'imports')
      if (!hasImport) continue

      // target 可能是文件路径或节点 ID
      const targetNode = this.store.getNode(targetId)
      const sourceFile = targetNode?.file ?? targetId

      // 用目标节点的 name 作为 localName
      if (targetNode?.name) {
        importMap.set(targetNode.name, sourceFile)
      }

      // 也索引文件名（不含路径前缀）
      const baseName = sourceFile.split('/').pop()?.replace(/\.[^.]+$/, '')
      if (baseName) {
        importMap.set(baseName, sourceFile)
      }
    }

    // 也从节点 ID 中提取文件级别的 imports
    const fileNode = this.store.getNode(filePath)
    if (fileNode) {
      const fileEdges = this.store.getOutEdges(fileNode.id)
      for (const [targetId, edges] of fileEdges) {
        const hasImport = edges.some(e => e.type === 'imports')
        if (!hasImport) continue
        const targetNode = this.store.getNode(targetId)
        if (targetNode?.name) {
          importMap.set(targetNode.name, targetNode.file)
        }
      }
    }

    return importMap
  }

  /**
   * Stage 2: 在文件内作用域中解析符号
   *
   * 查找同一文件中定义的符号，返回最近的定义。
   */
  resolveInFile(symbol: string, filePath: string): ResolvedScope | null {
    // 从 SemanticModel 中查找同文件、同名的符号
    const candidates = this.model.lookupByName(symbol)
    const sameFile = candidates.filter(c => c.file === filePath)

    if (sameFile.length === 0) return null

    // 选择最近的定义（按行号）
    sameFile.sort((a, b) => a.line - b.line)

    // 收集同文件中的所有引用
    const references = sameFile.map(c => ({ file: c.file, line: c.line }))

    // 收集 exports
    const exports = this.findExports(symbol)

    return {
      symbol,
      definition: { file: sameFile[0].file, line: sameFile[0].line },
      references,
      exports,
      confidence: 1.0,
    }
  }

  /**
   * Stage 3: 通过 import 链跨文件解析
   *
   * 先构建 import map，再在导入的文件中查找符号定义。
   */
  resolveCrossFile(symbol: string, filePath: string): ResolvedScope | null {
    const importMap = this.buildImportMap(filePath)

    // 1. 检查 import map 中是否有直接匹配
    const importedFile = importMap.get(symbol)
    if (importedFile) {
      const candidates = this.model.lookupByName(symbol)
      const inImported = candidates.filter(c => c.file === importedFile)

      if (inImported.length > 0) {
        const references = inImported.map(c => ({ file: c.file, line: c.line }))
        const exports = this.findExports(symbol)

        return {
          symbol,
          definition: { file: inImported[0].file, line: inImported[0].line },
          references,
          exports,
          confidence: 0.9,
        }
      }
    }

    // 2. 在所有导入的文件中搜索
    for (const [, sourceFile] of importMap) {
      const candidates = this.model.lookupByName(symbol)
      const inSource = candidates.filter(c => c.file === sourceFile)

      if (inSource.length > 0) {
        const references = inSource.map(c => ({ file: c.file, line: c.line }))
        const exports = this.findExports(symbol)

        return {
          symbol,
          definition: { file: inSource[0].file, line: inSource[0].line },
          references,
          exports,
          confidence: 0.7,
        }
      }
    }

    return null
  }

  /**
   * Stage 4: 完整解析管道
   *
   * 依次尝试：文件内 → 跨文件 → 全局回退
   */
  resolve(symbol: string, filePath: string): ResolvedScope {
    // Stage 2: 文件内
    const inFile = this.resolveInFile(symbol, filePath)
    if (inFile) return inFile

    // Stage 3: 跨文件
    const crossFile = this.resolveCrossFile(symbol, filePath)
    if (crossFile) return crossFile

    // Stage 4: 全局回退 — 在整个模型中搜索
    const globalCandidates = this.model.lookupByName(symbol)
    if (globalCandidates.length > 0) {
      // 按文件分组，选择定义最多的文件
      const byFile = new Map<string, SemanticSymbol[]>()
      for (const c of globalCandidates) {
        const arr = byFile.get(c.file) ?? []
        arr.push(c)
        byFile.set(c.file, arr)
      }

      // 优先选择 type kind（类/接口），其次 method，最后 field
      const sorted = globalCandidates.sort((a, b) => {
        const kindPriority: Record<string, number> = { type: 0, method: 1, field: 2 }
        return (kindPriority[a.kind] ?? 3) - (kindPriority[b.kind] ?? 3)
      })

      const best = sorted[0]
      const references = globalCandidates.map(c => ({ file: c.file, line: c.line }))
      const exports = this.findExports(symbol)

      return {
        symbol,
        definition: { file: best.file, line: best.line },
        references,
        exports,
        confidence: 0.3,
      }
    }

    // 完全未找到
    return {
      symbol,
      definition: { file: filePath, line: 0 },
      references: [],
      exports: [],
      confidence: 0,
    }
  }

  // ----------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------

  /**
   * 查找符号的所有导出位置
   */
  private findExports(symbol: string): Array<{ file: string; name: string }> {
    const results: Array<{ file: string; name: string }> = []
    const candidates = this.model.lookupByName(symbol)

    for (const c of candidates) {
      // 查找所有 exports 边
      const outEdges = this.store.getAllOutEdges(c.id)
      for (const { target, edge } of outEdges) {
        if (edge.type === 'exports') {
          const targetNode = this.store.getNode(target)
          results.push({
            file: targetNode?.file ?? target,
            name: targetNode?.name ?? symbol,
          })
        }
      }

      // 也检查节点的 is_exported 标记
      const nodeMeta = this.store.getNode(c.id)
      if (nodeMeta?.is_exported) {
        results.push({ file: c.file, name: c.name })
      }
    }

    return results
  }
}
