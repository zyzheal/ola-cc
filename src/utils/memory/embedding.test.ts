import { describe, it, expect } from 'bun:test'
import { cosineSimilarity, getEmbeddingDim } from './embedding'

describe('Embedding', () => {
  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([1, 0, 0])
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5)
    })

    it('should return 0 for orthogonal vectors', () => {
      const a = new Float32Array([1, 0, 0])
      const b = new Float32Array([0, 1, 0])
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5)
    })

    it('should return -1 for opposite vectors', () => {
      const a = new Float32Array([1, 0])
      const b = new Float32Array([-1, 0])
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5)
    })

    it('should handle zero vectors', () => {
      const a = new Float32Array([0, 0, 0])
      const b = new Float32Array([1, 2, 3])
      expect(cosineSimilarity(a, b)).toBe(0)
    })

    it('should return 0 for different length vectors', () => {
      const a = new Float32Array([1, 0])
      const b = new Float32Array([1, 0, 0])
      expect(cosineSimilarity(a, b)).toBe(0)
    })

    it('should compute similarity for non-unit vectors', () => {
      const a = new Float32Array([3, 4])
      const b = new Float32Array([6, 8])
      // Same direction, different magnitude → similarity = 1
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5)
    })
  })

  describe('getEmbeddingDim', () => {
    it('should return 384 for all-MiniLM-L6-v2', () => {
      expect(getEmbeddingDim()).toBe(384)
    })
  })
})
