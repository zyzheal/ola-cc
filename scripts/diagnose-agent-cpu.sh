#!/bin/bash
# ============================================================================
# Agent CPU 100% / 卡死 全面诊断
# ============================================================================
# 两终端模式（TUI 前台运行，不阻塞交互）:
#   T1: ./scripts/diagnose-agent-cpu.sh            # 启动带诊断的 ola-cc
#   T2: ./scripts/diagnose-agent-cpu.sh --watchdog <PID>  # CPU 监控
#
# 非交互模式（自动执行任务）:
#   T1: ./scripts/diagnose-agent-cpu.sh --prompt "分析 src/"
#   T2: ./scripts/diagnose-agent-cpu.sh --watchdog <PID>
#
# 单独分析:
#   ./scripts/diagnose-agent-cpu.sh --analyze /tmp/cpu-diagnose-<timestamp>
#
# 选项: --dev, --binary PATH, --help
# ============================================================================

set -euo pipefail

# ====================================================================
# 生成分析报告（函数，被多个模式共用）
# ====================================================================
generate_summary() {
  local dir="${1:-$PROFILE_DIR}"
  local stderr="$dir/stderr.log"
  local commit="$dir/commits.log"
  local summary="$dir/summary.md"
  local profile_dir="$dir"

  {
    echo "# Agent CPU 诊断报告"
    echo ""
    echo "生成时间: $(date)"
    echo "诊断目录: $dir"
    echo ""

    # stderr 分析
    if [ -f "$stderr" ]; then
      local watchdog_count=$(grep -c "\[watchdog\] CPU BUSY" "$stderr" 2>/dev/null || echo "0")
      local highest_setstate=$(grep "\[cpuDebug\] setState:" "$stderr" 2>/dev/null | sort -t'(' -k2 -rn | head -1 | grep -oP '\d+\.?\d*(?=/s)' | head -1 || echo "0")
      local sample_count=$(ls "$profile_dir"/sample-*.txt 2>/dev/null | wc -l | tr -d ' ')

      echo "## 概况"
      echo "- CPU采样: ${sample_count} 次"
      echo "- Watchdog 警告: ${watchdog_count} 次"
      echo "- setState 峰值: ${highest_setstate}/s"
      echo ""

      echo "## 初步判断"
      if [ "$sample_count" -gt 0 ]; then
        echo "- ❌ CPU采样触发 — CPU 100% 确认"
        local latest=$(ls -t "$profile_dir"/sample-*.txt 2>/dev/null | head -1)
        if [ -n "$latest" ]; then
          grep -qE "runAgent|query|processGoalRuntime|setState" "$latest" 2>/dev/null && \
            echo "- 热点方向: runAgent/query/processGoalRuntime"
          grep -qE "reconciler|resetAfterCommit|commitRoot|flushSync" "$latest" 2>/dev/null && \
            echo "- 热点方向: React reconciler — 渲染风暴"
        fi
      else
        echo "- ✅ CPU未超阈值"
      fi
      [ "$watchdog_count" -gt 0 ] && echo "- ❌ 主线程阻塞 ${watchdog_count} 次" || echo "- ✅ 主线程正常"
      [ "$(echo "$highest_setstate" | cut -d. -f1)" -gt 50 ] 2>/dev/null && \
        echo "- ❌ setState 过高 (${highest_setstate}/s)" || echo "- ✅ setState 正常"
      echo ""

      echo "## setState 频率"
      echo '```'
      grep "\[cpuDebug\] setState:" "$stderr" 2>/dev/null | head -20
      echo '```'
      echo ""

      echo "## setState 调用者采样"
      echo '```'
      grep "\[cpuDebug\] setState caller:" "$stderr" 2>/dev/null | sort | uniq -c | sort -rn | head -10
      echo '```'
      echo ""

      echo "## Event Loop Watchdog"
      echo '```'
      grep "\[watchdog\]" "$stderr" 2>/dev/null
      echo '```'
      echo ""

      echo "## Agent Init"
      echo '```'
      grep "\[AgentInit:" "$stderr" 2>/dev/null
      echo '```'
      echo ""
    fi

    # Commit 日志
    if [ -f "$commit" ]; then
      echo "## React Commit"
      echo '```'
      head -50 "$commit"
      echo ""
      echo "总commits: $(wc -l < "$commit")"
      echo '```'
      echo ""
    fi

    # CPU 采样
    local samples=("$profile_dir"/sample-*.txt)
    if [ -f "${samples[0]}" ]; then
      echo "## CPU采样调用栈"
      for f in "$profile_dir"/sample-*.txt; do
        [ -f "$f" ] || continue
        echo "### $(basename "$f")"
        echo '```'
        echo "主线程:"
        sed -n '/com.apple.main-thread/,/^$/p' "$f" 2>/dev/null | head -15
        echo ""
        echo "Hot函数:"
        grep -oE "[a-zA-Z_][a-zA-Z0-9_]*\s+\(in\s+(ola-cc-dev|cli-dev)\)" "$f" 2>/dev/null | sort | uniq -c | sort -rn | head -15
        echo '```'
        echo ""
      done
    fi
  } > "$summary"

  cat "$summary"
}

# ====================================================================
# 参数解析
# ====================================================================
PROFILE_DIR=""
DIAG_BINARY=""
USE_DEV=false
PROMPT=""
WATCHDOG_PID=""
ANALYZE_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) USE_DEV=true; shift ;;
    --binary) DIAG_BINARY="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --watchdog) WATCHDOG_PID="$2"; shift 2 ;;
    --analyze) ANALYZE_DIR="$2"; shift 2 ;;
    --help) head -30 "$0"; exit 0 ;;
    *) echo "未知: $1"; exit 1 ;;
  esac
done

# ====================================================================
# --analyze: 分析已有诊断目录
# ====================================================================
if [ -n "$ANALYZE_DIR" ]; then
  PROFILE_DIR="$ANALYZE_DIR"
  generate_summary "$ANALYZE_DIR"
  exit 0
fi

# ====================================================================
# --watchdog: CPU 监控模式（在另一个终端运行）
# ====================================================================
if [ -n "$WATCHDOG_PID" ]; then
  if ! kill -0 "$WATCHDOG_PID" 2>/dev/null; then
    echo "错误: PID $WATCHDOG_PID 不存在"
    exit 1
  fi

  PROFILE_DIR="/tmp/cpu-diagnose-$(date +%Y%m%d_%H%M%S)"
  mkdir -p "$PROFILE_DIR"
  CMD=$(ps -p "$WATCHDOG_PID" -o command= 2>/dev/null | head -c 100)

  echo "=== CPU看门狗 PID=$WATCHDOG_PID ==="
  echo "命令: $CMD"
  echo "目录: $PROFILE_DIR"
  echo ""

  high_count=0
  sample_count=0
  while kill -0 "$WATCHDOG_PID" 2>/dev/null; do
    CPU=$(ps -p "$WATCHDOG_PID" -o %cpu= 2>/dev/null | tr -d ' ' || echo "0")
    CPU_INT=${CPU%.*}
    MEM=$(ps -p "$WATCHDOG_PID" -o rss= 2>/dev/null | awk '{printf "%.0f", $1/1024}' || echo "0")
    if [ "${CPU_INT:-0}" -ge 85 ]; then
      high_count=$((high_count + 1))
      printf "[%s] CPU:%s%% MEM:%sMB (%ds)\n" "$(date +%H:%M:%S)" "$CPU" "$MEM" "$high_count"
      if [ "$high_count" -eq 3 ]; then
        sample_count=$((sample_count + 1))
        f="$PROFILE_DIR/sample-${sample_count}.txt"
        echo "→ sampling 5s..."
        sample "$WATCHDOG_PID" 5 -file "$f" 2>/dev/null || true
      fi
    else
      [ "$high_count" -gt 0 ] && printf "[%s] CPU:%s%% (恢复)\n" "$(date +%H:%M:%S)" "$CPU"
      high_count=0
    fi
    sleep 1
  done
  echo ""
  echo "进程已退出，采样: $sample_count 次"
  exit 0
fi

# ====================================================================
# 主模式：启动二进制
# ====================================================================

# 选择二进制
if [ -z "$DIAG_BINARY" ]; then
  $USE_DEV && DIAG_BINARY="./cli-dev" || DIAG_BINARY="./ola-cc-dev"
fi
if [ ! -f "$DIAG_BINARY" ]; then
  for try in "./ola-cc-dev" "./cli-dev" "./cli"; do
    [ -f "$try" ] && DIAG_BINARY="$try" && break
  done
fi
if [ ! -f "$DIAG_BINARY" ]; then
  echo "错误: 找不到二进制。请先构建: bun run build:dev"
  exit 1
fi

PROFILE_DIR="/tmp/cpu-diagnose-$(date +%Y%m%d_%H%M%S)"
mkdir -p "$PROFILE_DIR"
COMMIT_LOG="$PROFILE_DIR/commits.log"
STDERR_LOG="$PROFILE_DIR/stderr.log"

CLEANUP_PID=""
cleanup() {
  local ec=$?
  if [ -n "$CLEANUP_PID" ] && kill -0 "$CLEANUP_PID" 2>/dev/null; then
    kill -TERM "$CLEANUP_PID" 2>/dev/null || true
  fi
  exit $ec
}
trap cleanup EXIT INT TERM

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║        Agent CPU 全面诊断                               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "二进制: $DIAG_BINARY"
echo "输出:   $PROFILE_DIR"
echo ""

# 检查是否可以通过 $$ 传递 PID
# 如果是直接运行的脚本，"$$" 就是当前 shell 的 PID
# 但 exec 后 shell PID 会被替换，所以需要在 exec 前显示提示
SHELL_PID=$$

if [ -n "$PROMPT" ]; then
  echo "模式: 非交互 (prompt模式)"
  echo "命令: OLA_CC_CPU_DEBUG=1 OLA_CC_COMMIT_LOG=$COMMIT_LOG $DIAG_BINARY -p \"$PROMPT\""
  echo ""
  echo "在另一个终端启动看门狗:"
  echo "  $0 --watchdog \$!"
  echo ""
  echo "或先启动看门狗，再运行本命令:"
  echo "  终端1: sleep 9999 &  $0 --watchdog \$!"
  echo "  终端2: OLA_CC_CPU_DEBUG=1 OLA_CC_COMMIT_LOG=$COMMIT_LOG $DIAG_BINARY -p \"$PROMPT\" 2>$STDERR_LOG"
  echo ""
  echo "按任意键启动..."
  read -r -n 1 -s
  echo ""

  OLA_CC_CPU_DEBUG=1 OLA_CC_COMMIT_LOG="$COMMIT_LOG" \
    "$DIAG_BINARY" -p "$PROMPT" --max-turns 30 2>"$STDERR_LOG" &
  PID=$!
  CLEANUP_PID=$PID
  wait "$PID" 2>/dev/null || true
else
  echo "模式: 交互 (TUI)"
  echo ""
  echo "=== 步骤 1 ==="
  echo "打开另一个终端，运行:"
  echo "  cd $(pwd) && $0 --watchdog \$\$"
  echo ""
  echo "=== 步骤 2 ==="
  echo "在这个窗口中操作 ola-cc 复现卡死问题"
  echo ""
  echo "=== 步骤 3 ==="
  echo "退出 ola-cc 后，生成报告:"
  echo "  $0 --analyze $PROFILE_DIR"
  echo ""
  echo "按任意键启动..."
  read -r -n 1 -s
  echo ""

  # 前台启动（stdout=终端, stderr→文件, stdin=终端）
  # 用 exec 让进程直接替换当前 shell 进程，完全保持前台
  OLA_CC_CPU_DEBUG=1 OLA_CC_COMMIT_LOG="$COMMIT_LOG" \
    exec "$DIAG_BINARY" 2>"$STDERR_LOG"
fi
