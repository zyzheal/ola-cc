import { randomUUID } from 'node:crypto';
import type { SDKSession, SDKSessionOptions, SDKUserMessage, SDKMessage, SDKSystemMessage } from '../types';
import { ContextManager } from '../cli/agent/context-manager';
import { SessionStore } from '../cli/session/store';
import { createMockLogger, type Logger } from '../utils/logger';

export interface SessionEventHandlers {
  onMessage?: (msg: SDKMessage) => void;
}

/** Manages session lifecycle: creation, resumption, storage, and message streaming. */
export class SessionManager {
  private sessions = new Map<string, ManagedSession>();

  async createSession(options: SDKSessionOptions): Promise<ManagedSession> {
    const sessionId = randomUUID();
    const session = new ManagedSession(sessionId, options);
    this.sessions.set(sessionId, session);
    return session;
  }

  async resumeSession(sessionId: string, options: SDKSessionOptions): Promise<ManagedSession> {
    // Check in-memory cache
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    // Try loading from disk
    const cwd = options.env?.cwd || process.cwd();
    const store = new SessionStore();
    const projectId = cwd.replace(/[^a-zA-Z0-9]/g, '_');
    const saved = await store.loadSession(projectId, sessionId);

    if (saved) {
      const session = new ManagedSession(sessionId, options);
      const ctx = session.getContextManager();
      for (const msg of saved.messages) {
        ctx.addMessage(msg);
      }
      this.sessions.set(sessionId, session);
      return session;
    }

    throw new Error(`Session "${sessionId}" not found`);
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }
}

/** Internal session implementation with streaming buffer support. */
export class ManagedSession implements SDKSession {
  readonly sessionId: string;

  private options: SDKSessionOptions;
  private contextManager: ContextManager;
  private sessionStore: SessionStore;
  private logger: Logger;
  private closed = false;
  private handler: ((msg: Record<string, unknown>) => void) | null = null;

  // Streaming buffer for receive()
  private messageBuffer: SDKMessage[] = [];
  private receiveResolve: ((result: IteratorResult<SDKMessage>) => void) | null = null;

  constructor(sessionId: string, options: SDKSessionOptions) {
    this.sessionId = sessionId;
    this.options = options;
    this.logger = createMockLogger();
    this.contextManager = new ContextManager({ maxTurns: 100 });
    this.sessionStore = new SessionStore();
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  setHandler(handler: (msg: Record<string, unknown>) => void): void {
    this.handler = handler;
  }

  /** Push a message into the receive() stream buffer. */
  pushToStream(msg: SDKMessage): void {
    if (this.receiveResolve) {
      const resolve = this.receiveResolve;
      this.receiveResolve = null;
      resolve({ done: false, value: msg });
    } else {
      this.messageBuffer.push(msg);
    }
  }

  /** Signal that receive() should finish. */
  finishStream(): void {
    if (this.receiveResolve) {
      const resolve = this.receiveResolve;
      this.receiveResolve = null;
      resolve({ done: true, value: undefined });
    }
    this.closed = true;
  }

  /** Emit an init message for the stream. */
  emitInitMessage(): SDKSystemMessage {
    const initMsg: SDKSystemMessage = {
      type: 'system',
      subtype: 'init',
      claude_code_version: '0.1.0-recovered',
      cwd: this.options.env?.cwd || process.cwd(),
      tools: [],
      mcp_servers: [],
      model: this.options.model,
      permissionMode: 'default' as any,
      slash_commands: [],
      output_style: 'text',
      skills: [],
      plugins: [],
      apiKeySource: 'user',
      session_id: this.sessionId,
      uuid: randomUUID() as any,
    };
    this.pushToStream(initMsg);
    return initMsg;
  }

  async send(_message: string | SDKUserMessage): Promise<void> {
    // Delegate to AgentLoop — this is a placeholder for the combined send flow
    throw new Error('send() requires AgentLoop integration');
  }

  async *receive(): AsyncGenerator<SDKMessage, void> {
    // Yield init message first
    yield this.emitInitMessage();

    // Then stream messages from the buffer
    while (!this.closed || this.messageBuffer.length > 0) {
      if (this.messageBuffer.length > 0) {
        yield this.messageBuffer.shift()!;
        continue;
      }

      // Wait for next message or close
      const msg = await new Promise<SDKMessage | undefined>((resolve) => {
        this.receiveResolve = (result: IteratorResult<SDKMessage>) => {
          if (result.done) {
            resolve(undefined);
          } else {
            resolve(result.value);
          }
        };
      });

      if (msg) {
        yield msg;
      }
    }
  }

  stream(): AsyncGenerator<SDKMessage, void> {
    return this.receive();
  }

  close(): void {
    if (!this.closed) {
      this.finishStream();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  async saveSession(): Promise<void> {
    const cwd = this.options.env?.cwd || process.cwd();
    const projectId = cwd.replace(/[^a-zA-Z0-9]/g, '_');

    try {
      await this.sessionStore.saveSession(projectId, this.sessionId, {
        metadata: {
          id: this.sessionId,
          model: this.options.model,
          cwd,
          startTime: Date.now(),
          lastActivity: Date.now(),
          turnCount: this.contextManager.getTurnCount(),
          totalCostUsd: 0,
        },
        messages: this.contextManager.getMessages(),
        permissionRules: [],
      });
    } catch {
      // Silently ignore save errors
    }
  }
}
