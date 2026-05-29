import type { BM25Result } from './bm25'

/**
 * Reciprocal Rank Fusion
 *
 * RRF_score(d) = Σ 1 / (k + rank_i(d))
 *
 * @param scoreMaps 多个检索器的原始评分结果（value 为相关度分数，非排名序号）
 *                  函数内部会将 score 降序转换为 rank（1-based），再计算 RRF
 * @param k 平滑常数，默认 60（Cormack et al. 2009 推荐值）
 */
export function reciprocalRankFusion(
  scoreMaps: Array<Map<string, number>>,
  k: number = 60,
): BM25Result[] {
  const rrfScores = new Map<string, number>()

  for (const scoreMap of scoreMaps) {
    // Convert scores to ranks (1-based, highest score = rank 1)
    const sorted = [...scoreMap.entries()].sort((a, b) => b[1] - a[1])
    sorted.forEach(([docId], index) => {
      const rank = index + 1
      const current = rrfScores.get(docId) ?? 0
      rrfScores.set(docId, current + 1 / (k + rank))
    })
  }

  return [...rrfScores.entries()]
    .map(([docId, score]) => ({ docId, score, matchedTerms: [] }))
    .sort((a, b) => b.score - a.score)
}

/**
 * 向量锚定融合（为未来向量检索预留）
 *
 * final_score = α * vec_score + (1-α) * saturate(bm25_score)
 * saturate(x) = x / (x + k)
 */
export function vectorAnchoredFusion(
  vecScores: Map<string, number>,
  bm25Scores: Map<string, number>,
  alpha: number = 0.7,
  k: number = 60,
): BM25Result[] {
  const allDocs = new Set([...vecScores.keys(), ...bm25Scores.keys()])
  const results: BM25Result[] = []

  for (const docId of allDocs) {
    const vecScore = vecScores.get(docId) ?? 0
    const bm25Score = bm25Scores.get(docId) ?? 0
    const saturated = bm25Score / (bm25Score + k)
    const finalScore = alpha * vecScore + (1 - alpha) * saturated
    results.push({ docId, score: finalScore, matchedTerms: [] })
  }

  return results.sort((a, b) => b.score - a.score)
}
