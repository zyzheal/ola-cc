#!/bin/bash
# scripts/setup-nats.sh - NATS Server 一键启动脚本
# 用法: ./scripts/setup-nats.sh [start|stop|status|install|restart]

set -e

NATS_VERSION="2.10.25"
NATS_DIR="$HOME/.nats"
NATS_BIN="$NATS_DIR/nats-server"
NATS_LOG="/tmp/nats-server.log"
NATS_PID="/tmp/nats-server.pid"

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    ARCH="amd64"
elif [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
    ARCH="arm64"
fi

install_nats() {
    echo "📦 Installing NATS server v${NATS_VERSION}..."
    mkdir -p "$NATS_DIR"

    if command -v nats-server &> /dev/null; then
        echo "✅ NATS server already installed: $(which nats-server)"
        return 0
    fi

    if [ -x "$NATS_BIN" ]; then
        echo "✅ NATS server already installed: $NATS_BIN"
        return 0
    fi

    DOWNLOAD_URL="https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-${PLATFORM}-${ARCH}.tar.gz"
    echo "⬇️  Downloading from: ${DOWNLOAD_URL}"

    curl -sL "$DOWNLOAD_URL" -o "$NATS_DIR/nats-server.tar.gz"
    tar -xzf "$NATS_DIR/nats-server.tar.gz" -C "$NATS_DIR"

    EXTRACTED_DIR="$NATS_DIR/nats-server-v${NATS_VERSION}-${PLATFORM}-${ARCH}"
    mv "$EXTRACTED_DIR/nats-server" "$NATS_BIN"
    chmod +x "$NATS_BIN"

    rm -rf "$NATS_DIR/nats-server.tar.gz" "$EXTRACTED_DIR"

    echo "✅ NATS server installed: $NATS_BIN"
}

start_nats() {
    if [ -f "$NATS_PID" ] && kill -0 "$(cat "$NATS_PID")" 2>/dev/null; then
        echo "✅ NATS server is already running (PID: $(cat "$NATS_PID"))"
        return 0
    fi

    # Check system PATH first
    if command -v nats-server &> /dev/null; then
        NATS_BIN=$(which nats-server)
    elif [ ! -x "$NATS_BIN" ]; then
        echo "❌ NATS server not found. Run './scripts/setup-nats.sh install' first."
        return 1
    fi

    echo "🚀 Starting NATS server..."
    "$NATS_BIN" -p 4222 -js --log "$NATS_LOG" &
    echo $! > "$NATS_PID"

    sleep 2

    if kill -0 "$(cat "$NATS_PID")" 2>/dev/null; then
        echo "✅ NATS server started (PID: $(cat "$NATS_PID"))"
        echo "📋 Log file: $NATS_LOG"
    else
        echo "❌ Failed to start NATS server. Check log: $NATS_LOG"
        rm -f "$NATS_PID"
        return 1
    fi
}

stop_nats() {
    if [ -f "$NATS_PID" ] && kill -0 "$(cat "$NATS_PID")" 2>/dev/null; then
        echo "🛑 Stopping NATS server (PID: $(cat "$NATS_PID"))..."
        kill "$(cat "$NATS_PID")"
        rm -f "$NATS_PID"
        echo "✅ NATS server stopped"
    else
        echo "ℹ️  NATS server is not running"
    fi
}

status_nats() {
    if [ -f "$NATS_PID" ] && kill -0 "$(cat "$NATS_PID")" 2>/dev/null; then
        echo "✅ NATS server is running (PID: $(cat "$NATS_PID"))"
        echo "📋 Log: $NATS_LOG"
    else
        echo "❌ NATS server is not running"
        echo "   Run './scripts/setup-nats.sh start' to start"
    fi
}

case "${1:-status}" in
    install) install_nats ;;
    start)   start_nats ;;
    stop)    stop_nats ;;
    status)  status_nats ;;
    restart) stop_nats && start_nats ;;
    *)
        echo "Usage: $0 {install|start|stop|status|restart}"
        exit 1
        ;;
esac
