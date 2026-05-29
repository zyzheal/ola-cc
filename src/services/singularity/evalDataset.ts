import * as fs from 'fs'

export interface EvalExample {
  taskInput: string
  expectedBehavior: string
  difficulty: 'easy' | 'medium' | 'hard'
  category: string
  source: 'synthetic' | 'golden' | 'sessiondb'
}

export interface EvalDataset {
  train: EvalExample[]
  val: EvalExample[]
  holdout: EvalExample[]
  skipValidation?: boolean
}

export class EvalDatasetManager {
  static save(dataset: EvalDataset, filePath: string): void {
    const lines = [
      JSON.stringify({
        __header: true,
        version: '1.0',
        createdAt: new Date().toISOString(),
        totalExamples:
          dataset.train.length + dataset.val.length + dataset.holdout.length,
      }),
      ...dataset.train.map((e) => JSON.stringify({ ...e, __split: 'train' })),
      ...dataset.val.map((e) => JSON.stringify({ ...e, __split: 'val' })),
      ...dataset.holdout.map((e) =>
        JSON.stringify({ ...e, __split: 'holdout' }),
      ),
    ]
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
  }

  static load(filePath: string): EvalDataset {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
    const train: EvalExample[] = []
    const val: EvalExample[] = []
    const holdout: EvalExample[] = []

    for (const line of lines) {
      const obj = JSON.parse(line)
      if (obj.__header) continue
      const { __split, ...example } = obj
      if (__split === 'val') val.push(example)
      else if (__split === 'holdout') holdout.push(example)
      else train.push(example)
    }
    return { train, val, holdout }
  }

  static split(examples: EvalExample[]): EvalDataset {
    const shuffled = [...examples].sort(() => Math.random() - 0.5)
    const n = shuffled.length
    const trainEnd = Math.floor(n * 0.5)
    const valEnd = trainEnd + Math.floor(n * 0.25)
    return {
      train: shuffled.slice(0, trainEnd),
      val: shuffled.slice(trainEnd, valEnd),
      holdout: shuffled.slice(valEnd),
    }
  }

  static toTestResults(
    dataset: EvalDataset,
    predictions: string[],
  ): { passed: boolean; name: string; regression: boolean }[] {
    const holdout = dataset.holdout
    return holdout.map((example, i) => ({
      passed:
        predictions[i]?.includes(example.expectedBehavior.slice(0, 20)) ??
        false,
      name: `holdout-${example.category}-${i}`,
      regression: false,
    }))
  }
}
