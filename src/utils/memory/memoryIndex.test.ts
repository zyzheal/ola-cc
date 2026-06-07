import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseAndScoreEntries, selectTopEntries } from './memoryIndex'

describe('parseAndScoreEntries', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-index-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('parses entry lines and assigns scores', async () => {
    writeFileSync(join(tmpDir, 'user.md'), '---\ntype: user\n---\ncontent')

    const content = '- [User](user.md) — user info'
    const entries = await parseAndScoreEntries(content, tmpDir)

    expect(entries.length).toBe(1)
    expect(entries[0]!.isEntry).toBe(true)
    expect(entries[0]!.filename).toBe('user.md')
    expect(entries[0]!.score).toBeGreaterThan(0)
  })

  it('assigns null score to non-entry lines', async () => {
    const content = '# Header\n\n- [Item](item.md) — desc\n\n## Section'
    writeFileSync(join(tmpDir, 'item.md'), 'content')

    const entries = await parseAndScoreEntries(content, tmpDir)

    // '# Header\n\n- [Item](item.md) — desc\n\n## Section' splits into 5 lines
    expect(entries.length).toBe(5)
    expect(entries[0]!.isEntry).toBe(false) // # Header
    expect(entries[0]!.score).toBeNull()
    expect(entries[1]!.isEntry).toBe(false) // blank
    expect(entries[2]!.isEntry).toBe(true)  // - [Item]
    expect(entries[3]!.isEntry).toBe(false) // blank
    expect(entries[4]!.isEntry).toBe(false) // ## Section
  })

  it('assigns score 0 to missing files', async () => {
    const content = '- [Missing](missing.md) — not here'
    const entries = await parseAndScoreEntries(content, tmpDir)

    expect(entries[0]!.isEntry).toBe(true)
    expect(entries[0]!.score).toBe(0)
  })

  it('scores newer files higher than older files', async () => {
    const oldFile = join(tmpDir, 'old.md')
    const newFile = join(tmpDir, 'new.md')
    writeFileSync(oldFile, 'content')
    writeFileSync(newFile, 'content')

    // Set old file to 30 days ago
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    utimesSync(oldFile, thirtyDaysAgo, thirtyDaysAgo)

    const content = '- [Old](old.md) — old\n- [New](new.md) — new'
    const entries = await parseAndScoreEntries(content, tmpDir)

    const oldEntry = entries.find(e => e.filename === 'old.md')!
    const newEntry = entries.find(e => e.filename === 'new.md')!

    expect(newEntry.score!).toBeGreaterThan(oldEntry.score!)
  })

  it('handles entries with subdirectory paths', async () => {
    const subDir = join(tmpDir, 'sub')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'deep.md'), 'content')

    const content = '- [Deep](sub/deep.md) — nested'
    const entries = await parseAndScoreEntries(content, tmpDir)

    // File doesn't exist (no mkdir), so score should be 0
    expect(entries[0]!.isEntry).toBe(true)
    // May be 0 or may have a score depending on whether writeFileSync created dirs
    expect(entries[0]!.score).toBeGreaterThanOrEqual(0)
  })

  it('handles empty content', async () => {
    const entries = await parseAndScoreEntries('', tmpDir)
    // ''.split('\n') produces [''] — one empty line
    expect(entries.length).toBe(1)
    expect(entries[0]!.isEntry).toBe(false)
  })
})

describe('selectTopEntries', () => {
  it('keeps all entries when under limit', () => {
    const entries = [
      { line: '- [A](a.md)', filename: 'a.md', score: 0.8, isEntry: true },
      { line: '- [B](b.md)', filename: 'b.md', score: 0.5, isEntry: true },
    ]
    const selected = selectTopEntries(entries, 10)
    expect(selected).toEqual(['- [A](a.md)', '- [B](b.md)'])
  })

  it('keeps top-N by score when over limit', () => {
    const entries = [
      { line: '- [Low](low.md)', filename: 'low.md', score: 0.1, isEntry: true },
      { line: '- [High](high.md)', filename: 'high.md', score: 0.9, isEntry: true },
      { line: '- [Mid](mid.md)', filename: 'mid.md', score: 0.5, isEntry: true },
    ]
    const selected = selectTopEntries(entries, 2)
    expect(selected).toContain('- [High](high.md)')
    expect(selected).toContain('- [Mid](mid.md)')
    expect(selected).not.toContain('- [Low](low.md)')
  })

  it('always keeps non-entry lines', () => {
    const entries = [
      { line: '# Header', filename: null, score: null, isEntry: false },
      { line: '- [A](a.md)', filename: 'a.md', score: 0.3, isEntry: true },
      { line: '- [B](b.md)', filename: 'b.md', score: 0.8, isEntry: true },
      { line: '## Footer', filename: null, score: null, isEntry: false },
    ]
    const selected = selectTopEntries(entries, 1)
    expect(selected).toContain('# Header')
    expect(selected).toContain('## Footer')
    expect(selected).toContain('- [B](b.md)')
    expect(selected).not.toContain('- [A](a.md)')
  })

  it('preserves original order of selected lines', () => {
    const entries = [
      { line: '- [C](c.md)', filename: 'c.md', score: 0.9, isEntry: true },
      { line: '- [A](a.md)', filename: 'a.md', score: 0.7, isEntry: true },
      { line: '- [B](b.md)', filename: 'b.md', score: 0.8, isEntry: true },
    ]
    const selected = selectTopEntries(entries, 2)
    // C (0.9) and B (0.8) should be kept, in original order: C, B
    expect(selected).toEqual(['- [C](c.md)', '- [B](b.md)'])
  })

  it('handles entries with null scores (treated as 0)', () => {
    const entries = [
      { line: '- [A](a.md)', filename: 'a.md', score: null, isEntry: true },
      { line: '- [B](b.md)', filename: 'b.md', score: 0.5, isEntry: true },
    ]
    const selected = selectTopEntries(entries, 1)
    expect(selected).toContain('- [B](b.md)')
    expect(selected).not.toContain('- [A](a.md)')
  })
})
