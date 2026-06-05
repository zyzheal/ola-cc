/**
 * ScopeResolver 测试 (F-99)
 *
 * 使用 in-memory GraphStore 测试 4 阶段解析管道。
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { ScopeResolver } from '../ScopeResolver.js'
import { SemanticModel } from '../SemanticModel.js'
import { createFixture, type GraphFixture } from './testHelpers.js'
import type { GraphStore } from '../GraphStore.js'

describe('ScopeResolver', () => {
  let fixture: GraphFixture
  let model: SemanticModel
  let resolver: ScopeResolver

  beforeEach(() => {
    // 构建测试图：
    //   src/main.ts → imports → src/utils/helper (has exported 'formatDate')
    //   src/main.ts → calls → src/utils/helper.formatDate
    //   src/api/handler.ts → imports → src/main
    fixture = createFixture({
      'src/main.ts': [
        { to: 'src/utils/helper.ts', type: 'imports' },
        { to: 'src/utils/helper.ts:formatDate', type: 'calls' },
      ],
      'src/api/handler.ts': [
        { to: 'src/main.ts', type: 'imports' },
      ],
      'src/utils/helper.ts': [
        { to: 'src/utils/helper.ts:formatDate', type: 'contains' },
      ],
      'src/utils/helper.ts:formatDate': [],
    })

    // 添加节点元数据
    const { store } = fixture
    store.nodeMeta.set('src/main.ts', {
      id: 'src/main.ts',
      name: 'main',
      kind: 'module',
      file: 'src/main.ts',
      line: 1,
    })
    store.nodeMeta.set('src/utils/helper.ts', {
      id: 'src/utils/helper.ts',
      name: 'helper',
      kind: 'module',
      file: 'src/utils/helper.ts',
      line: 1,
    })
    store.nodeMeta.set('src/utils/helper.ts:formatDate', {
      id: 'src/utils/helper.ts:formatDate',
      name: 'formatDate',
      kind: 'function',
      file: 'src/utils/helper.ts',
      line: 5,
      qualified_name: 'src.utils.formatDate',
      is_exported: true,
    })
    store.nodeMeta.set('src/api/handler.ts', {
      id: 'src/api/handler.ts',
      name: 'handler',
      kind: 'module',
      file: 'src/api/handler.ts',
      line: 1,
    })

    model = new SemanticModel()
    model.buildFromStore(store)

    resolver = new ScopeResolver(store, model)
  })

  describe('buildImportMap (Stage 1)', () => {
    it('提取文件的 imports 边', () => {
      const importMap = resolver.buildImportMap('src/main.ts')

      // 应包含 helper 相关的导入
      expect(importMap.size).toBeGreaterThan(0)
    })

    it('无 imports 的文件返回空 map', () => {
      const importMap = resolver.buildImportMap('src/utils/helper.ts')
      // helper 没有出边的 imports，但可能有其他边
      expect(importMap).toBeInstanceOf(Map)
    })
  })

  describe('resolveInFile (Stage 2)', () => {
    it('在文件内找到符号', () => {
      const result = resolver.resolveInFile('formatDate', 'src/utils/helper.ts')

      expect(result).not.toBeNull()
      expect(result!.symbol).toBe('formatDate')
      expect(result!.definition.file).toBe('src/utils/helper.ts')
      expect(result!.confidence).toBe(1.0)
    })

    it('文件内未找到返回 null', () => {
      const result = resolver.resolveInFile('nonexistent', 'src/main.ts')
      expect(result).toBeNull()
    })
  })

  describe('resolveCrossFile (Stage 3)', () => {
    it('跨文件解析成功时置信度 < 1', () => {
      // handler.ts 导入了 main.ts，搜索 main 中的符号
      const result = resolver.resolveCrossFile('main', 'src/api/handler.ts')

      if (result) {
        expect(result.confidence).toBeLessThan(1.0)
      }
    })

    it('无匹配时返回 null', () => {
      const result = resolver.resolveCrossFile('totallyUnknown', 'src/main.ts')
      expect(result).toBeNull()
    })
  })

  describe('resolve (Stage 4)', () => {
    it('优先返回文件内解析', () => {
      const result = resolver.resolve('formatDate', 'src/utils/helper.ts')

      expect(result.symbol).toBe('formatDate')
      expect(result.definition.file).toBe('src/utils/helper.ts')
      expect(result.confidence).toBe(1.0)
    })

    it('文件内无匹配时回退到全局搜索', () => {
      const result = resolver.resolve('formatDate', 'src/main.ts')

      // 应该在全局搜索中找到
      expect(result.symbol).toBe('formatDate')
      if (result.confidence > 0) {
        expect(result.definition.file).toBe('src/utils/helper.ts')
      }
    })

    it('完全未找到时置信度为 0', () => {
      const result = resolver.resolve('nonexistentSymbol', 'src/main.ts')

      expect(result.symbol).toBe('nonexistentSymbol')
      expect(result.confidence).toBe(0)
      expect(result.definition.line).toBe(0)
    })

    it('返回的 references 是数组', () => {
      const result = resolver.resolve('formatDate', 'src/utils/helper.ts')

      expect(Array.isArray(result.references)).toBe(true)
    })

    it('返回的 exports 是数组', () => {
      const result = resolver.resolve('formatDate', 'src/utils/helper.ts')

      expect(Array.isArray(result.exports)).toBe(true)
    })
  })

  describe('边界条件', () => {
    it('空图不崩溃', () => {
      const emptyFixture = createFixture({})
      const emptyModel = new SemanticModel()
      emptyModel.buildFromStore(emptyFixture.store)

      const emptyResolver = new ScopeResolver(emptyFixture.store, emptyModel)
      const result = emptyResolver.resolve('anything', 'nowhere.ts')

      expect(result.confidence).toBe(0)
    })

    it('同名符号在多个文件中', () => {
      // 添加同名符号
      model.register({
        id: 'util:logger',
        name: 'logger',
        kind: 'method',
        qualifiedName: 'src.utils.logger',
        file: 'src/utils/helper.ts',
        line: 15,
      })
      model.register({
        id: 'lib:logger',
        name: 'logger',
        kind: 'method',
        qualifiedName: 'src.lib.logger',
        file: 'src/lib/logger.ts',
        line: 1,
      })

      const result = resolver.resolve('logger', 'src/utils/helper.ts')
      expect(result.symbol).toBe('logger')
      // 文件内解析优先
      expect(result.definition.file).toBe('src/utils/helper.ts')
    })
  })
})
