/**
 * 工具注册表
 * 
 * 管理可用工具的注册、查询和执行
 */

import { Logger } from '../utils/logger';
import { ChromeMcpError, ErrorCode } from '../utils/error-handler';
import type { ToolDefinition, ToolResult, ToolCallRequest } from '../types';

/** 工具执行函数类型 */
export type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult>;

/** 注册的工具 */
interface RegisteredTool {
  /** 工具定义 */
  definition: ToolDefinition;
  
  /** 执行函数 */
  executor: ToolExecutor;
  
  /** 是否启用 */
  enabled: boolean;
  
  /** 注册时间 */
  registeredAt: number;
}

/** 工具注册表配置 */
export interface ToolRegistryConfig {
  /** 日志器 */
  logger?: Logger;
}

/** 工具注册表 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private logger: Logger;
  
  constructor(config?: ToolRegistryConfig) {
    this.logger = config?.logger || new Logger({ prefix: '[ToolRegistry]' });
  }
  
  /** 注册工具 */
  register(definition: ToolDefinition, executor: ToolExecutor): void {
    if (this.tools.has(definition.name)) {
      this.logger.warn(`Tool already registered: ${definition.name}, overwriting`);
    }
    
    this.tools.set(definition.name, {
      definition,
      executor,
      enabled: true,
      registeredAt: Date.now(),
    });
    
    this.logger.debug(`Tool registered: ${definition.name}`);
  }
  
  /** 注销工具 */
  unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    
    if (existed) {
      this.logger.debug(`Tool unregistered: ${name}`);
    }
    
    return existed;
  }
  
  /** 启用工具 */
  enable(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) {
      this.logger.warn(`Tool not found: ${name}`);
      return false;
    }
    
    tool.enabled = true;
    this.logger.debug(`Tool enabled: ${name}`);
    return true;
  }
  
  /** 禁用工具 */
  disable(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) {
      this.logger.warn(`Tool not found: ${name}`);
      return false;
    }
    
    tool.enabled = false;
    this.logger.debug(`Tool disabled: ${name}`);
    return true;
  }
  
  /** 获取工具定义 */
  getDefinition(name: string): ToolDefinition | null {
    const tool = this.tools.get(name);
    return tool?.definition || null;
  }
  
  /** 获取所有工具定义 */
  getAllDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter(tool => tool.enabled)
      .map(tool => tool.definition);
  }
  
  /** 获取工具数量 */
  get size(): number {
    return this.tools.size;
  }
  
  /** 检查工具是否存在 */
  has(name: string): boolean {
    return this.tools.has(name);
  }
  
  /** 检查工具是否启用 */
  isEnabled(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.enabled ?? false;
  }
  
  /** 执行工具 */
  async execute(request: ToolCallRequest): Promise<ToolResult> {
    const tool = this.tools.get(request.name);
    
    if (!tool) {
      throw new ChromeMcpError({
        code: ErrorCode.TOOL_NOT_FOUND,
        message: `Tool not found: ${request.name}`,
        context: { toolName: request.name },
      });
    }
    
    if (!tool.enabled) {
      throw new ChromeMcpError({
        code: ErrorCode.PERMISSION_DENIED,
        message: `Tool is disabled: ${request.name}`,
        context: { toolName: request.name },
      });
    }
    
    this.logger.debug(`Executing tool: ${request.name}`);
    
    try {
      const result = await tool.executor(request.args || {});
      this.logger.debug(`Tool executed: ${request.name}`);
      return result;
    } catch (error) {
      this.logger.error(`Tool execution failed: ${request.name}, error: ${error}`);
      
      throw new ChromeMcpError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `Tool execution failed: ${request.name}`,
        cause: error instanceof Error ? error : new Error(String(error)),
        context: {
          toolName: request.name,
          args: request.args,
        },
      });
    }
  }
  
  /** 批量执行工具 */
  async executeBatch(requests: ToolCallRequest[]): Promise<Array<{
    requestId?: string;
    result: ToolResult;
    error?: string;
  }>> {
    const results = await Promise.allSettled(
      requests.map(request => this.execute(request))
    );
    
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return {
          requestId: requests[index].requestId,
          result: result.value,
        };
      } else {
        return {
          requestId: requests[index].requestId,
          result: {
            content: [{ type: 'text', text: 'Tool execution failed' }],
            isError: true,
          },
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
      }
    });
  }
  
  /** 清空所有工具 */
  clear(): void {
    const count = this.tools.size;
    this.tools.clear();
    this.logger.info(`Cleared ${count} registered tools`);
  }
  
  /** 获取工具状态信息 */
  getToolInfo(name: string): {
    name: string;
    enabled: boolean;
    registeredAt: number;
    description?: string;
  } | null {
    const tool = this.tools.get(name);
    if (!tool) {
      return null;
    }
    
    return {
      name: tool.definition.name,
      enabled: tool.enabled,
      registeredAt: tool.registeredAt,
      description: tool.definition.description,
    };
  }
  
  /** 获取所有工具状态信息 */
  getAllToolInfo(): Array<{
    name: string;
    enabled: boolean;
    registeredAt: number;
    description?: string;
  }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.definition.name,
      enabled: tool.enabled,
      registeredAt: tool.registeredAt,
      description: tool.definition.description,
    }));
  }
}

/** 创建工具注册表实例 */
export function createToolRegistry(config?: ToolRegistryConfig): ToolRegistry {
  return new ToolRegistry(config);
}
