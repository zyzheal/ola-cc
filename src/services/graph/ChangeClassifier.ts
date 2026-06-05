/**
 * ChangeClassifier — 文件变更分类器 (F-22)
 *
 * 将文件变更分为 4 种类型，确定需要的图操作:
 *   signature_change   → 重建调用图
 *   import_change      → 更新依赖边
 *   implementation_change → 仅更新节点
 *   comment_change     → 无需重建
 *
 * 优先级: signature > import > implementation > comment
 */

export type ChangeType =
  | 'signature_change'
  | 'implementation_change'
  | 'import_change'
  | 'comment_change'

export interface ClassificationResult {
  changeType: ChangeType
  file: string
  details: string
  affectedNodes: string[]
  requiresRebuild: boolean
}

export interface NodeSnapshot {
  id: string
  name: string
  kind: string
  signature?: string
  startLine: number
  endLine: number
  docstring?: string
}

export interface EdgeSnapshot {
  from: string
  to: string
  kind: string
}

// 优先级数值（越高越优先）
const CHANGE_PRIORITY: Record<ChangeType, number> = {
  signature_change: 4,
  import_change: 3,
  implementation_change: 2,
  comment_change: 1,
}

export class ChangeClassifier {
  classify(
    file: string,
    oldNodes: NodeSnapshot[],
    newNodes: NodeSnapshot[],
    oldEdges: EdgeSnapshot[],
    newEdges: EdgeSnapshot[],
  ): ClassificationResult {
    const affectedNodes: string[] = []
    const detectedTypes: ChangeType[] = []

    // 构建 id → node 映射
    const oldMap = new Map(oldNodes.map((n) => [n.id, n]))
    const newMap = new Map(newNodes.map((n) => [n.id, n]))

    // 1. 检测节点增删
    for (const id of newMap.keys()) {
      if (!oldMap.has(id)) {
        affectedNodes.push(id)
        detectedTypes.push('signature_change')
      }
    }
    for (const id of oldMap.keys()) {
      if (!newMap.has(id)) {
        affectedNodes.push(id)
        detectedTypes.push('signature_change')
      }
    }

    // 2. 检测节点变更（只比较两边都存在的节点）
    for (const [id, oldNode] of oldMap) {
      const newNode = newMap.get(id)
      if (!newNode) continue

      // 签名变更
      if (oldNode.signature !== newNode.signature) {
        affectedNodes.push(id)
        detectedTypes.push('signature_change')
        continue
      }

      // 边变更分析（按边类型分类）
      const oldNodeEdges = oldEdges.filter(
        (e) => e.from === id || e.to === id,
      )
      const newNodeEdges = newEdges.filter(
        (e) => e.from === id || e.to === id,
      )

      if (oldNodeEdges.length !== newNodeEdges.length) {
        affectedNodes.push(id)
        // 区分 import 变更和 call 变更
        const hasImportChange = this.hasEdgeKindChange(
          oldNodeEdges,
          newNodeEdges,
          'imports',
        )
        const hasCallChange = this.hasEdgeKindChange(
          oldNodeEdges,
          newNodeEdges,
          'calls',
        ) || this.hasEdgeKindChange(oldNodeEdges, newNodeEdges, 'contains')

        if (hasCallChange) {
          detectedTypes.push('signature_change')
        } else if (hasImportChange) {
          detectedTypes.push('import_change')
        } else {
          detectedTypes.push('implementation_change')
        }
        continue
      }

      // 边内容变更
      const oldEdgeSet = new Set(
        oldNodeEdges.map((e) => `${e.from}->${e.to}:${e.kind}`),
      )
      const newEdgeSet = new Set(
        newNodeEdges.map((e) => `${e.from}->${e.to}:${e.kind}`),
      )
      const edgesChanged =
        oldEdgeSet.size !== newEdgeSet.size ||
        ![...oldEdgeSet].every((e) => newEdgeSet.has(e))

      if (edgesChanged) {
        affectedNodes.push(id)
        const hasImportChange =
          this.hasEdgeKindChange(oldNodeEdges, newNodeEdges, 'imports')
        const hasCallChange =
          this.hasEdgeKindChange(oldNodeEdges, newNodeEdges, 'calls') ||
          this.hasEdgeKindChange(oldNodeEdges, newNodeEdges, 'contains')

        if (hasCallChange) {
          detectedTypes.push('signature_change')
        } else if (hasImportChange) {
          detectedTypes.push('import_change')
        } else {
          detectedTypes.push('implementation_change')
        }
        continue
      }

      // docstring 变更
      if (oldNode.docstring !== newNode.docstring) {
        affectedNodes.push(id)
        detectedTypes.push('comment_change')
        continue
      }

      // 行号变更
      if (
        oldNode.startLine !== newNode.startLine ||
        oldNode.endLine !== newNode.endLine
      ) {
        affectedNodes.push(id)
        detectedTypes.push('implementation_change')
      }
    }

    // 选择最高优先级类型
    const changeType = this.highestPriority(detectedTypes)

    return {
      changeType,
      file,
      details: this.buildDetails(changeType, affectedNodes),
      affectedNodes: [...new Set(affectedNodes)],
      requiresRebuild: changeType === 'signature_change',
    }
  }

  private hasEdgeKindChange(
    oldEdges: EdgeSnapshot[],
    newEdges: EdgeSnapshot[],
    kind: string,
  ): boolean {
    const oldCount = oldEdges.filter((e) => e.kind === kind).length
    const newCount = newEdges.filter((e) => e.kind === kind).length
    return oldCount !== newCount
  }

  private highestPriority(types: ChangeType[]): ChangeType {
    if (types.length === 0) return 'implementation_change'
    return types.reduce((best, t) =>
      CHANGE_PRIORITY[t] > CHANGE_PRIORITY[best] ? t : best,
    )
  }

  private buildDetails(type: ChangeType, nodes: string[]): string {
    if (nodes.length === 0) return 'No changes detected'
    const unique = [...new Set(nodes)]
    const labels: Record<ChangeType, string> = {
      signature_change: 'Signature',
      import_change: 'Import',
      implementation_change: 'Implementation',
      comment_change: 'Comment',
    }
    return `${labels[type]} change in ${unique.length} node(s): ${unique.join(', ')}`
  }
}
