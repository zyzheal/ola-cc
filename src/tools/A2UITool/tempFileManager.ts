/**
 * TempFileManager — Temporary HTML file management
 *
 * Creates temp files with restricted permissions (0o600).
 * Tracks active surfaces to prevent deleting unrelated files.
 * Validates surfaceId to prevent path traversal.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export class TempFileManager {
  private basePath = os.tmpdir()
  private activeSurfaces = new Set<string>()

  generatePath(surfaceId: string): string {
    const safeId = surfaceId.replace(/[^a-zA-Z0-9-]/g, '')
    if (safeId !== surfaceId || surfaceId.includes('..') || surfaceId.length === 0) {
      throw new Error(`Invalid surfaceId: ${surfaceId}`)
    }
    return path.join(this.basePath, `a2ui_${safeId}.html`)
  }

  async write(surfaceId: string, html: string): Promise<string> {
    const filePath = this.generatePath(surfaceId)
    await fs.promises.writeFile(filePath, html, { mode: 0o600 })
    this.activeSurfaces.add(surfaceId)
    return filePath
  }

  async cleanup(surfaceId: string): Promise<void> {
    const filePath = this.generatePath(surfaceId)
    try {
      await fs.promises.unlink(filePath)
      this.activeSurfaces.delete(surfaceId)
    } catch {
      // File may already be deleted
    }
  }

  async cleanupAll(): Promise<void> {
    const cleanupPromises = Array.from(this.activeSurfaces).map((id) =>
      this.cleanup(id),
    )
    await Promise.all(cleanupPromises)
    this.activeSurfaces.clear()
  }
}
