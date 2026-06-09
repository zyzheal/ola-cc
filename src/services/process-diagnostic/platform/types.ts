import type { ContainerMatch, ProcessInfo, SocketInfo } from '../types.js'

/**
 * 平台抽象接口 — 每个平台 (macOS/Linux/Windows/FreeBSD) 实现此接口
 * 必须方法：所有平台都需要
 * 可选方法 (?: 部分平台不支持)
 */
export interface PlatformOps {
  // === 必须方法 ===

  /** 列出匹配查询的 PID 列表 */
  findPIDs(query: { type: string; value: string; exact?: boolean }): Promise<number[]>

  /** 读取单个进程的详细信息 */
  readProcess(pid: number): Promise<ProcessInfo>

  /** 读取进程的父 PID — @deprecated ancestry.ts 直接使用 proc.ppid，此方法保留供外部调用 */
  getParentPID?(pid: number): Promise<number | null>

  /** 获取 PID 1 或 init 进程的 PID (通常返回 1, Windows 返回 services.exe PID) */
  getInitPID(): Promise<number>

  // === 可选方法 ===

  /** 读取进程的网络连接 (socket 列表) */
  readSockets?(pid: number): Promise<SocketInfo[]>

  /** 列出子进程 PID 列表 */
  listChildren?(pid: number): Promise<number[]>

  /** 读取进程环境变量 (仅 verbose 模式) */
  readEnvironment?(pid: number): Promise<string[]>

  /** 检测进程是否属于容器，返回容器 ID 或 null */
  detectContainer?(pid: number): Promise<string | null>

  /** 解析 systemd/launchd/Windows 服务信息 */
  readServiceInfo?(pid: number): Promise<{ name: string; description: string; unitFile?: string } | null>

  /** 获取进程快照 (Windows ToolHelp32, 其他平台无需实现) */
  readSnapshot?(): Promise<Map<number, { ppid: number; exe: string }>>
}
