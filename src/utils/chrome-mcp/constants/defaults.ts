/**
 * 默认配置
 */

/** HTTP Server 默认配置 */
export const HTTP_DEFAULTS = {
  /** 默认端口 */
  PORT: 12306,
  
  /** 默认绑定地址 */
  HOST: '127.0.0.1',
  
  /** 默认 CORS 白名单 */
  CORS_ORIGINS: [
    /^chrome-extension:\/\//,
    /^moz-extension:\/\//,
    'http://127.0.0.1',
  ] as Array<string | RegExp>,
} as const;

/** Socket 默认配置 */
export const SOCKET_DEFAULTS = {
  /** Socket 目录模板 */
  DIR_TEMPLATE: '/tmp/claude-mcp-browser-bridge',
  
  /** Socket 文件扩展名 */
  FILE_EXTENSION: '.sock',
} as const;

/** Native Messaging 默认配置 */
export const NATIVE_MESSAGING_DEFAULTS = {
  /** Native Host 标识符 */
  HOST_NAME: 'com.anthropic.claude_code_browser_extension',
  
  /** Manifest 文件名 */
  MANIFEST_NAME: 'com.anthropic.claude_code_browser_extension.json',
  
  /** 包装脚本目录 */
  WRAPPER_DIR: '~/.claude/chrome',
  
  /** 包装脚本名称（Unix） */
  WRAPPER_NAME_UNIX: 'chrome-native-host',
  
  /** 包装脚本名称（Windows） */
  WRAPPER_NAME_WINDOWS: 'chrome-native-host.bat',
} as const;

/** 扩展 ID 配置 */
export const EXTENSION_IDS = {
  /** 生产环境扩展 ID */
  PROD: 'fcoeoabgfenejglbffodgkkbkcdhcgfn',
  
  /** 开发环境扩展 ID */
  DEV: 'dihbgbndebgnbjfmelmegjepbnkhlgni',
  
  /** Ant 环境扩展 ID */
  ANT: 'dngcpimnedloihjnnfngkgjoidhnaolf',
  
  /** 自定义扩展 ID */
  CUSTOM: 'pnhielkknjookdjklgahibjafpndhdlc',
} as const;

/** 获取所有允许的扩展 ID */
export function getAllowedExtensionIds(): string[] {
  const ids = [EXTENSION_IDS.PROD, EXTENSION_IDS.CUSTOM];
  
  // Ant 用户额外允许开发和 Ant 环境扩展
  if (process.env.USER_TYPE === 'ant') {
    ids.push(EXTENSION_IDS.DEV, EXTENSION_IDS.ANT);
  }
  
  return ids;
}

/** 生成扩展 origin 字符串 */
export function getExtensionOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}/`;
}

/** 获取所有允许的扩展 origins */
export function getAllowedExtensionOrigins(): string[] {
  return getAllowedExtensionIds().map(getExtensionOrigin);
}
