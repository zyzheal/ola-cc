import { describe, expect, it, beforeEach } from "bun:test"
import {
  SemanticSearchEngine,
  cosineSimilarity,
  rrfFuse,
  nodeToEmbeddingText,
} from "../SemanticSearch.js"
import { InMemoryVectorStore } from "../VectorStore.js"
import { MockEmbeddingProvider } from "../EmbeddingProvider.js"
import type { NodeMetadata } from "../GraphStore.js"

// ─── Test Data ────────────────────────────────────────────────────

const nodes: NodeMetadata[] = [
  {
    id: "n1",
    name: "GraphEngine",
    kind: "class",
    file: "src/services/graph/GraphEngine.ts",
    language: "typescript",
    is_exported: true,
    signature: "class GraphEngine",
    line_start: 1,
    line_end: 500,
    visibility: "public",
    num_methods: 15,
    num_fields: 3,
    cyclomatic_complexity: 45,
    num_parameters: 0,
    is_async: false,
    is_abstract: false,
    is_static: false,
    source_hash: "abc123",
    last_modified: Date.now(),
    confidence: 0.95,
    community_id: 0,
    layer: "core",
    domain: "graph",
  },
  {
    id: "n2",
    name: "GraphStore",
    kind: "class",
    file: "src/services/graph/GraphStore.ts",
    language: "typescript",
    is_exported: true,
    signature: "class GraphStore",
    line_start: 1,
    line_end: 300,
    visibility: "public",
    num_methods: 10,
    num_fields: 5,
    cyclomatic_complexity: 20,
    num_parameters: 0,
    is_async: false,
    is_abstract: false,
    is_static: false,
    source_hash: "def456",
    last_modified: Date.now(),
    confidence: 0.9,
    community_id: 0,
    layer: "core",
    domain: "graph",
  },
  {
    id: "n3",
    name: "cosineSimilarity",
    kind: "function",
    file: "src/services/graph/SemanticSearch.ts",
    language: "typescript",
    is_exported: true,
    signature: "function cosineSimilarity(a: number[], b: number[]): number",
    line_start: 14,
    line_end: 30,
    visibility: "public",
    num_methods: 0,
    num_fields: 0,
    cyclomatic_complexity: 3,
    num_parameters: 2,
    is_async: false,
    is_abstract: false,
    is_static: false,
    source_hash: "ghi789",
    last_modified: Date.now(),
    confidence: 1.0,
    community_id: 1,
    layer: "search",
    domain: "search",
  },
]

const embeddings: Record<string, number[]> = {
  n1: [1, 0, 0, 0],
  n2: [0.9, 0.1, 0, 0],
  n3: [0, 0, 1, 0],
}

// ─── Tests ────────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1)
  })

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0)
  })

  it("returns high similarity for similar vectors", () => {
    const sim = cosineSimilarity([1, 0, 0], [0.9, 0.1, 0])
    expect(sim).toBeGreaterThan(0.9)
  })

  it("handles zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0)
  })

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow("dimension mismatch")
  })

  it("handles empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it("clamps result to [-1, 1]", () => {
    // Floating point edge case
    const sim = cosineSimilarity([1, 0, 0], [1, 0, 0])
    expect(sim).toBeLessThanOrEqual(1)
    expect(sim).toBeGreaterThanOrEqual(-1)
  })
})

describe("SemanticSearchEngine", () => {
  it("returns results sorted by similarity", () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    const queryEmbedding = [1, 0, 0, 0]
    const results = engine.search(queryEmbedding)
    expect(results[0].nodeId).toBe("n1")
    // n2 is also similar (0.9 cosine sim)
    expect(results[1].nodeId).toBe("n2")
  })

  it("respects limit parameter", () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    const results = engine.search([1, 0, 0, 0], { limit: 2 })
    expect(results).toHaveLength(2)
  })

  it("respects threshold parameter", () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    // threshold is on similarity (not score)
    const results = engine.search([1, 0, 0, 0], { threshold: 0.5 })
    const ids = results.map((r) => r.nodeId)
    // n3 has 0 similarity to query, should be filtered
    expect(ids).not.toContain("n3")
  })

  it("filters by node kind", () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    const results = engine.search([1, 0, 0, 0], { types: ["function"] })
    expect(results).toHaveLength(1)
    expect(results[0].nodeId).toBe("n3")
  })

  it("returns empty for nodes without embeddings", () => {
    const engine = new SemanticSearchEngine(nodes, {})
    const results = engine.search([1, 0, 0, 0])
    expect(results).toHaveLength(0)
  })

  it("hasEmbeddings returns true when embeddings exist", () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    expect(engine.hasEmbeddings()).toBe(true)
  })

  it("hasEmbeddings returns false when empty", () => {
    const engine = new SemanticSearchEngine(nodes, {})
    expect(engine.hasEmbeddings()).toBe(false)
  })

  it("addEmbedding updates the search index", () => {
    const engine = new SemanticSearchEngine(nodes, {})
    expect(engine.hasEmbeddings()).toBe(false)
    engine.addEmbedding("n1", [1, 0, 0, 0])
    expect(engine.hasEmbeddings()).toBe(true)
  })

  it("score is always in [0, 1] range", () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    const results = engine.search([1, 0, 0, 0])
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0)
      expect(r.score).toBeLessThanOrEqual(1)
    }
  })

  it("updateNodes cleans orphan embeddings", () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    expect(engine.getEmbeddingCount()).toBe(3)

    // Remove n3 from nodes
    engine.updateNodes(nodes.filter((n) => n.id !== "n3"))
    expect(engine.getEmbeddingCount()).toBe(2)
    expect(engine.getEmbedding("n3")).toBeUndefined()
  })

  it("getEmbedding returns embedding for known node", () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    const emb = engine.getEmbedding("n1")
    expect(emb).toEqual([1, 0, 0, 0])
  })

  it("getEmbedding returns undefined for unknown node", () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    expect(engine.getEmbedding("unknown")).toBeUndefined()
  })
})

describe("SemanticSearchEngine with VectorStore", () => {
  it("persists and loads embeddings", async () => {
    const store = new InMemoryVectorStore()
    await store.init(4)

    // Store embeddings
    await store.put("n1", [1, 0, 0, 0])
    await store.put("n2", [0.9, 0.1, 0, 0])

    // Create engine and load from store
    const engine = new SemanticSearchEngine(nodes, {}, null, store)
    const loaded = await engine.loadFromStore()
    expect(loaded).toBe(2)
    expect(engine.hasEmbeddings()).toBe(true)

    // Search should work
    const results = engine.search([1, 0, 0, 0])
    expect(results[0].nodeId).toBe("n1")
  })

  it("knn search works", async () => {
    const store = new InMemoryVectorStore()
    await store.init(4)

    await store.put("n1", [1, 0, 0, 0])
    await store.put("n2", [0.9, 0.1, 0, 0])
    await store.put("n3", [0, 0, 1, 0])

    const results = await store.knn([1, 0, 0, 0], 2)
    expect(results).toHaveLength(2)
    expect(results[0].nodeId).toBe("n1")
    expect(results[0].distance).toBeCloseTo(0)
  })
})

describe("SemanticSearchEngine with EmbeddingProvider", () => {
  it("generates missing embeddings", async () => {
    const provider = new MockEmbeddingProvider(4)
    const engine = new SemanticSearchEngine(nodes, {}, provider)

    const generated = await engine.generateMissingEmbeddings()
    expect(generated).toBe(3)
    expect(engine.getEmbeddingCount()).toBe(3)
    expect(engine.hasEmbeddings()).toBe(true)
  })

  it("searchByText works", async () => {
    const provider = new MockEmbeddingProvider(4)
    const engine = new SemanticSearchEngine(
      nodes,
      {
        n1: [1, 0, 0, 0],
        n2: [0.9, 0.1, 0, 0],
        n3: [0, 0, 1, 0],
      },
      provider,
    )

    const results = await engine.searchByText("graph engine algorithm")
    expect(results.length).toBeGreaterThan(0)
  })

  it("searchByText throws without provider", async () => {
    const engine = new SemanticSearchEngine(nodes, embeddings)
    expect(engine.searchByText("test")).rejects.toThrow("No EmbeddingProvider")
  })
})

describe("nodeToEmbeddingText", () => {
  it("extracts text from node metadata", () => {
    const text = nodeToEmbeddingText(nodes[0])
    expect(text).toContain("GraphEngine")
    expect(text).toContain("class")
    expect(text).toContain("typescript")
    expect(text).toContain("exported")
  })
})

describe("rrfFuse", () => {
  it("fuses two result sets", () => {
    const set1 = [
      { nodeId: "a", score: 0 },
      { nodeId: "b", score: 0.5 },
      { nodeId: "c", score: 0.8 },
    ]
    const set2 = [
      { nodeId: "b", score: 0 },
      { nodeId: "a", score: 0.3 },
      { nodeId: "d", score: 0.7 },
    ]

    const fused = rrfFuse([set1, set2])
    // a and b both appear in top positions of both sets
    expect(fused[0].nodeId).toBe("a")
    expect(fused[1].nodeId).toBe("b")
  })

  it("handles empty result sets", () => {
    const fused = rrfFuse([[], []])
    expect(fused).toHaveLength(0)
  })

  it("handles single result set", () => {
    const set1 = [
      { nodeId: "a", score: 0 },
      { nodeId: "b", score: 0.5 },
    ]
    const fused = rrfFuse([set1])
    expect(fused).toHaveLength(2)
    expect(fused[0].nodeId).toBe("a")
  })

  it("k parameter affects ranking", () => {
    const set1 = [
      { nodeId: "a", score: 0 },
      { nodeId: "b", score: 0.5 },
    ]
    const set2 = [
      { nodeId: "b", score: 0 },
      { nodeId: "a", score: 0.5 },
    ]

    // With k=1, rank differences matter more
    const fused1 = rrfFuse([set1, set2], 1)
    // Both have same total RRF: a gets rank1+rank2, b gets rank1+rank2
    expect(fused1[0].nodeId).toBe("a") // a has better score in set1

    // With k=1000, rank differences matter less
    const fused2 = rrfFuse([set1, set2], 1000)
    // Results are nearly tied
    expect(fused2).toHaveLength(2)
  })
})
