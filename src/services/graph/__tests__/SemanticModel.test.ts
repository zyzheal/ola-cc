/**
 * SemanticModel 测试 (F-98)
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { SemanticModel, type SemanticSymbol } from '../SemanticModel.js'
import type { NodeMetadata } from '../GraphStore.js'

describe('SemanticModel', () => {
  let model: SemanticModel

  beforeEach(() => {
    model = new SemanticModel()
  })

  describe('register + lookupByKind', () => {
    it('按类型分类注册符号', () => {
      model.register({
        id: 't1', name: 'UserService', kind: 'type',
        qualifiedName: 'src.UserService', file: 'src/user.ts', line: 1,
      })
      model.register({
        id: 'm1', name: 'getUser', kind: 'method',
        qualifiedName: 'src.UserService.getUser', file: 'src/user.ts', line: 10,
      })
      model.register({
        id: 'f1', name: 'name', kind: 'field',
        qualifiedName: 'src.UserService.name', file: 'src/user.ts', line: 5,
      })

      expect(model.lookupByKind('type')).toHaveLength(1)
      expect(model.lookupByKind('method')).toHaveLength(1)
      expect(model.lookupByKind('field')).toHaveLength(1)
      expect(model.size).toBe(3)
    })
  })

  describe('lookup (限定名查找)', () => {
    it('通过限定名精确查找', () => {
      model.register({
        id: 't1', name: 'UserService', kind: 'type',
        qualifiedName: 'src.UserService', file: 'src/user.ts', line: 1,
      })

      const found = model.lookup('src.UserService')
      expect(found).toBeDefined()
      expect(found!.name).toBe('UserService')
    })

    it('未找到返回 undefined', () => {
      expect(model.lookup('nonexistent')).toBeUndefined()
    })
  })

  describe('lookupByName', () => {
    it('按名称搜索符号', () => {
      model.register({
        id: 't1', name: 'User', kind: 'type',
        qualifiedName: 'src.User', file: 'src/a.ts', line: 1,
      })
      model.register({
        id: 't2', name: 'User', kind: 'type',
        qualifiedName: 'models.User', file: 'src/b.ts', line: 1,
      })

      const users = model.lookupByName('User')
      expect(users).toHaveLength(2)
    })

    it('未找到返回空数组', () => {
      expect(model.lookupByName('Nonexistent')).toHaveLength(0)
    })
  })

  describe('lookupByFile', () => {
    it('按文件路径查找符号', () => {
      model.register({
        id: 't1', name: 'A', kind: 'type',
        qualifiedName: 'src.A', file: 'src/a.ts', line: 1,
      })
      model.register({
        id: 'm1', name: 'foo', kind: 'method',
        qualifiedName: 'src.A.foo', file: 'src/a.ts', line: 10,
      })
      model.register({
        id: 't2', name: 'B', kind: 'type',
        qualifiedName: 'src.B', file: 'src/b.ts', line: 1,
      })

      const inA = model.lookupByFile('src/a.ts')
      expect(inA).toHaveLength(2)
    })
  })

  describe('buildFromNodes', () => {
    it('从 NodeMetadata 数组构建', () => {
      const nodes: NodeMetadata[] = [
        { id: 'n1', name: 'MyClass', kind: 'class', file: 'a.ts', line: 1 },
        { id: 'n2', name: 'doWork', kind: 'method', file: 'a.ts', line: 10 },
        { id: 'n3', name: 'count', kind: 'field', file: 'a.ts', line: 5 },
        { id: 'n4', name: 'MyInterface', kind: 'interface', file: 'b.ts', line: 1 },
        { id: 'n5', name: 'helper', kind: 'function', file: 'a.ts', line: 20 },
      ]

      model.buildFromNodes(nodes)

      expect(model.size).toBe(5)
      expect(model.lookupByKind('type')).toHaveLength(2) // class, interface
      expect(model.lookupByKind('method')).toHaveLength(2) // method, function
      expect(model.lookupByKind('field')).toHaveLength(1)
    })

    it('清空旧数据后重建', () => {
      model.register({
        id: 'old', name: 'Old', kind: 'type',
        qualifiedName: 'Old', file: 'old.ts', line: 1,
      })

      model.buildFromNodes([
        { id: 'new', name: 'New', kind: 'function', file: 'new.ts', line: 1 },
      ])

      expect(model.size).toBe(1)
      expect(model.lookup('Old')).toBeUndefined()
      expect(model.lookupByName('New')).toHaveLength(1)
    })

    it('正确分类 nodeKind', () => {
      const nodes: NodeMetadata[] = [
        { id: 'n1', name: 'A', kind: 'class', file: 'a.ts', line: 1 },
        { id: 'n2', name: 'B', kind: 'interface', file: 'a.ts', line: 1 },
        { id: 'n3', name: 'C', kind: 'struct', file: 'a.ts', line: 1 },
        { id: 'n4', name: 'D', kind: 'enum', file: 'a.ts', line: 1 },
        { id: 'n5', name: 'E', kind: 'type', file: 'a.ts', line: 1 },
        { id: 'n6', name: 'F', kind: 'trait', file: 'a.ts', line: 1 },
        { id: 'n7', name: 'G', kind: 'protocol', file: 'a.ts', line: 1 },
        { id: 'm1', name: 'H', kind: 'method', file: 'a.ts', line: 1 },
        { id: 'm2', name: 'I', kind: 'function', file: 'a.ts', line: 1 },
        { id: 'm3', name: 'J', kind: 'constructor', file: 'a.ts', line: 1 },
        { id: 'm4', name: 'K', kind: 'getter', file: 'a.ts', line: 1 },
        { id: 'm5', name: 'L', kind: 'setter', file: 'a.ts', line: 1 },
        { id: 'f1', name: 'M', kind: 'field', file: 'a.ts', line: 1 },
        { id: 'f2', name: 'N', kind: 'property', file: 'a.ts', line: 1 },
        { id: 'f3', name: 'O', kind: 'variable', file: 'a.ts', line: 1 },
        { id: 'f4', name: 'P', kind: 'constant', file: 'a.ts', line: 1 },
        { id: 'f5', name: 'Q', kind: 'unknown_kind', file: 'a.ts', line: 1 },
      ]

      model.buildFromNodes(nodes)

      // type: class, interface, struct, enum, type, trait, protocol = 7
      expect(model.lookupByKind('type')).toHaveLength(7)
      // method: method, function, constructor, getter, setter = 5
      expect(model.lookupByKind('method')).toHaveLength(5)
      // field: field, property, variable, constant, unknown_kind = 5
      expect(model.lookupByKind('field')).toHaveLength(5)
    })
  })

  describe('layerSizes', () => {
    it('返回各层大小', () => {
      model.register({
        id: 't1', name: 'A', kind: 'type',
        qualifiedName: 'A', file: 'a.ts', line: 1,
      })
      model.register({
        id: 'm1', name: 'B', kind: 'method',
        qualifiedName: 'B', file: 'a.ts', line: 1,
      })

      expect(model.layerSizes).toEqual({ types: 1, methods: 1, fields: 0 })
    })
  })

  describe('clear', () => {
    it('清空所有符号和索引', () => {
      model.register({
        id: 't1', name: 'A', kind: 'type',
        qualifiedName: 'A', file: 'a.ts', line: 1,
      })
      model.clear()

      expect(model.size).toBe(0)
      expect(model.lookup('A')).toBeUndefined()
      expect(model.lookupByName('A')).toHaveLength(0)
    })
  })
})
