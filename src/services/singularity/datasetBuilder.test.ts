import { describe, it, expect, afterEach } from 'bun:test'
import { EvalDatasetManager, type EvalExample } from './evalDataset'
import * as fs from 'fs'

describe('EvalDatasetManager', () => {
  const tmpPath = '/tmp/test-eval-dataset.jsonl'

  afterEach(() => {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // ignore if file doesn't exist
    }
  })

  const makeExamples = (n: number): EvalExample[] =>
    Array.from({ length: n }, (_, i) => ({
      taskInput: `task-${i}`,
      expectedBehavior: `expected behavior for task ${i} with enough detail`,
      difficulty: (['easy', 'medium', 'hard'] as const)[i % 3],
      category: `cat-${i % 2}`,
      source: 'synthetic' as const,
    }))

  it('should split into train/val/holdout with correct ratios', () => {
    const examples = makeExamples(20)
    const dataset = EvalDatasetManager.split(examples)
    expect(dataset.train.length).toBe(10)
    expect(dataset.val.length).toBe(5)
    expect(dataset.holdout.length).toBe(5)
  })

  it('should handle small dataset gracefully', () => {
    const examples = makeExamples(3)
    const dataset = EvalDatasetManager.split(examples)
    expect(dataset.train.length + dataset.val.length + dataset.holdout.length).toBe(3)
  })

  it('should save and load dataset from JSONL roundtrip', async () => {
    const examples = makeExamples(10)
    const dataset = EvalDatasetManager.split(examples)
    EvalDatasetManager.save(dataset, tmpPath)
    const loaded = EvalDatasetManager.load(tmpPath)
    expect(loaded.train.length).toBe(dataset.train.length)
    expect(loaded.holdout.length).toBe(dataset.holdout.length)
    expect(loaded.train[0].taskInput).toBe(dataset.train[0].taskInput)
  })

  it('should return all empty arrays for empty dataset', () => {
    const dataset = EvalDatasetManager.split(makeExamples(0))
    expect(dataset.train.length).toBe(0)
    expect(dataset.val.length).toBe(0)
    expect(dataset.holdout.length).toBe(0)
  })

  it('should put single element into train with val and holdout empty', () => {
    const dataset = EvalDatasetManager.split(makeExamples(1))
    expect(dataset.train.length).toBe(1)
    expect(dataset.val.length).toBe(0)
    expect(dataset.holdout.length).toBe(0)
  })

  it('should return empty dataset when loading non-existent file', () => {
    const dataset = EvalDatasetManager.load('/tmp/does-not-exist-eval.jsonl')
    expect(dataset.train.length).toBe(0)
    expect(dataset.val.length).toBe(0)
    expect(dataset.holdout.length).toBe(0)
  })

  it('should mark passed=true when prediction contains expectedBehavior', () => {
    const examples = makeExamples(3)
    const dataset: import('./evalDataset').EvalDataset = {
      train: [],
      val: [],
      holdout: examples,
    }
    // prediction[0] contains expectedBehavior[0] substring
    const predictions = [
      `prefix ${examples[0].expectedBehavior} suffix`,
      'unrelated prediction',
      examples[2].expectedBehavior,
    ]
    const results = EvalDatasetManager.toTestResults(dataset, predictions)
    expect(results[0].passed).toBe(true)
    expect(results[1].passed).toBe(false)
    expect(results[2].passed).toBe(true)
  })

  it('should convert to test results format', () => {
    const examples = makeExamples(5)
    const predictions = ['pred1', 'pred2', 'pred3', 'pred4', 'pred5']
    const results = EvalDatasetManager.toTestResults(
      { train: examples, val: [], holdout: examples },
      predictions,
    )
    expect(results.length).toBe(5)
    expect(results[0]).toHaveProperty('passed')
    expect(results[0]).toHaveProperty('name')
    expect(results[0]).toHaveProperty('regression')
  })
})
