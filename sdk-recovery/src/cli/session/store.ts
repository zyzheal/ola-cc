import { mkdir, readFile, writeFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { SessionData, SessionMetadata } from './types';
import type { MessageParam } from '../../utils/anthropic-types';

export class SessionStore {
  private baseDir: string;
  private locks = new Map<string, Promise<void>>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.claude', 'projects');
  }

  /** Serialize async operations per session to prevent concurrent writes. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.locks.get(key) ?? Promise.resolve();
    const next = existing.then(fn, fn);
    this.locks.set(key, next.then(() => {}, () => {}));
    return next;
  }

  private sessionKey(projectId: string, sessionId: string): string {
    return `${projectId}:${sessionId}`;
  }

  private sessionDir(projectId: string, sessionId: string): string {
    return join(this.baseDir, projectId, 'sessions');
  }

  private sessionFile(projectId: string, sessionId: string): string {
    return join(this.sessionDir(projectId, sessionId), `${sessionId}.json`);
  }

  private metaFile(projectId: string, sessionId: string): string {
    return join(this.sessionDir(projectId, sessionId), `${sessionId}.meta.json`);
  }

  /** Internal save without lock — caller must hold the lock. */
  private async saveSessionInternal(
    projectId: string,
    sessionId: string,
    data: SessionData,
  ): Promise<void> {
    const dir = this.sessionDir(projectId, sessionId);
    await mkdir(dir, { recursive: true });

    await writeFile(this.sessionFile(projectId, sessionId), JSON.stringify(data, null, 2));

    const meta = {
      id: data.metadata.id,
      model: data.metadata.model,
      cwd: data.metadata.cwd,
      startTime: data.metadata.startTime,
      lastActivity: data.metadata.lastActivity,
      turnCount: data.metadata.turnCount,
      totalCostUsd: data.metadata.totalCostUsd,
    };
    await writeFile(this.metaFile(projectId, sessionId), JSON.stringify(meta, null, 2));
  }

  async saveSession(
    projectId: string,
    sessionId: string,
    data: SessionData,
  ): Promise<void> {
    const key = this.sessionKey(projectId, sessionId);
    return this.withLock(key, async () => {
      await this.saveSessionInternal(projectId, sessionId, data);
    });
  }

  async loadSession(
    projectId: string,
    sessionId: string,
  ): Promise<SessionData | null> {
    const filePath = this.sessionFile(projectId, sessionId);
    try {
      await access(filePath);
      const content = await readFile(filePath, 'utf-8');
      return JSON.parse(content) as SessionData;
    } catch {
      return null;
    }
  }

  async updateMetadata(
    projectId: string,
    sessionId: string,
    updates: Partial<SessionMetadata>,
  ): Promise<void> {
    const key = this.sessionKey(projectId, sessionId);
    return this.withLock(key, async () => {
      const current = await this.loadSession(projectId, sessionId);
      if (!current) return;

      current.metadata = { ...current.metadata, ...updates };
      await this.saveSessionInternal(projectId, sessionId, current);
    });
  }

  async listSessions(projectId: string): Promise<SessionMetadata[]> {
    const dir = this.sessionDir(projectId, '');
    try {
      await access(dir);
    } catch {
      return [];
    }

    const { readdir } = await import('fs/promises');
    const files = await readdir(dir);
    const sessions: SessionMetadata[] = [];

    for (const file of files) {
      if (file.endsWith('.meta.json')) {
        try {
          const content = await readFile(join(dir, file), 'utf-8');
          sessions.push(JSON.parse(content) as SessionMetadata);
        } catch {
          // Skip malformed files
        }
      }
    }

    // Sort by last activity
    return sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  }

  async deleteSession(projectId: string, sessionId: string): Promise<void> {
    const key = this.sessionKey(projectId, sessionId);
    return this.withLock(key, async () => {
      const { rm } = await import('fs/promises');
      const dir = this.sessionDir(projectId, sessionId);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Ignore if doesn't exist
      }
    });
  }

  async addMessage(
    projectId: string,
    sessionId: string,
    message: MessageParam,
  ): Promise<void> {
    const key = this.sessionKey(projectId, sessionId);
    return this.withLock(key, async () => {
      const session = await this.loadSession(projectId, sessionId);
      if (!session) return;

      session.messages.push(message);
      session.metadata.lastActivity = Date.now();
      session.metadata.turnCount++;
      await this.saveSessionInternal(projectId, sessionId, session);
    });
  }

  async getLastTurns(
    projectId: string,
    sessionId: string,
    turnCount: number,
  ): Promise<MessageParam[]> {
    const session = await this.loadSession(projectId, sessionId);
    if (!session) return [];

    // Return last N message pairs (user + assistant)
    const total = session.messages.length;
    const start = Math.max(0, total - turnCount * 2);
    return session.messages.slice(start);
  }
}
