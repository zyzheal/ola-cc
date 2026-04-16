/**
 * 日志工具
 * 
 * 提供统一的日志输出接口
 */

/** 日志级别 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/** 日志级别字符串映射 */
const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
}

/** 日志配置 */
export interface LoggerConfig {
  /** 日志级别 */
  level: LogLevel;
  
  /** 是否输出到 stderr */
  stderr?: boolean;
  
  /** 是否输出到文件 */
  file?: string;
  
  /** 日志前缀 */
  prefix?: string;
}

/** 默认日志配置 */
const DEFAULT_CONFIG: LoggerConfig = {
  level: LogLevel.INFO,
  stderr: true,
  file: undefined,
  prefix: '[ChromeMCP]',
};

/** 日志器类 */
export class Logger {
  private config: LoggerConfig;
  
  constructor(config?: Partial<LoggerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /** 设置日志级别 */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }
  
  /** 调试日志 */
  debug(message: string, ...args: unknown[]): void {
    this.log(LogLevel.DEBUG, message, args);
  }
  
  /** 信息日志 */
  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.INFO, message, args);
  }
  
  /** 警告日志 */
  warn(message: string, ...args: unknown[]): void {
    this.log(LogLevel.WARN, message, args);
  }
  
  /** 错误日志 */
  error(message: string, ...args: unknown[]): void {
    this.log(LogLevel.ERROR, message, args);
  }
  
  /** 内部日志输出 */
  private log(level: LogLevel, message: string, args: unknown[]): void {
    if (level < this.config.level) {
      return;
    }
    
    const timestamp = new Date().toISOString();
    const levelName = LEVEL_NAMES[level];
    const prefix = this.config.prefix || '';
    const argsStr = args.length > 0 ? ' ' + args.map(a => 
      typeof a === 'object' ? JSON.stringify(a) : String(a)
    ).join(' ') : '';
    
    const logLine = `${timestamp} ${prefix} [${levelName}] ${message}${argsStr}`;
    
    // 输出到 stderr（Native Messaging 使用 stdout 传输数据）
    if (this.config.stderr !== false) {
      console.error(logLine);
    }
    
    // 输出到文件（如果需要）
    if (this.config.file) {
      this.writeToFile(logLine).catch(() => {
        // 忽略文件写入错误
      });
    }
  }
  
  /** 写入日志文件 */
  private async writeToFile(line: string): Promise<void> {
    const { appendFile, mkdir } = await import('fs/promises');
    const { dirname } = await import('path');
    
    const dir = dirname(this.config.file!);
    await mkdir(dir, { recursive: true });
    await appendFile(this.config.file!, line + '\n');
  }
  
  /** 创建子日志器（带额外前缀） */
  child(prefix: string): Logger {
    return new Logger({
      ...this.config,
      prefix: `${this.config.prefix} ${prefix}`,
    });
  }
}

/** 创建日志器工厂函数 */
export function createLogger(config?: Partial<LoggerConfig>): Logger {
  return new Logger(config);
}

/** 默认日志器实例 */
export const defaultLogger = createLogger();
