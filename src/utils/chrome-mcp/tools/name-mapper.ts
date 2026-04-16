/**
 * 工具名称映射器
 * 
 * 处理不同系统之间的工具名称转换
 * OLA 系统使用 mcp__claude-in-chrome__* 前缀
 * mcp-chrome 扩展使用 chrome_* 前缀
 */

/** 工具名称映射规则 */
interface MappingRule {
  /** OLA 系统工具名称模式 */
  olaPattern: RegExp;
  
  /** mcp-chrome 扩展工具名称模式 */
  mcpChromePattern: RegExp;
  
  /** 基础名称提取组索引 */
  baseNameGroup: number;
}

/** 工具名称映射规则列表 */
const MAPPING_RULES: MappingRule[] = [
  // 通用浏览器工具
  {
    olaPattern: /^mcp__claude-in-chrome__(browser_)?(.+)$/,
    mcpChromePattern: /^chrome_(.+)$/,
    baseNameGroup: 2,
  },
  // 读取工具（无前缀）
  {
    olaPattern: /^mcp__claude-in-chrome__(read_.+)$/,
    mcpChromePattern: /^chrome_(read_.+)$/,
    baseNameGroup: 1,
  },
  // 键盘工具
  {
    olaPattern: /^mcp__claude-in-chrome__keyboard$/,
    mcpChromePattern: /^chrome_keyboard$/,
    baseNameGroup: 0,
  },
  // 文件上传工具
  {
    olaPattern: /^mcp__claude-in-chrome__file_upload$/,
    mcpChromePattern: /^chrome_upload_file$/,
    baseNameGroup: 0,
  },
  // 处理弹窗工具
  {
    olaPattern: /^mcp__claude-in-chrome__handle_dialog$/,
    mcpChromePattern: /^chrome_handle_dialog$/,
    baseNameGroup: 0,
  },
  // GIF 录制工具
  {
    olaPattern: /^mcp__claude-in-chrome__gif_recorder$/,
    mcpChromePattern: /^chrome_gif_recorder$/,
    baseNameGroup: 0,
  },
  // 元素选择器
  {
    olaPattern: /^mcp__claude-in-chrome__element_picker$/,
    mcpChromePattern: /^chrome_request_element_selection$/,
    baseNameGroup: 0,
  },
  // 注入脚本
  {
    olaPattern: /^mcp__claude-in-chrome__inject_script$/,
    mcpChromePattern: /^chrome_inject_script$/,
    baseNameGroup: 0,
  },
  // 网页抓取
  {
    olaPattern: /^mcp__claude-in-chrome__web_fetcher$/,
    mcpChromePattern: /^chrome_get_web_content$/,
    baseNameGroup: 0,
  },
  // 网络请求
  {
    olaPattern: /^mcp__claude-in-chrome__network_request$/,
    mcpChromePattern: /^chrome_network_request$/,
    baseNameGroup: 0,
  },
  // 标签页上下文
  {
    olaPattern: /^mcp__claude-in-chrome__tabs_context_mcp$/,
    mcpChromePattern: /^get_windows_and_tabs$/,
    baseNameGroup: 0,
  },
  // Flow 工具
  {
    olaPattern: /^mcp__claude-in-chrome__(browser_task|lightning_turn)$/,
    mcpChromePattern: /^record_replay_(flow_run|list_published)$/,
    baseNameGroup: 1,
  },
];

/** 工具名称映射器 */
export class ToolNameMapper {
  /**
   * 将 OLA 工具名称转换为 mcp-chrome 扩展工具名称
   */
  static olaToMcpChrome(olaName: string): string {
    // 先尝试精确匹配
    for (const rule of MAPPING_RULES) {
      const match = olaName.match(rule.olaPattern);
      if (match) {
        // 对于有明确映射的规则，直接返回对应的 mcp-chrome 名称
        return this.mapByRule(rule, match, 'mcpChrome');
      }
    }
    
    // 如果没有匹配，尝试通用转换规则
    return this.genericOLAtoMcpChrome(olaName);
  }
  
  /**
   * 将 mcp-chrome 扩展工具名称转换为 OLA 工具名称
   */
  static mcpChromeToOla(mcpChromeName: string): string {
    // 先尝试精确匹配
    for (const rule of MAPPING_RULES) {
      const match = mcpChromeName.match(rule.mcpChromePattern);
      if (match) {
        return this.mapByRule(rule, match, 'ola');
      }
    }
    
    // 如果没有匹配，尝试通用转换规则
    return this.genericMcpChromeToOLA(mcpChromeName);
  }
  
  /**
   * 根据规则映射工具名称
   */
  private static mapByRule(
    rule: MappingRule,
    match: RegExpMatchArray,
    direction: 'ola' | 'mcpChrome'
  ): string {
    const baseName = match[rule.baseNameGroup] || '';
    
    if (direction === 'mcpChrome') {
      // OLA → mcp-chrome
      if (baseName === 'tabs_context_mcp') {
        return 'get_windows_and_tabs';
      }
      if (baseName === 'file_upload') {
        return 'chrome_upload_file';
      }
      if (baseName === 'handle_dialog') {
        return 'chrome_handle_dialog';
      }
      if (baseName === 'gif_recorder') {
        return 'chrome_gif_recorder';
      }
      if (baseName === 'element_picker') {
        return 'chrome_request_element_selection';
      }
      if (baseName === 'inject_script') {
        return 'chrome_inject_script';
      }
      if (baseName === 'web_fetcher') {
        return 'chrome_get_web_content';
      }
      if (baseName === 'network_request') {
        return 'chrome_network_request';
      }
      if (baseName === 'keyboard') {
        return 'chrome_keyboard';
      }
      if (baseName.startsWith('browser_')) {
        return `chrome_${baseName.slice(8)}`;
      }
      if (baseName.startsWith('read_')) {
        return `chrome_${baseName}`;
      }
      return `chrome_${baseName}`;
    } else {
      // mcp-chrome → OLA
      if (baseName === 'get_windows_and_tabs') {
        return 'mcp__claude-in-chrome__tabs_context_mcp';
      }
      if (baseName === 'chrome_upload_file') {
        return 'mcp__claude-in-chrome__file_upload';
      }
      if (baseName === 'chrome_handle_dialog') {
        return 'mcp__claude-in-chrome__handle_dialog';
      }
      if (baseName === 'chrome_gif_recorder') {
        return 'mcp__claude-in-chrome__gif_recorder';
      }
      if (baseName === 'chrome_request_element_selection') {
        return 'mcp__claude-in-chrome__element_picker';
      }
      if (baseName === 'chrome_inject_script') {
        return 'mcp__claude-in-chrome__inject_script';
      }
      if (baseName === 'chrome_get_web_content') {
        return 'mcp__claude-in-chrome__web_fetcher';
      }
      if (baseName === 'chrome_network_request') {
        return 'mcp__claude-in-chrome__network_request';
      }
      if (baseName === 'chrome_keyboard') {
        return 'mcp__claude-in-chrome__keyboard';
      }
      if (baseName.startsWith('chrome_')) {
        return `mcp__claude-in-chrome__${baseName.slice(7)}`;
      }
      return `mcp__claude-in-chrome__${baseName}`;
    }
  }
  
  /**
   * 通用 OLA → mcp-chrome 转换
   */
  private static genericOLAtoMcpChrome(olaName: string): string {
    // 移除 mcp__claude-in-chrome__ 前缀
    const withoutPrefix = olaName.replace(/^mcp__claude-in-chrome__/, '');
    
    // 如果已经有 chrome_ 前缀，直接返回
    if (withoutPrefix.startsWith('chrome_')) {
      return withoutPrefix;
    }
    
    // 添加 chrome_ 前缀
    return `chrome_${withoutPrefix}`;
  }
  
  /**
   * 通用 mcp-chrome → OLA 转换
   */
  private static genericMcpChromeToOLA(mcpChromeName: string): string {
    // 移除 chrome_ 前缀
    const withoutPrefix = mcpChromeName.replace(/^chrome_/, '');
    
    // 添加 mcp__claude-in-chrome__ 前缀
    return `mcp__claude-in-chrome__${withoutPrefix}`;
  }
  
  /**
   * 检查工具名称是否是 OLA 格式
   */
  static isOlaFormat(name: string): boolean {
    return name.startsWith('mcp__claude-in-chrome__');
  }
  
  /**
   * 检查工具名称是否是 mcp-chrome 格式
   */
  static isMcpChromeFormat(name: string): boolean {
    return name.startsWith('chrome_') || 
           name === 'get_windows_and_tabs' ||
           name === 'record_replay_flow_run' ||
           name === 'record_replay_list_published';
  }
  
  /**
   * 标准化工具名称
   * 统一转换为 mcp-chrome 格式（扩展使用的格式）
   */
  static normalize(name: string): string {
    if (this.isOlaFormat(name)) {
      return this.olaToMcpChrome(name);
    }
    return name;
  }
}
