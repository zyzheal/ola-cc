// Re-export zod from project's zod package instead of inlining
import * as zod from 'zod/v4'
export * from 'zod/v4'
export { zod }
export default zod

// SDK-specific exports
export function tool(name, def) {
  return { name, ...def }
}
export function createSdkMcpServer(config) {
  return { type: 'sdk', name: config?.name ?? 'sdk' }
}
export function query(client, params) {
  return client.query(params)
}
export function listSessions(client) {
  return client.listSessions()
}
export function getSessionInfo(client, sessionId) {
  return client.getSessionInfo(sessionId)
}
export function getSessionMessages(client, sessionId, params) {
  return client.getSessionMessages(sessionId, params)
}
export function forkSession(client, sessionId, params) {
  return client.forkSession(sessionId, params)
}
export function tagSession(client, sessionId, params) {
  return client.tagSession(sessionId, params)
}
export function renameSession(client, sessionId, params) {
  return client.renameSession(sessionId, params)
}
export async function unstable_v2_createSession(client, params) {
  return client.createSession(params)
}
export async function unstable_v2_resumeSession(client, params) {
  return client.resumeSession(params)
}
export async function unstable_v2_prompt(client, params) {
  return client.prompt(params)
}
export const HOOK_EVENTS = {}
export const EXIT_REASONS = {}
export class DirectConnectTransport {}
export class DirectConnectError extends Error {}
export function parseDirectConnectUrl(url) {
  return new URL(url)
}
