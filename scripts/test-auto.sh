#!/bin/bash
# ola-cc 自动化测试脚本

set -e

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "  ✓ $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "  ✗ $1: $2"
}

echo "=== ola-cc 自动化测试 ==="
echo ""

# 1. 二进制存在性
echo "[1] 二进制检查"
if [ -f ./cli ] && [ -x ./cli ]; then
  pass "cli 二进制存在且可执行"
else
  fail "cli" "二进制不存在或不可执行"
fi

if [ -f ./cli-dev ] && [ -x ./cli-dev ]; then
  pass "cli-dev 二进制存在且可执行"
else
  fail "cli-dev" "二进制不存在或不可执行"
fi

# 2. 版本检查
echo ""
echo "[2] 版本检查"
VERSION=$(./cli --version 2>&1)
if echo "$VERSION" | grep -q "0.4.10"; then
  pass "版本号正确: $VERSION"
else
  fail "版本号" "输出: $VERSION"
fi

DEV_VERSION=$(./cli-dev --version 2>&1)
if echo "$DEV_VERSION" | grep -q "0.4.10"; then
  pass "dev 版本号正确: $DEV_VERSION"
else
  fail "dev 版本号" "输出: $DEV_VERSION"
fi

# 3. 帮助检查
echo ""
echo "[3] 帮助检查"
HELP=$(./cli --help 2>&1)
if echo "$HELP" | grep -q "ola-cc"; then
  pass "帮助输出正常"
else
  fail "帮助" "未找到 ola-cc"
fi

# 4. 预检检查 (preflight) - 核心修复验证
echo ""
echo "[4] 预检检查修复验证"
PREFLIGHT=$(timeout 10 ./cli -c "echo test" 2>&1)
if echo "$PREFLIGHT" | grep -q "BASE_API_URL"; then
  fail "预检" "仍然出现 BASE_API_URL 错误"
else
  pass "无 BASE_API_URL 错误"
fi

if echo "$PREFLIGHT" | grep -q "Connectivity check error"; then
  fail "预检" "出现连接性检查错误"
else
  pass "无连接性检查错误"
fi

# 5. SDK withResponse 修复验证
echo ""
echo "[5] SDK withResponse 修复验证"
if echo "$PREFLIGHT" | grep -q "withResponse"; then
  fail "SDK" "仍然出现 withResponse 错误"
else
  pass "无 withResponse 错误"
fi

# 6. 依赖完整性
echo ""
echo "[6] 依赖完整性"
if [ -d "node_modules/@anthropic-ai/sdk" ]; then
  pass "SDK 依赖存在"
else
  fail "SDK" "node_modules/@anthropic-ai/sdk 不存在"
fi

# 检查 SDK 的 withResponse 方法 - 使用独立脚本
bun run -e "
const mod = await import('./shims/sdk');
const { Anthropic } = mod;
const a = new Anthropic({ apiKey: 'test' });
const p = a.beta.messages.create({ model: 'test', max_tokens: 1 });
if (typeof p.withResponse !== 'function') { process.exit(1); }
" 2>/dev/null && pass "SDK withResponse 方法可用" || fail "SDK" "withResponse 方法不可用"

# 7. 启动时间
echo ""
echo "[7] 启动时间"
START=$(date +%s%N)
timeout 10 ./cli -c "echo test" > /dev/null 2>&1 || true
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
if [ "$ELAPSED" -lt 5000 ]; then
  pass "启动时间: ${ELAPSED}ms"
else
  fail "启动" "启动时间过长: ${ELAPSED}ms"
fi

# 总结
echo ""
echo "=== 测试结果 ==="
echo "通过: $PASS"
echo "失败: $FAIL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "测试未全部通过"
  exit 1
else
  echo "所有测试通过"
  exit 0
fi
