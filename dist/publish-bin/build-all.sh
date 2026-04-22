#!/bin/bash
# Build all platform binary packages
# Run this on each target platform (or CI matrix) to compile binaries

set -e

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Ola CC Binary Distribution Builder ==="
echo ""

# Build the current platform's binary package
cd "$ROOT_DIR"
bun run ./scripts/build-publish-bin.ts --only-bin

echo ""
echo "=== Build Complete ==="
echo ""
echo "Publish all packages:"
echo "  npm publish dist/publish/"
echo "  npm publish dist/publish-bin/darwin-arm64/"
echo "  npm publish dist/publish-bin/darwin-x64/"
echo "  npm publish dist/publish-bin/linux-x64/"
echo "  npm publish dist/publish-bin/linux-arm64/"
echo "  npm publish dist/publish-bin/linux-x64-musl/"
echo "  npm publish dist/publish-bin/linux-arm64-musl/"
echo "  npm publish dist/publish-bin/win32-x64/"
echo "  npm publish dist/publish-bin/win32-arm64/"
