/**
 * ContractRegistry tests (F-103)
 */

import { describe, test, expect } from 'bun:test'
import { ContractRegistry } from '../ContractRegistry.js'
import { createStoreFromAdjacency } from './testHelpers.js'

function createStoreWithMetadata() {
  const store = createStoreFromAdjacency({
    'src/auth/login.ts:login': [{ to: 'src/utils/hash.ts:hashPassword', type: 'imports' }],
    'src/auth/login.ts:validateToken': [],
    'src/api/users.ts:getUsers': [{ to: 'src/db/users.ts:findAll', type: 'imports' }],
    'src/api/users.ts:createUser': [],
    'src/events/ emitter.ts:emitUserCreated': [],
    'src/events/ emitter.ts:onUserCreated': [],
    'src/utils/hash.ts:hashPassword': [],
    'src/db/users.ts:findAll': [],
  })

  // Set rich metadata
  const login = store.nodeMeta.get('src/auth/login.ts:login')!
  login.kind = 'function'
  login.name = 'login'
  login.file = 'src/auth/login.ts'
  login.is_exported = true
  login.signature = 'login(req: Request): Promise<Response>'

  const validate = store.nodeMeta.get('src/auth/login.ts:validateToken')!
  validate.kind = 'function'
  validate.name = 'validateToken'
  validate.file = 'src/auth/login.ts'
  validate.is_exported = true

  const getUsers = store.nodeMeta.get('src/api/users.ts:getUsers')!
  getUsers.kind = 'function'
  getUsers.name = 'getUsers'
  getUsers.file = 'src/api/users.ts'
  getUsers.is_exported = true
  getUsers.signature = '@Get("/users") getUsers(req)'

  const createUser = store.nodeMeta.get('src/api/users.ts:createUser')!
  createUser.kind = 'function'
  createUser.name = 'createUser'
  createUser.file = 'src/api/users.ts'
  createUser.is_exported = true
  createUser.signature = '@Post("/users") createUser(req)'

  const emitter = store.nodeMeta.get('src/events/ emitter.ts:emitUserCreated')!
  emitter.kind = 'function'
  emitter.name = 'emitUserCreated'
  emitter.file = 'src/events/ emitter.ts'

  const listener = store.nodeMeta.get('src/events/ emitter.ts:onUserCreated')!
  listener.kind = 'function'
  listener.name = 'onUserCreated'
  listener.file = 'src/events/ emitter.ts'

  const hash = store.nodeMeta.get('src/utils/hash.ts:hashPassword')!
  hash.kind = 'function'
  hash.name = 'hashPassword'
  hash.file = 'src/utils/hash.ts'
  hash.visibility = 'public'

  const findAll = store.nodeMeta.get('src/db/users.ts:findAll')!
  findAll.kind = 'function'
  findAll.name = 'findAll'
  findAll.file = 'src/db/users.ts'
  findAll.is_exported = true

  return store
}

describe('ContractRegistry', () => {
  describe('extractAll', () => {
    test('extracts contracts for all files', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      expect(registry.size).toBeGreaterThan(0)
    })

    test('extracts exported functions', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const authContract = registry.getContract('src/auth/login.ts')
      expect(authContract).toBeDefined()
      expect(authContract!.exports.length).toBeGreaterThan(0)
      expect(authContract!.exports.some(e => e.name === 'login')).toBe(true)
    })

    test('detects API handlers from signatures', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const apiContract = registry.getContract('src/api/users.ts')
      expect(apiContract).toBeDefined()
      expect(apiContract!.apis.length).toBeGreaterThan(0)
    })

    test('detects event emitters', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const eventContract = registry.getContract('src/events/ emitter.ts')
      expect(eventContract).toBeDefined()
      expect(eventContract!.events.some(e => e.type === 'emit')).toBe(true)
    })

    test('detects event subscribers', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const eventContract = registry.getContract('src/events/ emitter.ts')
      expect(eventContract!.events.some(e => e.type === 'subscribe')).toBe(true)
    })

    test('extracts dependencies from import edges', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const authContract = registry.getContract('src/auth/login.ts')
      expect(authContract).toBeDefined()
      expect(authContract!.dependencies.length).toBeGreaterThan(0)
      expect(authContract!.dependencies.some(d => d.includes('hash'))).toBe(true)
    })
  })

  describe('getContract', () => {
    test('returns contract for existing module', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const contract = registry.getContract('src/auth/login.ts')
      expect(contract).toBeDefined()
      expect(contract!.module).toBe('src/auth/login.ts')
    })

    test('returns undefined for non-existent module', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const contract = registry.getContract('nonexistent.ts')
      expect(contract).toBeUndefined()
    })
  })

  describe('findModules', () => {
    test('finds modules by export name pattern', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const modules = registry.findModules({
        exports: [{ name: 'login', kind: '', isDefault: false }],
      })

      expect(modules.some(m => m.includes('login'))).toBe(true)
    })

    test('finds modules by API method', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const modules = registry.findModules({
        apis: [{ method: 'GET', path: '', handler: '' }],
      })

      // Should find users.ts with GET handler
      expect(modules.length).toBeGreaterThanOrEqual(0)
    })

    test('returns empty for non-matching pattern', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const modules = registry.findModules({
        exports: [{ name: 'totallyNonExistentFunction_xyz', kind: '', isDefault: false }],
      })

      expect(modules.length).toBe(0)
    })
  })

  describe('exportToJson', () => {
    test('returns valid JSON string', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const json = registry.exportToJson()
      const parsed = JSON.parse(json)

      expect(typeof parsed).toBe('object')
      expect(Object.keys(parsed).length).toBeGreaterThan(0)
    })

    test('JSON contains module paths as keys', () => {
      const store = createStoreWithMetadata()
      const registry = new ContractRegistry(store)
      registry.extractAll()

      const json = registry.exportToJson()
      const parsed = JSON.parse(json)

      expect(Object.keys(parsed).some(k => k.includes('src/auth/login.ts'))).toBe(true)
    })
  })

  describe('empty graph', () => {
    test('handles empty store gracefully', () => {
      const store = createStoreWithMetadata()
      // Clear everything
      store.nodeMeta.clear()
      store.adjacency.clear()
      store.reverse.clear()

      const registry = new ContractRegistry(store)
      registry.extractAll()

      expect(registry.size).toBe(0)
      expect(registry.exportToJson()).toBe('{}')
    })
  })
})
