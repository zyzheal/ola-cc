#!/bin/bash
echo "=== Test 1: Basic echo ==="
echo "hello world"
echo ""
echo "=== Test 2: npm version ==="
npm --version
echo ""
echo "=== Test 3: npm view claude-code ==="
npm view @anthropic-ai/claude-code 2>&1
echo ""
echo "=== Test 4: npm view dependencies ==="
npm view @anthropic-ai/claude-code dependencies 2>&1
echo ""
echo "=== Test 5: npm view bin ==="
npm view @anthropic-ai/claude-code bin 2>&1
echo ""
echo "=== Test 6: npm pack dry-run ==="
npm pack @anthropic-ai/claude-code --dry-run 2>&1
echo ""
echo "=== DONE ==="
