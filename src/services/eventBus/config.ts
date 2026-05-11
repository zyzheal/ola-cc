// src/services/eventBus/config.ts

import type { NatsConfig } from './types.js'
import { DEFAULT_NATS_CONFIG } from './types.js'

export function getNatsConfig(): NatsConfig {
  const env = process.env

  return {
    serverUrl: env.CLAUDE_NATS_SERVER || DEFAULT_NATS_CONFIG.serverUrl,
    connectTimeout: parseInt(env.CLAUDE_NATS_CONNECT_TIMEOUT || '5000', 10),
    reconnectInterval: parseInt(env.CLAUDE_NATS_RECONNECT_INTERVAL || '2000', 10),
    maxReconnectAttempts: parseInt(env.CLAUDE_NATS_MAX_RECONNECT_ATTEMPTS || '10', 10),
    enableJetStream: env.CLAUDE_NATS_JETSTREAM !== 'false',
    streamName: env.CLAUDE_NATS_STREAM || DEFAULT_NATS_CONFIG.streamName,
  }
}

export function isNatsEnabled(): boolean {
  return process.env.CLAUDE_ENABLE_NATS !== 'false'
}
