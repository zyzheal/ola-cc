#!/bin/bash
# ============================================================================
# Agent CPU 100% / 卡死 全面诊断启动器
# ============================================================================
# 整合系统所有 debug 机制到单一的启动+监控脚本。
#
# 用法:
#   ./scripts/diagnose-agent-cpu.sh [--dev] [--binary ./ola-cc-dev] [--prompt "任务描述"]
#
# 不传参数: 交互模式启动 ola-cc-dev + 看门狗
# --dev: 使用开发构建 (cli-dev)
# --binary: 指定二进制路径
# --prompt: 非交互模式直接执行任务
#
# 功能:
#   1. 启用 OLA_CC_CPU_DEBUG=1 → event loop 看门狗 + setState 频率
#   2. 启用 OLA_CC_COMMIT_LOG → React commit 日志
#   3. macOS sample 自动采样 (CPU>85% 持续 3 秒)
#   4. 进程退出时自动汇总分析
# ============================================================================

set -euo pipefail

# ---------- 配置 ----------
PROFILE_DIR="/tmp/cpu-diagnose-$(date +%Y%m%d_%H%M%S)"
DIAG_BINARY=""
USE_DEV=false
PROMPT=""

# ---------- 解析参数 ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) USE_DEV=true; shift ;;
    --binary) DIAG_BINARY="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --help) head -30 "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ---------- 自动选择二进制 ----------
if [ -z "$DIAG_BINARY" ]; then
  if $USE_DEV; then
    DIAG_BINARY="./cli-dev"
  else
    DIAG_BINARY="./ola-cc-dev"
  fi
fi

# 如果指定路径不存在，退回搜索
if [ ! -f "$DIAG_BINARY" ]; then
  for try in "./ola-cc-dev" "./cli-dev" "./cli"; do
    if [ -f "$try" ]; then
      DIAG_BINARY="$try"
      break
    fi
  done
fi

if [ ! -f "$DIAG_BINARY" ]; then
  echo "错误: 找不到二进制文件。请先构建:"
  echo "  bun run build:dev              # cli-dev"
  echo "  bun run ./scripts/build.ts     # cli (改名后可用)"
  exit 1
fi

# ---------- 目录 ----------
mkdir -p "$PROFILE_DIR"
COMMIT_LOG="$PROFILE_DIR/commits.log"
STDERR_LOG="$PROFILE_DIR/stderr.log"
SUMMARY_LOG="$PROFILE_DIR/summary.md"

echo "============================================================================"
echo "  Agent CPU 全面诊断 — $(date)"
echo "============================================================================"
echo "二进制:   $(pwd)/${DIAG_BINARY#./}"
echo "输出目录: $PROFILE_DIR"
echo ""

# ---------- 清理函数 ----------
PID=""
cleanup() {
  local exit_code=$?
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo ""
    echo "终止诊断进程 (PID $PID)..."
    kill -TERM "$PID" 2>/dev/null || true
    sleep 2
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
  fi
  summarize
  echo ""
  echo "诊断完成。输出目录: $PROFILE_DIR"
  echo "查看摘要: cat $SUMMARY_LOG"
  exit $exit_code
}
trap cleanup EXIT INT TERM

# ---------- 启动诊断进程 ----------
DIAG_ENV="OLA_CC_CPU_DEBUG=1 OLA_CC_COMMIT_LOG=$COMMIT_LOG"
FULL_CMD="env $DIAG_ENV \"$DIAG_BINARY\""

echo "启动: $FULL_CMD"
echo ""

if [ -n "$PROMPT" ]; then
  # 非交互模式
  echo "Prompt: $PROMPT"
  echo ""
  eval "$DIAG_ENV" \"$DIAG_BINARY\" -p "$PROMPT" --max-turns 30 > "$PROFILE_DIR/stdout.log" 2>"$STDERR_LOG" &
  PID=$!
else
  # 交互模式
  eval "$DIAG_ENV" \"$DIAG_BINARY\" 2>"$STDERR_LOG" &
  PID=$!
fi

echo "PID: $PID"
echo "Stderr: tail -f $STDERR_LOG"
echo ""

# ========== 看门狗循环 ==========
CPU_THRESHOLD=85
SAMPLE_SECS=3
TERM_SECS=15
high_count=0
sample_count=0
term_sent=false

echo "开始监控 CPU (阈值: ${CPU_THRESHOLD}%, 采样: ${SAMPLE_SECS}s)..."
echo ""

while kill -0 "$PID" 2>/dev/null; do
  CPU=$(ps -p "$PID" -o %cpu= 2>/dev/null | tr -d ' ' || echo "0")
  CPU_INT=${CPU%.*}
  MEM=$(ps -p "$PID" -o rss= 2>/dev/null | awk '{printf "%.0f", $1/1024}' || echo "0")

  if [ "${CPU_INT:-0}" -ge "$CPU_THRESHOLD" ]; then
    high_count=$((high_count + 1))
    printf "[%s] 🔴 CPU: %s%% MEM: %sMB (持续 %ds)\n" "$(date +%H:%M:%S)" "$CPU" "$MEM" "$high_count"

    # 阶段 1: 深度采样
    if [ "$high_count" -eq "$SAMPLE_SECS" ]; then
      sample_count=$((sample_count + 1))
      SAMPLE_FILE="$PROFILE_DIR/sample-${sample_count}-$(date +%H%M%S).txt"
      echo "  深度采样 5 秒 → $SAMPLE_FILE"
      sample "$PID" 5 -file "$SAMPLE_FILE" 2>/dev/null || true

      # 提取关键帧
      if [ -f "$SAMPLE_FILE" ]; then
        echo "" >> "$SUMMARY_LOG"
        echo "## 采样 #${sample_count}" >> "$SUMMARY_LOG"
        echo '```' >> "$SUMMARY_LOG"
        grep -E "(com.apple.main-thread|sampling-profiler|jsc|JavaScriptCore|runAgent|query|reconciler|ToolUse|REPL)" "$SAMPLE_FILE" | head -30 >> "$SUMMARY_LOG" 2>/dev/null || true
        echo '```' >> "$SUMMARY_LOG"
      fi
    fi

    # 阶段 2: SIGTERM (防止进程永久卡死)
    if [ "$high_count" -ge "$TERM_SECS" ] && [ "$term_sent" = false ]; then
      echo ""
      echo "!!! CPU > ${CPU_THRESHOLD}% 持续 ${TERM_SECS}s — 发送 SIGTERM..."
      kill -TERM "$PID" 2>/dev/null || true
      term_sent=true
      sleep 3
      if ! kill -0 "$PID" 2>/dev/null; then
        echo "进程已退出"
        break
      fi
    fi
  else
    if [ "$high_count" -gt 0 ]; then
      printf "[%s] 🟢 CPU: %s%% MEM: %sMB (恢复, 持续 ${high_count}s)\n" "$(date +%H:%M:%S)" "$CPU" "$MEM"
    fi
    high_count=0
    term_sent=false
    sleep 1
  fi

  # 检查 stderr 是否有 watchdog 警告
  if [ -f "$STDERR_LOG" ]; then
    tail -1 "$STDERR_LOG" 2>/dev/null | grep -q "CPU BUSY" && echo "  [watchdog 警告]"
  fi

  sleep 1
done

# 检查退出原因
wait "$PID" 2>/dev/null || true
EXIT_CODE=$?
echo ""
echo "进程退出 (code: $EXIT_CODE)"

# ========== 汇总分析 ==========
summarize() {
  echo "============================================================================"
  echo "  诊断汇总"
  echo "============================================================================"

  {
    echo "# Agent CPU 诊断报告"
    echo ""
    echo "日期: $(date)"
    echo "二进制: $DIAG_BINARY"
    echo "采样次数: $sample_count"
    echo "进程退出码: ${EXIT_CODE:-N/A}"
    echo ""
  } > "$SUMMARY_LOG"

  # 分析 stderr 日志
  if [ -f "$STDERR_LOG" ]; then
    echo "---" >> "$SUMMARY_LOG"
    echo "## Stderr 分析" >> "$SUMMARY_LOG"

    STERR_SIZE=$(wc -c < "$STDERR_LOG")
    STERR_LINES=$(wc -l < "$STDERR_LOG")
    echo "大小: $STERR_SIZE bytes, $STERR_LINES 行" >> "$SUMMARY_LOG"

    # setState 频率
    echo "" >> "$SUMMARY_LOG"
    echo "### setState 频率 (次/s)" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"
    grep "\[cpuDebug\] setState:" "$STDERR_LOG" | head -20 >> "$SUMMARY_LOG" 2>/dev/null || echo "(无 setState 日志)" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"

    # Watchdog 警告
    echo "" >> "$SUMMARY_LOG"
    echo "### Event Loop Watchdog 警告" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"
    grep "\[watchdog\]" "$STDERR_LOG" >> "$SUMMARY_LOG" 2>/dev/null || echo "(无 watchdog 警告)" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"

    # Agent 初始化耗时
    echo "" >> "$SUMMARY_LOG"
    echo "### Agent 初始化耗时" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"
    grep "\[AgentInit:" "$STDERR_LOG" >> "$SUMMARY_LOG" 2>/dev/null || echo "(无 AgentInit 日志)" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"

    # 最高 setState 频率
    echo "" >> "$SUMMARY_LOG"
    echo "### 最高 setState 频率" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"
    grep "\[cpuDebug\] setState:" "$STDERR_LOG" | sort -t'(' -k2 -rn | head -5 >> "$SUMMARY_LOG" 2>/dev/null || true
    echo '```' >> "$SUMMARY_LOG"

    # goalRuntime 同步频率
    echo "" >> "$SUMMARY_LOG"
    echo "### goalRuntime.sync 调用次数" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"
    grep -c "\[cpuDebug\] goalRuntime.sync" "$STDERR_LOG" 2>/dev/null | xargs -I{} echo "  {} 次" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"
  fi

  # 分析 commit 日志
  if [ -f "$COMMIT_LOG" ]; then
    echo "" >> "$SUMMARY_LOG"
    echo "## React Commit 分析" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"
    head -50 "$COMMIT_LOG" >> "$SUMMARY_LOG"
    echo "" >> "$SUMMARY_LOG"
    echo "---" >> "$SUMMARY_LOG"
    echo "总 commits: $(wc -l < "$COMMIT_LOG")" >> "$SUMMARY_LOG"
    echo '```' >> "$SUMMARY_LOG"
  fi

  # 采样分析
  if ls "$PROFILE_DIR"/sample-*.txt 1>/dev/null 2>&1; then
    echo "" >> "$SUMMARY_LOG"
    echo "## CPU 采样分析" >> "$SUMMARY_LOG"
    for f in "$PROFILE_DIR"/sample-*.txt; do
      echo "" >> "$SUMMARY_LOG"
      echo "### $(basename "$f")" >> "$SUMMARY_LOG"
      echo '```' >> "$SUMMARY_LOG"
      echo "主线程:" >> "$SUMMARY_LOG"
      sed -n '/com.apple.main-thread/,/^$/p' "$f" 2>/dev/null | head -20 >> "$SUMMARY_LOG" || true
      echo "" >> "$SUMMARY_LOG"
      echo "JS 运行时:" >> "$SUMMARY_LOG"
      grep -E "(sampling-profiler|JavaScriptCore|jsc|JSC::)" "$f" 2>/dev/null | head -15 >> "$SUMMARY_LOG" || true
      echo "" >> "$SUMMARY_LOG"
      echo "Bun/ola-cc 符号:" >> "$SUMMARY_LOG"
      grep -oE "[a-zA-Z_][a-zA-Z0-9_]*\s+\(in\s+ola-cc-dev\)" "$f" 2>/dev/null | sort | uniq -c | sort -rn | head -20 >> "$SUMMARY_LOG" || true
      echo "Bun/ola-cc 符号:" >> "$SUMMARY_LOG"
      grep -oE "[a-zA-Z_][a-zA-Z0-9_]*\s+\(in\s+cli-dev\)" "$f" 2>/dev/null | sort | uniq -c | sort -rn | head -20 >> "$SUMMARY_LOG" || true
      echo '```' >> "$SUMMARY_LOG"
    done
  fi

  # 根因判断
  echo "" >> "$SUMMARY_LOG"
  echo "## 初步判断" >> "$SUMMARY_LOG"

  # 检查 setState 频率
  HIGHEST_SETSTATE=$(grep "\[cpuDebug\] setState:" "$STDERR_LOG" 2>/dev/null | sort -t'(' -k2 -rn | head -1 | grep -oP '\d+\.?\d*(?=/s)' | head -1 || echo "0")
  WATCHDOG_COUNT=$(grep -c "\[watchdog\] CPU BUSY" "$STDERR_LOG" 2>/dev/null || echo "0")

  {
    echo "" >> "$SUMMARY_LOG"
  } >> "$SUMMARY_LOG"

  if [ "$sample_count" -gt 0 ]; then
    echo "- ❌ CPU 采样触发 ${sample_count} 次 — 确认 CPU 100% 发生" >> "$SUMMARY_LOG"
    # 从最后一次采样的调用栈判断
    LATEST_SAMPLE=$(ls -t "$PROFILE_DIR"/sample-*.txt 2>/dev/null | head -1)
    if [ -n "$LATEST_SAMPLE" ]; then
      if grep -q "runAgent\|query\|processGoalRuntime\|setState" "$LATEST_SAMPLE" 2>/dev/null; then
        echo "- 主要热点: 在 runAgent/query/processGoalRuntime 中" >> "$SUMMARY_LOG"
      fi
      if grep -q "reconciler\|resetAfterCommit\|commitRoot\|flushSync" "$LATEST_SAMPLE" 2>/dev/null; then
        echo "- 主要热点: 在 React reconciler 中 — 渲染风暴" >> "$SUMMARY_LOG"
      fi
    fi
  else
    echo "- ✅ CPU 未超阈值 (检测通过)" >> "$SUMMARY_LOG"
  fi

  if [ "$WATCHDOG_COUNT" -gt 0 ]; then
    echo "- ❌ Event Loop Watchdog 触发 ${WATCHDOG_COUNT} 次" >> "$SUMMARY_LOG"
    echo "   → 主线程被阻塞/忙碌" >> "$SUMMARY_LOG"
  else
    echo "- ✅ Event Loop 正常" >> "$SUMMARY_LOG"
  fi

  if [ "$(echo "$HIGHEST_SETSTATE" | cut -d. -f1)" -gt 50 ] 2>/dev/null; then
    echo "- ❌ setState 频率高 (峰值 ${HIGHEST_SETSTATE}/s) — 可能引起渲染风暴" >> "$SUMMARY_LOG"
  else
    echo "- ✅ setState 频率正常 (峰值: ${HIGHEST_SETSTATE}/s)" >> "$SUMMARY_LOG"
  fi

  cat "$SUMMARY_LOG"
}

# 如果进程已自然退出，也执行汇总
summarize
