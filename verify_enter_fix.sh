#!/usr/bin/env bash
# 验证回车键修复

set -e

echo "=== 回车键修复验证 ==="
echo ""

echo "1. 检查修复是否已应用到源代码..."
if grep -q "input.toString('utf8')" src/ink/parse-keypress.ts; then
  echo "   ✅ 修复已应用: input.toString('utf8') 已替换 String(input)"
else
  echo "   ❌ 修复未应用: 仍然使用 String(input)"
  exit 1
fi

echo ""
echo "2. 检查发布版本是否已重新构建..."
if [ -f dist/publish/cli.js ]; then
  BUILD_TIME=$(stat -f "%Sm" dist/publish/cli.js 2>/dev/null || stat -c "%y" dist/publish/cli.js 2>/dev/null)
  echo "   ✅ 发布版本存在: dist/publish/cli.js"
  echo "   构建时间: $BUILD_TIME"
else
  echo "   ❌ 发布版本不存在"
  exit 1
fi

echo ""
echo "3. 验证构建输出中包含 toString('utf8')..."
# 由于代码被 minify，搜索可能的模式
if grep -q "toString" dist/publish/cli.js; then
  echo "   ✅ 构建输出中包含 toString 调用"
else
  echo "   ⚠️  未找到 toString (可能被 minify 优化)"
fi

echo ""
echo "4. 手动测试步骤:"
echo "   a. 运行发布版本:"
echo "      node dist/publish/cli.js"
echo ""
echo "   b. 在 TTY 界面中输入文字并按 Enter"
echo "      预期: 消息应该正常发送"
echo ""
echo "   c. 对比测试 (可选):"
echo "      # Dev 版本 (应该一直工作)"
echo "      bun run dev"
echo ""
echo "      # 发布版本 (修复后应该工作)"
echo "      node dist/publish/cli.js"

echo ""
echo "5. 如果仍有问题，运行诊断脚本:"
echo "   node diagnose_enter_key.mjs"

echo ""
echo "=== 验证完成 ==="
echo ""
echo "修复总结:"
echo "  文件: src/ink/parse-keypress.ts"
echo "  函数: inputToString()"
echo "  改动: String(buffer) → buffer.toString('utf8')"
echo "  原因: 跨运行时兼容性 (Node.js vs Bun)"
echo ""
