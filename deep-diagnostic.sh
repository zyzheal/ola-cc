#!/bin/bash
# Deep diagnostic script for Agent interruption issue
# This script adds instrumentation at multiple layers

echo "=== Deep Diagnostic for Agent Interruption ==="
echo ""
echo "Environment Variables:"
echo "  CLAUDE_CODE_USE_OPENAI: ${CLAUDE_CODE_USE_OPENAI:-未设置}"
echo "  ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL:-未设置}"
echo "  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:+已设置}${ANTHROPIC_API_KEY:-未设置}"
echo "  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: ${CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:-未设置}"
echo "  CLAUDE_ENABLE_STREAM_WATCHDOG: ${CLAUDE_ENABLE_STREAM_WATCHDOG:-未设置}"
echo "  CLAUDE_STREAM_IDLE_TIMEOUT_MS: ${CLAUDE_STREAM_IDLE_TIMEOUT_MS:-默认 90000}"
echo ""

echo "=== Layer 1: Enable ALL diagnostic modes ==="
export CLAUDE_ENABLE_STREAM_WATCHDOG=1
export CLAUDE_STREAM_IDLE_TIMEOUT_MS=30000  # 30秒 timeout for faster detection
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1  # Kill switch for all beta features
export DEBUG=1  # Enable DEBUG env var
export DEBUG_OPENAI_STREAM=1  # OpenAI stream debug

echo "=== Layer 2: Check if isFirstPartyAnthropicBaseUrl() would return false ==="
if [ -n "$ANTHROPIC_BASE_URL" ]; then
  echo "  ANTHROPIC_BASE_URL is set: $ANTHROPIC_BASE_URL"
  echo "  This should make isFirstPartyAnthropicBaseUrl() return false"
  echo "  All beta fields/headers should be stripped"
else
  echo "  ANTHROPIC_BASE_URL not set - default Anthropic API"
fi

echo ""
echo "=== Layer 3: Run CLI with maximum diagnostics ==="
echo "  Command: node dist/publish/cli.mjs --debug-to-stderr"
echo ""
echo "  Key keywords to watch for in output:"
echo "    - 'API REQUEST' - request being sent"
echo "    - 'Stream started' - streaming began"
echo "    - 'needsFollowUp' - tool calls pending"
echo "    - 'completed' - turn finished"
echo "    - 'Streaming idle' - timeout warning/error"
echo "    - 'error' / 'Error' - any errors"
echo "    - 'betas' - beta headers being sent"
echo ""

echo "Starting CLI with diagnostics..."
node dist/publish/cli.mjs --debug-to-stderr 2>&1 | tee /tmp/deep-diagnostic.log