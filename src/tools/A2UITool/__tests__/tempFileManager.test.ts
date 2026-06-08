import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TempFileManager } from '../tempFileManager.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('TempFileManager', () => {
  let manager: TempFileManager
  let createdFiles: string[]

  beforeEach(() => {
    manager = new TempFileManager()
    createdFiles = []
  })

  afterEach(async () => {
    for (const file of createdFiles) {
      try {
        await fs.promises.unlink(file)
      } catch {
        // Ignore
      }
    }
  })

  test('should generate valid temp file path', () => {
    const filePath = manager.generatePath('test-surface')

    expect(filePath).toContain(os.tmpdir())
    expect(filePath).toContain('a2ui_test-surface.html')
  })

  test('should reject surface ID with special characters', () => {
    expect(() => manager.generatePath('test@surface#123')).toThrow('Invalid surfaceId')
  })

  test('should reject path traversal attempts', () => {
    expect(() => manager.generatePath('../etc/passwd')).toThrow('Invalid surfaceId')
    expect(() => manager.generatePath('test/../../../etc')).toThrow('Invalid surfaceId')
  })

  test('should reject empty surface ID', () => {
    expect(() => manager.generatePath('')).toThrow('Invalid surfaceId')
  })

  test('should reject surface ID with only special chars', () => {
    expect(() => manager.generatePath('@#$%')).toThrow('Invalid surfaceId')
  })

  test('should write HTML file', async () => {
    const filePath = await manager.write('test-write', '<html>test</html>')
    createdFiles.push(filePath)

    const content = await fs.promises.readFile(filePath, 'utf-8')
    expect(content).toBe('<html>test</html>')
  })

  test('should set restrictive file permissions', async () => {
    const filePath = await manager.write('test-perms', '<html></html>')
    createdFiles.push(filePath)

    const stats = await fs.promises.stat(filePath)
    const mode = (stats.mode & 0o777).toString(8)
    expect(mode).toBe('600')
  })

  test('should track active surfaces', async () => {
    const filePath = await manager.write('tracked-surface', '<html></html>')
    createdFiles.push(filePath)

    await manager.cleanup('tracked-surface')

    const exists = await fs.promises.access(filePath).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  test('should cleanup all tracked surfaces', async () => {
    const file1 = await manager.write('surface-1', '<html>1</html>')
    const file2 = await manager.write('surface-2', '<html>2</html>')
    createdFiles.push(file1, file2)

    await manager.cleanupAll()

    const exists1 = await fs.promises.access(file1).then(() => true).catch(() => false)
    const exists2 = await fs.promises.access(file2).then(() => true).catch(() => false)
    expect(exists1).toBe(false)
    expect(exists2).toBe(false)
  })

  test('should handle cleanup of non-existent file gracefully', async () => {
    await manager.cleanup('nonexistent-surface')
  })

  test('should allow hyphens in surface ID', () => {
    const filePath = manager.generatePath('my-cool-surface')

    expect(filePath).toContain('a2ui_my-cool-surface.html')
  })
})
