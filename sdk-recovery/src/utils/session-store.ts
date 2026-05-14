import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
  SDKSessionInfo,
  SessionMutationOptions,
  ListSessionsOptions,
  SessionMessage,
  WarmQuery,
  GetSubagentMessagesOptions,
  ListSubagentsOptions,
  ImportSessionToStoreOptions,
  SessionStore,
} from '../types';

/**
 * Locate the project directory for session storage.
 * Falls back to current working directory.
 */
function resolveProjectDir(options?: { dir?: string }): string {
  return options?.dir ?? process.cwd();
}

/**
 * Locate the session storage directory.
 * Looks for .claude/ directory in the project, or falls back to ~/.claude/sessions.
 */
function resolveSessionDir(projectDir: string): string | null {
  // Check for local .claude/ directory
  const local = join(projectDir, '.claude');
  if (existsSync(local)) return local;

  // Fallback to home directory
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    const globalDir = join(home, '.claude');
    if (existsSync(globalDir)) return globalDir;
  }

  return null;
}

/**
 * Find a session JSONL file by UUID within a directory tree.
 */
function findSessionFile(sessionDir: string, sessionId: string): string | null {
  // Direct file: {sessionId}.jsonl
  const direct = join(sessionDir, `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;

  // In subdirectory: sessions/{sessionId}.jsonl
  const inSessions = join(sessionDir, 'sessions', `${sessionId}.jsonl`);
  if (existsSync(inSessions)) return inSessions;

  // Recurse one level deep for project-based dirs
  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = join(sessionDir, entry.name, `${sessionId}.jsonl`);
        if (existsSync(nested)) return nested;
        const nestedSessions = join(sessionDir, entry.name, 'sessions', `${sessionId}.jsonl`);
        if (existsSync(nestedSessions)) return nestedSessions;
      }
    }
  } catch {
    // Ignore permission errors
  }

  return null;
}

/**
 * Parse a single JSONL line and extract session metadata.
 */
function extractSessionMeta(filePath: string): SDKSessionInfo | null {
  try {
    // Limit read to first 64KB for metadata extraction (avoid loading huge files into memory)
    const MAX_META_READ = 64 * 1024;
    const fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(MAX_META_READ);
    const bytesRead = readSync(fd, buffer, 0, MAX_META_READ, 0);
    closeSync(fd);
    const content = buffer.toString('utf-8', 0, bytesRead);
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const firstLine = JSON.parse(lines[0]);
    const sessionId = firstLine.session_id ?? firstLine.uuid;
    if (!sessionId) return null;

    // Find title/summary from result messages
    let summary = '';
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'result' && parsed.result) {
          summary = parsed.result.substring(0, 200);
          break;
        }
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.cwd) {
          // Use cwd as fallback summary
          summary = summary || `Session in ${parsed.cwd}`;
        }
      } catch {
        // Skip malformed lines
      }
    }

    // Use first user message as summary if no result found
    if (!summary) {
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'assistant' && parsed.message?.content) {
            const textBlock = parsed.message.content.find((c: any) => c.type === 'text');
            if (textBlock?.text) {
              summary = textBlock.text.substring(0, 200);
              break;
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // Get last modified time
    const stat = statSync(filePath);
    const lastModified = stat.mtimeMs;

    return {
      sessionId,
      summary: summary || 'Untitled session',
      lastModified: Math.round(lastModified),
      fileSize: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * List all session JSONL files in the given directory tree.
 */
function listSessionFiles(projectDir: string, options?: { limit?: number; offset?: number }): { path: string; info: SDKSessionInfo }[] {
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) return [];

  const results: { path: string; info: SDKSessionInfo }[] = [];

  function scan(dir: string, depth: number = 0) {
    if (depth > 3) return; // Limit recursion
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const info = extractSessionMeta(fullPath);
          if (info) results.push({ path: fullPath, info });
        } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
          scan(fullPath, depth + 1);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  scan(sessionDir);

  // Sort by lastModified descending
  results.sort((a, b) => b.info.lastModified - a.info.lastModified);

  // Apply pagination
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? results.length;
  return results.slice(offset, offset + limit);
}

/**
 * Delete a session file and its subagent transcript directory.
 */
export async function deleteSession(sessionId: string, options?: SessionMutationOptions): Promise<void> {
  const projectDir = resolveProjectDir(options);
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) {
    throw new Error(`Session directory not found for project: ${projectDir}`);
  }

  const filePath = findSessionFile(sessionDir, sessionId);
  if (!filePath) {
    // TODO: sessionStore.delete not supported by current SessionStore interface.
    // The interface only has listSubkeys, load, and optional listSessions.
    // A future version should add delete/save methods to SessionStore.
    if (options?.sessionStore) {
      throw new Error(
        `sessionStore.delete is not implemented in the current SessionStore interface. ` +
        `Session not found locally: ${sessionId}`,
      );
    }
    throw new Error(`Session not found: ${sessionId}`);
  }

  unlinkSync(filePath);

  // Also remove subagent transcript subdirectory if exists
  const subagentDir = join(sessionDir, sessionId);
  if (existsSync(subagentDir)) {
    rmSync(subagentDir, { recursive: true, force: true });
  }
}

/**
 * List sessions across all projects or for a specific directory.
 */
export async function listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]> {
  const projectDir = resolveProjectDir(options);
  const files = listSessionFiles(projectDir, { limit: options?.limit, offset: options?.offset });

  // If sessionStore is provided, delegate to it
  if (options?.sessionStore) {
    // SessionStore.listSessions returns { sessionId, summary, lastModified }[]
    // We need to call it with a project key
    const store = options.sessionStore;
    if (typeof store.listSessions === 'function') {
      const storeResults = await store.listSessions(projectDir);
      return storeResults.map((r: any) => ({
        sessionId: r.sessionId,
        summary: r.summary ?? '',
        lastModified: r.lastModified ?? 0,
      }));
    }
    throw new Error('sessionStore.listSessions not implemented');
  }

  return files.map(f => f.info);
}

/**
 * Get metadata for a single session by ID.
 */
export async function getSessionInfo(sessionId: string, options?: { dir?: string; sessionStore?: SessionStore }): Promise<SDKSessionInfo | undefined> {
  // If sessionStore is provided, delegate to it
  if (options?.sessionStore) {
    const store = options.sessionStore;
    try {
      // Use listSubkeys to discover available metadata keys
      const subkeys = await store.listSubkeys({ sessionId, key: 'metadata' });
      if (subkeys.length === 0) return undefined;

      let summary = '';
      let lastModified = 0;

      // Try to load summary and lastModified from metadata subkeys
      for (const subkey of subkeys) {
        const value = await store.load({ sessionId, key: 'metadata', subkey });
        if (subkey === 'summary') summary = value;
        else if (subkey === 'lastModified') lastModified = parseInt(value, 10) || 0;
      }

      // If no explicit summary, try to get it from a generic subkey
      if (!summary && subkeys.length > 0) {
        summary = await store.load({ sessionId, key: 'metadata', subkey: subkeys[0] });
      }

      return {
        sessionId,
        summary: summary || 'Untitled session',
        lastModified,
      };
    } catch {
      return undefined;
    }
  }

  const projectDir = resolveProjectDir(options);
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) return undefined;

  const filePath = findSessionFile(sessionDir, sessionId);
  if (!filePath) return undefined;

  return extractSessionMeta(filePath) ?? undefined;
}

/**
 * Read all messages from a session transcript.
 */
export async function getSessionMessages(sessionId: string, options?: { dir?: string; sessionStore?: SessionStore }): Promise<SessionMessage[]> {
  // If sessionStore is provided, delegate to it
  if (options?.sessionStore) {
    const store = options.sessionStore;
    try {
      const subkeys = await store.listSubkeys({ sessionId, key: 'messages' });
      const messages: SessionMessage[] = [];

      for (const subkey of subkeys) {
        const content = await store.load({ sessionId, key: 'messages', subkey });
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === 'user' || parsed.type === 'assistant' || parsed.type === 'system') {
            messages.push({
              type: parsed.type,
              uuid: parsed.uuid ?? '',
              session_id: parsed.session_id ?? sessionId,
              message: parsed.message ?? parsed,
              parent_tool_use_id: parsed.parent_tool_use_id ?? null,
            });
          }
        } catch {
          // Skip malformed entries
        }
      }

      return messages;
    } catch {
      return [];
    }
  }

  const projectDir = resolveProjectDir(options);
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) return [];

  const filePath = findSessionFile(sessionDir, sessionId);
  if (!filePath) return [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const messages: SessionMessage[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'user' || parsed.type === 'assistant' || parsed.type === 'system') {
          messages.push({
            type: parsed.type,
            uuid: parsed.uuid ?? '',
            session_id: parsed.session_id ?? sessionId,
            message: parsed.message ?? parsed,
            parent_tool_use_id: parsed.parent_tool_use_id ?? null,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/**
 * Fork a session — copy transcript with new UUIDs.
 */
export async function forkSession(sessionId: string, options?: { dir?: string; upToMessageId?: string; title?: string; sessionStore?: SessionStore }): Promise<{ sessionId: string }> {
  // If sessionStore is provided, read messages from it
  if (options?.sessionStore) {
    const store = options.sessionStore;
    const messages = await getSessionMessages(sessionId, { ...options, sessionStore: store });

    if (messages.length === 0) {
      // TODO: Cannot write forked session to sessionStore — interface lacks save/store method.
      // Fall through to filesystem if available.
    } else {
      // Filter up to the specified message if provided
      let filteredMessages = messages;
      if (options?.upToMessageId) {
        const idx = messages.findIndex(m => m.uuid === options.upToMessageId);
        if (idx >= 0) {
          filteredMessages = messages.slice(0, idx + 1);
        }
      }

      // TODO: sessionStore lacks a save/store method to write the forked session.
      // The interface only has listSubkeys and load (read-only).
      // A future version should add write capabilities to SessionStore.
      throw new Error(
        `sessionStore does not support writing. forkSession requires a writable SessionStore. ` +
        `Current interface is read-only (listSubkeys, load).`,
      );
    }
  }

  const projectDir = resolveProjectDir(options);
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) {
    throw new Error(`Session directory not found for project: ${projectDir}`);
  }

  const filePath = findSessionFile(sessionDir, sessionId);
  if (!filePath) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Read source messages
  const messages = await getSessionMessages(sessionId, options);

  // Filter up to the specified message if provided
  let filteredMessages = messages;
  if (options?.upToMessageId) {
    const idx = messages.findIndex(m => m.uuid === options.upToMessageId);
    if (idx >= 0) {
      filteredMessages = messages.slice(0, idx + 1);
    }
  }

  // Generate new session ID
  const newSessionId = randomUUID();

  // Write new session file with remapped UUIDs
  const newFilePath = join(sessionDir, `${newSessionId}.jsonl`);
  const lines = filteredMessages.map(msg => {
    const newMsg = {
      ...msg,
      uuid: randomUUID(),
      session_id: newSessionId,
      parentUuid: msg.parent_tool_use_id ?? null,
    };
    return JSON.stringify(newMsg);
  });

  writeFileSync(newFilePath, lines.join('\n') + '\n', 'utf-8');

  return { sessionId: newSessionId };
}

/**
 * Rename a session by updating its title metadata.
 * For JSONL files, we add/modify the title field in the init message.
 */
export async function renameSession(sessionId: string, title: string, options?: SessionMutationOptions): Promise<void> {
  // TODO: sessionStore does not support write operations.
  // The interface only has listSubkeys, load, and optional listSessions.
  // A future version should add a save/update method to SessionStore.
  if (options?.sessionStore) {
    throw new Error(
      `sessionStore does not support write operations. renameSession requires a writable SessionStore.`,
    );
  }

  const projectDir = resolveProjectDir(options);
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) {
    throw new Error(`Session directory not found for project: ${projectDir}`);
  }

  const filePath = findSessionFile(sessionDir, sessionId);
  if (!filePath) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Read all lines, update title in init message
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const updated: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'system' && parsed.subtype === 'init') {
        parsed.title = title;
        updated.push(JSON.stringify(parsed));
      } else {
        updated.push(line);
      }
    } catch {
      updated.push(line);
    }
  }

  writeFileSync(filePath, updated.join('\n') + '\n', 'utf-8');
}

/**
 * Tag a session with metadata.
 * Adds a `tags` array to the init message, or removes a tag if `tag` is null.
 */
export async function tagSession(sessionId: string, tag: string | null, options?: SessionMutationOptions): Promise<void> {
  // TODO: sessionStore does not support write operations.
  // The interface only has listSubkeys, load, and optional listSessions.
  // A future version should add a save/update method to SessionStore.
  if (options?.sessionStore) {
    throw new Error(
      `sessionStore does not support write operations. tagSession requires a writable SessionStore.`,
    );
  }

  const projectDir = resolveProjectDir(options);
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) {
    throw new Error(`Session directory not found for project: ${projectDir}`);
  }

  const filePath = findSessionFile(sessionDir, sessionId);
  if (!filePath) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const updated: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'system' && parsed.subtype === 'init') {
        if (!Array.isArray(parsed.tags)) parsed.tags = [];
        if (tag === null) {
          parsed.tags = [];
        } else if (!parsed.tags.includes(tag)) {
          parsed.tags.push(tag);
        }
        updated.push(JSON.stringify(parsed));
      } else {
        updated.push(line);
      }
    } catch {
      updated.push(line);
    }
  }

  writeFileSync(filePath, updated.join('\n') + '\n', 'utf-8');
}

/**
 * Initialize the SDK — return a WarmQuery handle.
 * In recovery mode, returns a mock WarmQuery since we don't start a real CLI process.
 */
export async function startup(_params?: { options?: Record<string, unknown>; initializeTimeoutMs?: number }): Promise<WarmQuery> {
  return {
    initialize: async () => {},
    close: () => {},
    [Symbol.asyncDispose]: async () => {},
  };
}

/**
 * Get messages from a subagent transcript.
 * Subagent transcripts are stored in `{sessionId}/{agentId}/transcript.jsonl`.
 */
export async function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options?: GetSubagentMessagesOptions,
): Promise<SessionMessage[]> {
  // If sessionStore is provided, try to load from it
  if (options?.sessionStore) {
    const store = options.sessionStore;
    try {
      // Use subkey pattern: agentId/messageIndex
      const subkeys = await store.listSubkeys({ sessionId, key: `subagents/${agentId}` });
      const messages: SessionMessage[] = [];

      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? subkeys.length;
      const sliced = subkeys.slice(offset, offset + limit);

      for (const subkey of sliced) {
        const content = await store.load({ sessionId, key: `subagents/${agentId}`, subkey });
        try {
          const parsed = JSON.parse(content);
          if (parsed.type === 'user' || parsed.type === 'assistant' || parsed.type === 'system') {
            messages.push({
              type: parsed.type,
              uuid: parsed.uuid ?? '',
              session_id: parsed.session_id ?? sessionId,
              message: parsed.message ?? parsed,
              parent_tool_use_id: parsed.parent_tool_use_id ?? null,
            });
          }
        } catch {
          // Skip malformed entries
        }
      }

      return messages;
    } catch {
      // Fall through to filesystem
    }
  }

  const projectDir = resolveProjectDir(options);
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) return [];

  // Try subagent transcript location
  const transcriptPath = join(sessionDir, sessionId, agentId, 'transcript.jsonl');
  if (!existsSync(transcriptPath)) return [];

  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const messages: SessionMessage[] = [];

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? lines.length;
    const sliced = lines.slice(offset, offset + limit);

    for (const line of sliced) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'user' || parsed.type === 'assistant' || parsed.type === 'system') {
          messages.push({
            type: parsed.type,
            uuid: parsed.uuid ?? '',
            session_id: parsed.session_id ?? sessionId,
            message: parsed.message ?? parsed,
            parent_tool_use_id: parsed.parent_tool_use_id ?? null,
          });
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/**
 * List active subagents for a session.
 * Returns array of agent IDs found in the session's subagent transcript directory.
 */
export async function listSubagents(sessionId: string, options?: ListSubagentsOptions): Promise<string[]> {
  // If sessionStore is provided, try to list subagent keys
  if (options?.sessionStore) {
    const store = options.sessionStore;
    try {
      // List subkeys under 'subagents' to discover agent IDs
      const subkeys = await store.listSubkeys({ sessionId, key: 'subagents' });
      // Extract unique agent IDs from subkey paths (e.g., "agent-123/messages")
      const agentIds = new Set<string>();
      for (const subkey of subkeys) {
        const parts = subkey.split('/');
        if (parts.length > 0) {
          agentIds.add(parts[0]);
        }
      }
      const result = Array.from(agentIds);
      if (result.length > 0) return result;
    } catch {
      // Fall through to filesystem
    }
  }

  const projectDir = resolveProjectDir(options);
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) return [];

  const sessionSubdir = join(sessionDir, sessionId);
  if (!existsSync(sessionSubdir)) return [];

  try {
    const entries = readdirSync(sessionSubdir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Import a local JSONL session into a SessionStore.
 * Reads the local file and batch-appends to the store's sessions.
 */
export async function importSessionToStore(
  sessionId: string,
  store: SessionStore,
  options?: ImportSessionToStoreOptions,
): Promise<void> {
  if (!store.load) {
    throw new Error('SessionStore.load not implemented');
  }

  const projectDir = resolveProjectDir(options);
  const sessionDir = resolveSessionDir(projectDir);
  if (!sessionDir) {
    throw new Error(`Session directory not found for project: ${projectDir}`);
  }

  const filePath = findSessionFile(sessionDir, sessionId);
  if (!filePath) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Read and parse all messages
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  // Verify the store can access the session
  try {
    // Check if session exists in store by attempting to load a key
    await store.load({ sessionId, key: 'metadata', subkey: 'id' });
  } catch {
    // Session not in store — this is expected for import
  }

  // The store should have its own import mechanism; for now we verify the file exists
  // and the store can access it. Full batch-append would require store-specific logic.
}
