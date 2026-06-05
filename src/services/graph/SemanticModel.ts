/**
 * SemanticModel — 三层符号注册表 (F-98)
 *
 * 从 GraphStore 构建按类型（type/method/field）分层的符号索引，
 * 支持限定名查找和按类型批量查询。
 *
 * 设计文档: Phase Z2 — SemanticModel
 */

import type { GraphStore, NodeMetadata } from './GraphStore.js'

// ============================================================
// Types
// ============================================================

export type SymbolKind = 'type' | 'method' | 'field'

export interface SemanticSymbol {
  id: string
  name: string
  kind: SymbolKind
  qualifiedName: string
  file: string
  line: number
  signature?: string
  layer?: string
  domain?: string
}

// ============================================================
// Kind classification
// ============================================================

/** 将 NodeMetadata.kind 映射到 SemanticSymbol.kind */
function classifyKind(nodeKind: string): SymbolKind {
  const lower = nodeKind.toLowerCase()

  // Type-like: class, interface, struct, enum, type
  if (
    lower === 'class' ||
    lower === 'interface' ||
    lower === 'struct' ||
    lower === 'enum' ||
    lower === 'type' ||
    lower === 'trait' ||
    lower === 'protocol'
  ) {
    return 'type'
  }

  // Method-like: method, function, constructor, accessor
  if (
    lower === 'method' ||
    lower === 'function' ||
    lower === 'constructor' ||
    lower === 'getter' ||
    lower === 'setter' ||
    lower === 'operator' ||
    lower === 'lambda' ||
    lower === 'closure'
  ) {
    return 'method'
  }

  // Field-like: field, property, variable, constant
  if (
    lower === 'field' ||
    lower === 'property' ||
    lower === 'variable' ||
    lower === 'constant' ||
    lower === 'parameter'
  ) {
    return 'field'
  }

  // Default: treat unknown kinds as field
  return 'field'
}

// ============================================================
// SemanticModel
// ============================================================

export class SemanticModel {
  private types = new Map<string, SemanticSymbol>()
  private methods = new Map<string, SemanticSymbol>()
  private fields = new Map<string, SemanticSymbol>()

  /** 限定名 → 符号的反向索引 */
  private qualifiedIndex = new Map<string, SemanticSymbol>()

  /**
   * 注册一个符号到对应的层
   */
  register(symbol: SemanticSymbol): void {
    switch (symbol.kind) {
      case 'type':
        this.types.set(symbol.id, symbol)
        break
      case 'method':
        this.methods.set(symbol.id, symbol)
        break
      case 'field':
        this.fields.set(symbol.id, symbol)
        break
    }

    // 构建限定名索引
    if (symbol.qualifiedName) {
      this.qualifiedIndex.set(symbol.qualifiedName, symbol)
    }
  }

  /**
   * 通过限定名查找符号
   */
  lookup(qualifiedName: string): SemanticSymbol | undefined {
    return this.qualifiedIndex.get(qualifiedName)
  }

  /**
   * 按类型获取所有符号
   */
  lookupByKind(kind: SymbolKind): SemanticSymbol[] {
    switch (kind) {
      case 'type':
        return [...this.types.values()]
      case 'method':
        return [...this.methods.values()]
      case 'field':
        return [...this.fields.values()]
    }
  }

  /**
   * 按文件路径获取符号
   */
  lookupByFile(filePath: string): SemanticSymbol[] {
    const results: SemanticSymbol[] = []
    const search = (map: Map<string, SemanticSymbol>) => {
      for (const symbol of map.values()) {
        if (symbol.file === filePath) {
          results.push(symbol)
        }
      }
    }
    search(this.types)
    search(this.methods)
    search(this.fields)
    return results
  }

  /**
   * 按名称模糊搜索符号（精确匹配 name 字段）
   */
  lookupByName(name: string): SemanticSymbol[] {
    const results: SemanticSymbol[] = []
    const search = (map: Map<string, SemanticSymbol>) => {
      for (const symbol of map.values()) {
        if (symbol.name === name) {
          results.push(symbol)
        }
      }
    }
    search(this.types)
    search(this.methods)
    search(this.fields)
    return results
  }

  /**
   * 从 GraphStore 构建完整符号表
   */
  buildFromStore(store: GraphStore): void {
    this.clear()

    for (const node of store.nodeMeta.values()) {
      const kind = classifyKind(node.kind)
      const symbol: SemanticSymbol = {
        id: node.id,
        name: node.name,
        kind,
        qualifiedName: node.qualified_name ?? `${node.file}:${node.name}`,
        file: node.file,
        line: node.line,
        signature: node.signature,
        layer: node.layer,
        domain: node.domain,
      }
      this.register(symbol)
    }
  }

  /**
   * 从 NodeMetadata 数组构建符号表（不依赖 GraphStore 实例）
   */
  buildFromNodes(nodes: NodeMetadata[]): void {
    this.clear()

    for (const node of nodes) {
      const kind = classifyKind(node.kind)
      const symbol: SemanticSymbol = {
        id: node.id,
        name: node.name,
        kind,
        qualifiedName: node.qualified_name ?? `${node.file}:${node.name}`,
        file: node.file,
        line: node.line,
        signature: node.signature,
        layer: node.layer,
        domain: node.domain,
      }
      this.register(symbol)
    }
  }

  /**
   * 清空所有符号
   */
  clear(): void {
    this.types.clear()
    this.methods.clear()
    this.fields.clear()
    this.qualifiedIndex.clear()
  }

  /**
   * 符号总数
   */
  get size(): number {
    return this.types.size + this.methods.size + this.fields.size
  }

  /**
   * 各层大小
   */
  get layerSizes(): { types: number; methods: number; fields: number } {
    return {
      types: this.types.size,
      methods: this.methods.size,
      fields: this.fields.size,
    }
  }
}
