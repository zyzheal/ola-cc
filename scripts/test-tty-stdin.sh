#!/bin/bash
# Test TTY stdin handling for CLI in Node.js 22+
# This script uses expect to simulate terminal input

set -e

CLI_PATH="${1:-./dist/publish/cli.js}"
TIMEOUT=30

echo "=== Testing CLI stdin handling in TTY environment ==="
echo "Node.js version: $(node --version)"
echo "CLI path: $CLI_PATH"

# Create expect script
EXPECT_SCRIPT=$(mktemp)
cat > "$EXPECT_SCRIPT" << 'EXPECT_EOF'
#!/usr/bin/expect -f

set timeout 30
set cli_path [lindex $argv 0]

# Spawn the CLI
spawn node $cli_path

# Wait for the prompt/interface to appear
expect {
    -re "Message|prompt|>" {
        send_user "\n*** Detected interface, sending Enter ***\n"
        send "\r"
    }
    timeout {
        send_user "\n*** Timeout waiting for interface ***\n"
        exit 1
    }
}

# Wait a bit and send another Enter
sleep 2
send_user "\n*** Sending second Enter ***\n"
send "\r"

# Wait and send Ctrl+C to exit
sleep 3
send_user "\n*** Sending Ctrl+C ***\n"
send "\003"

# Wait for exit
expect {
    eof {
        send_user "\n*** CLI exited ***\n"
        exit 0
    }
    timeout {
        send_user "\n*** Force killing ***\n"
        close
        exit 1
    }
}
EXPECT_EOF

chmod +x "$EXPECT_SCRIPT"

# Run expect script if available
if command -v expect &> /dev/null; then
    echo "Running expect test..."
    expect "$EXPECT_SCRIPT" "$CLI_PATH"
else
    echo "expect not installed, skipping TTY test"
    echo "Install expect with: brew install expect"
fi

# Clean up
rm -f "$EXPECT_SCRIPT"

echo "=== Test complete ==="