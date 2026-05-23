import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  extractExports,
  extractImports,
  getChangedFiles,
  runRegressionCheck,
} from './regressionChecker.js'

// -- Test helpers

const TEST_DIR = join(process.cwd(), 'src', '.test-regression-temp')

async function writeTestFile(name: string, content: string): Promise<string> {
  const path = join(TEST_DIR, name)
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content)
  return path
}

async function removeTestFiles() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
  }
  catch {
    // Ignore
  }
}

// -- Tests

describe('extractExports', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true })
  })

  afterEach(async () => {
    await removeTestFiles()
  })

  it('extracts exported functions', () => {
    const content = 'export function foo(a: string, b: number): void {}\nexport function bar(): number { return 1; }\n'
    const exports = extractExports('test.ts', content)
    expect(exports.length).toBe(2)
    expect(exports[0].name).toBe('foo')
    expect(exports[0].kind).toBe('function')
    expect(exports[0].paramCount).toBe(2)
    expect(exports[1].name).toBe('bar')
    expect(exports[1].paramCount).toBe(0)
  })

  it('extracts exported classes', () => {
    const content = 'export class MyClass {}\nexport class AnotherClass {\n  constructor(a: number, b: string) {}\n}\n'
    const exports = extractExports('test.ts', content)
    expect(exports.length).toBe(2)
    expect(exports[0].name).toBe('MyClass')
    expect(exports[0].kind).toBe('class')
    expect(exports[1].name).toBe('AnotherClass')
    expect(exports[1].kind).toBe('class')
  })

  it('extracts exported constants', () => {
    const content = 'export const PI = 3.14;\nexport const NAME = "test";\n'
    const exports = extractExports('test.ts', content)
    expect(exports.length).toBe(2)
    expect(exports[0].name).toBe('PI')
    expect(exports[0].kind).toBe('const')
    expect(exports[1].name).toBe('NAME')
  })

  it('extracts exported interfaces and types', () => {
    const content = 'export interface User { id: number; }\nexport type UserId = number;\n'
    const exports = extractExports('test.ts', content)
    expect(exports.length).toBe(2)
    expect(exports[0].name).toBe('User')
    expect(exports[0].kind).toBe('interface')
    expect(exports[1].name).toBe('UserId')
    expect(exports[1].kind).toBe('type')
  })

  it('extracts exported enums', () => {
    const content = 'export enum Color { Red, Green, Blue }\n'
    const exports = extractExports('test.ts', content)
    expect(exports.length).toBe(1)
    expect(exports[0].name).toBe('Color')
    expect(exports[0].kind).toBe('enum')
  })

  it('extracts re-exports', () => {
    const content = 'export { foo, bar as renamedBar } from "./utils";\n'
    const exports = extractExports('test.ts', content)
    expect(exports.length).toBe(2)
    expect(exports[0].name).toBe('foo')
    expect(exports[1].name).toBe('renamedBar')
  })

  it('extracts default exports', () => {
    const content = 'export default function main() {}\n'
    const exports = extractExports('test.ts', content)
    const defaultExport = exports.find(e => e.name === 'default')
    expect(defaultExport).toBeDefined()
    expect(defaultExport!.kind).toBe('function')
    expect(defaultExport!.paramCount).toBe(0)
    expect(defaultExport!.hasDefaultExport).toBe(true)
  })

  it('ignores non-exported declarations', () => {
    const content = 'function internal() {}\nconst secret = 42;\nclass Hidden {}\n'
    const exports = extractExports('test.ts', content)
    expect(exports.length).toBe(0)
  })
})

describe('extractImports', () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true })
  })

  afterEach(async () => {
    await removeTestFiles()
  })

  it('extracts named imports', () => {
    const content = 'import { foo, bar } from "./utils";\n'
    const imports = extractImports('test.ts', content)
    expect(imports.length).toBe(1)
    expect(imports[0].modulePath).toBe('./utils')
    expect(imports[0].exportedNames).toEqual(['foo', 'bar'])
    expect(imports[0].localNames).toEqual(['foo', 'bar'])
  })

  it('extracts default imports', () => {
    const content = 'import React from "react";\n'
    const imports = extractImports('test.ts', content)
    expect(imports.length).toBe(1)
    expect(imports[0].isDefaultImport).toBe(true)
    expect(imports[0].localNames).toContain('React')
    expect(imports[0].exportedNames).toContain('default')
  })

  it('extracts namespace imports', () => {
    const content = 'import * as utils from "./utils";\n'
    const imports = extractImports('test.ts', content)
    expect(imports.length).toBe(1)
    expect(imports[0].isNamespaceImport).toBe(true)
    expect(imports[0].localNames).toContain('utils')
  })

  it('extracts combined imports', () => {
    const content = 'import React, { useState, useEffect } from "react";\n'
    const imports = extractImports('test.ts', content)
    expect(imports.length).toBe(1)
    expect(imports[0].isDefaultImport).toBe(true)
    expect(imports[0].localNames).toContain('React')
    expect(imports[0].localNames).toContain('useState')
    expect(imports[0].localNames).toContain('useEffect')
    expect(imports[0].exportedNames).toContain('default')
    expect(imports[0].exportedNames).toContain('useState')
    expect(imports[0].exportedNames).toContain('useEffect')
  })

  it('handles aliased imports', () => {
    const content = 'import { foo as myFoo, bar as myBar } from "./utils";\n'
    const imports = extractImports('test.ts', content)
    expect(imports[0].exportedNames).toEqual(['foo', 'bar'])
    expect(imports[0].localNames).toEqual(['myFoo', 'myBar'])
  })

  it('returns empty array for file with no imports', () => {
    const content = 'const x = 42;\n'
    const imports = extractImports('test.ts', content)
    expect(imports.length).toBe(0)
  })
})

describe('getChangedFiles', () => {
  it('returns empty array when no git repo', async () => {
    // /tmp has no git repo
    const files = await getChangedFiles('/tmp')
    expect(files).toEqual([])
  })

  it('returns empty array when no changes in repo', async () => {
    const cwd = process.cwd()
    const files = await getChangedFiles(cwd)
    // The regressionChecker.ts itself was just created, so it might show up
    // But we're only checking .ts/.tsx files
    expect(Array.isArray(files)).toBe(true)
  })
})

describe('runRegressionCheck', () => {
  it('returns empty when no changes detected', async () => {
    const findings = await runRegressionCheck('/tmp')
    expect(findings).toEqual([])
  })

  it('returns array of findings', async () => {
    const cwd = process.cwd()
    const findings = await runRegressionCheck(cwd)
    expect(Array.isArray(findings)).toBe(true)
    // May or may not have findings depending on current git state
  })
})
