// src/utils/__tests__/session-store-concurrent.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SessionStore } from "../../cli/session/store";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("SessionStore concurrent write safety", () => {
  let storeDir: string;
  let store: SessionStore;

  beforeAll(async () => {
    storeDir = join(tmpdir(), `sdk-store-${Date.now()}`);
    await mkdir(storeDir, { recursive: true });
    store = new SessionStore(storeDir);
  });

  afterAll(async () => {
    await rm(storeDir, { recursive: true, force: true });
  });

  test("concurrent writes to same session do not lose data", async () => {
    const projectId = "test_project";
    const sessionId = "test_session_concurrent";

    // Create initial session
    await store.saveSession(projectId, sessionId, {
      metadata: {
        id: sessionId,
        model: "test-model",
        cwd: process.cwd(),
        startTime: Date.now(),
        lastActivity: Date.now(),
        turnCount: 0,
        totalCostUsd: 0,
      },
      messages: [],
      permissionRules: [],
    });

    // Fire 10 concurrent addMessage calls
    const writes = Array.from({ length: 10 }, (_, i) =>
      store.addMessage(projectId, sessionId, {
        role: "user",
        content: `message-${i}`,
      })
    );

    await Promise.all(writes);

    // Verify all messages persisted
    const session = await store.loadSession(projectId, sessionId);
    expect(session).not.toBeNull();
    expect(session!.messages.length).toBe(10);
  });

  test("concurrent saveSession calls are serialized", async () => {
    const projectId = "test_project_2";
    const sessionId = "test_session_serialized";

    const saves = Array.from({ length: 5 }, async (_, i) => {
      await store.saveSession(projectId, sessionId, {
        metadata: {
          id: sessionId,
          model: `model-${i}`,
          cwd: process.cwd(),
          startTime: Date.now(),
          lastActivity: Date.now(),
          turnCount: i,
          totalCostUsd: i * 0.01,
        },
        messages: [{ role: "user", content: `msg-${i}` }],
        permissionRules: [],
      });
    });

    await Promise.all(saves);

    const session = await store.loadSession(projectId, sessionId);
    expect(session).not.toBeNull();
    expect(session!.messages.length).toBe(1); // At least one message from one save
  });
});
