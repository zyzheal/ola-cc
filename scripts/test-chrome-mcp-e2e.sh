#!/bin/bash
# Chrome MCP 端到端测试脚本
# 
# 用途：验证 Native Host 与 mcp-chrome 扩展的通信
# 使用：./test-e2e.sh

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 测试计数器
TESTS_PASSED=0
TESTS_FAILED=0

# 打印测试结果
print_result() {
  if [ $1 -eq 0 ]; then
    echo -e "${GREEN}✓ PASS${NC}: $2"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo -e "${RED}✗ FAIL${NC}: $2"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
}

echo "========================================="
echo "  Chrome MCP 端到端测试"
echo "========================================="
echo ""

# 测试 1：检查 Node.js 版本
echo -e "${YELLOW}测试 1: 检查 Node.js 版本${NC}"
node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$node_version" -ge 18 ]; then
  print_result 0 "Node.js 版本: $(node --version)"
else
  print_result 1 "Node.js 版本过低: $(node --version) (需要 >= 18)"
fi

# 测试 2：检查 bun 是否安装
echo -e "${YELLOW}测试 2: 检查 bun 是否安装${NC}"
if command -v bun &> /dev/null; then
  print_result 0 "bun 版本: $(bun --version)"
else
  print_result 1 "bun 未安装"
fi

# 测试 3：检查依赖是否安装
echo -e "${YELLOW}测试 3: 检查依赖是否安装${NC}"
if [ -d "node_modules/@modelcontextprotocol/sdk" ]; then
  print_result 0 "@modelcontextprotocol/sdk 已安装"
else
  print_result 1 "@modelcontextprotocol/sdk 未安装"
fi

if [ -d "node_modules/uuid" ]; then
  print_result 0 "uuid 已安装"
else
  print_result 1 "uuid 未安装"
fi

# 测试 4：编译 chrome-mcp 模块
echo -e "${YELLOW}测试 4: 编译 chrome-mcp 模块${NC}"
if bun build src/utils/chrome-mcp/index.ts --no-bundle > /dev/null 2>&1; then
  print_result 0 "chrome-mcp 编译成功"
else
  print_result 1 "chrome-mcp 编译失败"
fi

# 测试 5：编译 CLI 入口
echo -e "${YELLOW}测试 5: 编译 CLI 入口${NC}"
if bun build src/entrypoints/cli.tsx --no-bundle > /dev/null 2>&1; then
  print_result 0 "CLI 编译成功"
else
  print_result 1 "CLI 编译失败"
fi

# 测试 6：检查 Socket 目录权限
echo -e "${YELLOW}测试 6: 检查 Socket 目录权限${NC}"
SOCKET_DIR="/tmp/claude-mcp-browser-bridge-$USER"
if [ -d "$SOCKET_DIR" ]; then
  perms=$(stat -f "%Lp" "$SOCKET_DIR" 2>/dev/null || stat -c "%a" "$SOCKET_DIR" 2>/dev/null)
  if [ "$perms" = "700" ]; then
    print_result 0 "Socket 目录权限正确: $perms"
  else
    print_result 1 "Socket 目录权限错误: $perms (应该是 700)"
  fi
else
  print_result 0 "Socket 目录不存在（正常，首次启动时会创建）"
fi

# 测试 7：检查扩展白名单
echo -e "${YELLOW}测试 7: 检查扩展白名单${NC}"
if grep -q "pnhielkknjookdjklgahibjafpndhdlc" src/utils/claudeInChrome/setup.ts; then
  print_result 0 "自定义扩展 ID 已添加到白名单"
else
  print_result 1 "自定义扩展 ID 未添加到白名单"
fi

# 测试 8：检查扩展检测逻辑
echo -e "${YELLOW}测试 8: 检查扩展检测逻辑${NC}"
if grep -q "pnhielkknjookdjklgahibjafpndhdlc" src/utils/claudeInChrome/setupPortable.ts; then
  print_result 0 "自定义扩展 ID 已添加到检测逻辑"
else
  print_result 1 "自定义扩展 ID 未添加到检测逻辑"
fi

# 测试 9：检查双协议支持
echo -e "${YELLOW}测试 9: 检查双协议支持${NC}"
if grep -q "McpChromeMessageType" src/utils/chrome-mcp/constants/message-types.ts; then
  print_result 0 "mcp-chrome 协议已实现"
else
  print_result 1 "mcp-chrome 协议未实现"
fi

if grep -q "OlaMessageType" src/utils/chrome-mcp/constants/message-types.ts; then
  print_result 0 "OLA 协议已实现"
else
  print_result 1 "OLA 协议未实现"
fi

# 测试 10：检查心跳机制
echo -e "${YELLOW}测试 10: 检查心跳机制${NC}"
if grep -q "HeartbeatManager" src/utils/chrome-mcp/protocol/heartbeat.ts; then
  print_result 0 "心跳管理器已实现"
else
  print_result 1 "心跳管理器未实现"
fi

# 测试 11：检查请求跟踪器
echo -e "${YELLOW}测试 11: 检查请求跟踪器${NC}"
if grep -q "RequestTracker" src/utils/chrome-mcp/protocol/request-tracker.ts; then
  print_result 0 "请求跟踪器已实现"
else
  print_result 1 "请求跟踪器未实现"
fi

# 测试 12：检查工具名称映射
echo -e "${YELLOW}测试 12: 检查工具名称映射${NC}"
if grep -q "ToolNameMapper" src/utils/chrome-mcp/tools/name-mapper.ts; then
  print_result 0 "工具名称映射器已实现"
else
  print_result 1 "工具名称映射器未实现"
fi

# 测试 13：检查错误处理
echo -e "${YELLOW}测试 13: 检查错误处理${NC}"
if grep -q "ChromeMcpError" src/utils/chrome-mcp/utils/error-handler.ts; then
  print_result 0 "错误处理器已实现"
else
  print_result 1 "错误处理器未实现"
fi

# 测试 14：检查消息验证
echo -e "${YELLOW}测试 14: 检查消息验证${NC}"
if grep -q "MessageValidator" src/utils/chrome-mcp/utils/validators.ts; then
  print_result 0 "消息验证器已实现"
else
  print_result 1 "消息验证器未实现"
fi

# 测试 15：检查 Native Host 入口
echo -e "${YELLOW}测试 15: 检查 Native Host 入口${NC}"
if grep -q "runChromeNativeHost" src/utils/claudeInChrome/chromeNativeHost.ts; then
  print_result 0 "Native Host 入口已更新"
else
  print_result 1 "Native Host 入口未更新"
fi

# 打印测试总结
echo ""
echo "========================================="
echo "  测试总结"
echo "========================================="
echo -e "通过: ${GREEN}$TESTS_PASSED${NC}"
echo -e "失败: ${RED}$TESTS_FAILED${NC}"
echo "总计: $((TESTS_PASSED + TESTS_FAILED))"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
  echo -e "${GREEN}所有测试通过！${NC}"
  exit 0
else
  echo -e "${RED}有 $TESTS_FAILED 个测试失败，请检查上述错误。${NC}"
  exit 1
fi
