// src/services/eventBus/types.ts

import type { SdkEvent } from '../../utils/sdkEventQueue.js'

export type EventBusEvent = SdkEvent & {
  /** 事件唯一 ID */
  uuid: string
  /** 会话 ID */
  session_id: string
  /** 事件时间戳 (ms) */
  timestamp: number
  /** 事件来源 */
  source?: string
}

export type EventBusStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type NatsConfig = {
  /** NATS 服务器 URL */
  serverUrl: string
  /** 连接超时 (ms) */
  connectTimeout: number
  /** 重连间隔 (ms) */
  reconnectInterval: number
  /** 最大重连次数 */
  maxReconnectAttempts: number
  /** 是否启用 JetStream 持久化 */
  enableJetStream: boolean
  /** 流名称 (JetStream) */
  streamName: string
}

export const DEFAULT_NATS_CONFIG: NatsConfig = {
  serverUrl: 'nats://localhost:4222',
  connectTimeout: 5000,
  reconnectInterval: 2000,
  maxReconnectAttempts: 10,
  enableJetStream: true,
  streamName: 'CLAUDE_EVENTS',
}

export type EventBusPublishResult = {
  success: boolean
  error?: string
}

export type EventBusSubscribeHandler = (event: EventBusEvent) => void | Promise<void>

export interface IEventBus {
  status: EventBusStatus
  connect(): Promise<void>
  disconnect(): Promise<void>
  publish(event: EventBusEvent): Promise<EventBusPublishResult>
  subscribe(subject: string, handler: EventBusSubscribeHandler): Promise<void>
  unsubscribe(subject: string): Promise<void>
}
