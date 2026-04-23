#!/bin/bash
# Streaming diagnostic script for ola-cc
# Run with: bash diagnose-streaming.sh

echo "=== Streaming Diagnostic Script ==="
echo ""

# 1. 检查环境变量
echo "1. 环境变量配置:"
echo "   CLAUDE_CODE_USE_OPENAI: ${CLAUDE_CODE_USE_OPENAI:-未设置}"
echo "   ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL:-未设置}"
echo "   ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-未设置}"
echo ""

# 2. 推荐的运行方式
echo "2. 推荐诊断运行方式:"
echo ""
echo "   方式 A - 使用 debug-to-stderr (实时日志):"
echo "   node dist/publish/cli.mjs --debug-to-stderr"
echo ""
echo "   方式 B - 使用 debug 模式 (日志写入文件):"
echo "   node dist/publish/cli.mjs --debug"
echo "   # 日志位置: ~/.claude/debug/latest"
echo ""
echo "   方式 C - 同时启用环境变量调试:"
echo "   DEBUG=1 node dist/publish/cli.mjs --debug-to-stderr"
echo ""

# 3. 使用 OpenAI adapter 的方式
echo "3. 如果使用 DashScope/Qwen 等 OpenAI-compatible API:"
echo ""
echo "   export CLAUDE_CODE_USE_OPENAI=1"
echo "   export OPENAI_API_BASE=${ANTHROPIC_BASE_URL:-https://your-api/v1}"
echo "   export OPENAI_API_KEY=\${ANTHROPIC_API_KEY}"
echo "   DEBUG_OPENAI_STREAM=1 node dist/publish/cli.mjs"
echo ""

# 4. 关键日志关键词
echo "4. 日志中查找以下关键词:"
echo "   - 'Stream started' - streaming 开始"
echo "   - 'content_block_start' - 内容块开始"
echo "   - 'content_block_delta' - 内容增量"
echo "   - 'content_block_stop' - 内容块结束"
echo "   - 'message_delta' - 消息完成"
echo "   - 'needsFollowUp' 或 'tool_use' - tool call 处理"
echo "   - 'Streaming idle timeout' - 超时中断"
echo "   - 'error' - 错误信息"
echo ""

# 5. 运行简单测试
echo "5. 是否现在运行诊断测试?"
read -p "   输入 y 运行: " answer
if [ "$answer" = "y" ]; then
    echo ""
    echo "   启动 debug-to-stderr 模式..."
    echo "   请在 CLI 中输入简单命令如 '列出当前目录文件'"
    echo ""
    node dist/publish/cli.mjs --debug-to-stderr 2>&1 | tee /tmp/streaming-debug.log
fi