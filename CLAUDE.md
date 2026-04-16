# CLAUDE.md - Claude Code Configuration

## Project Overview

This is a restored Claude Code source tree reconstructed from source maps. The project builds a CLI tool using Bun.

## Build & Development

**Package Manager:** Bun 1.3.5+

```bash
# Development
bun run dev                    # Start development mode
bun run build:dev              # Build development binary
bun run build:dev:full         # Build with all experimental features

# Production
bun run build                  # Build production binary (outputs to ./cli)
bun run compile                # Build compiled binary (outputs to ./dist/cli)

# Publish build (Node.js compatible)
bun run ./scripts/build-publish.ts
```

## Output Structure

- `./cli` - Development binary (Bun bytecode)
- `./cli-dev` - Development mode binary
- `dist/publish/` - npm publish ready package
  - `cli.js` - Cross-platform JS bundle (~10MB, Node.js compatible)
  - `package.json` - Clean publish config
  - `vendor/` - Optional native dependencies

## Key Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start interactive development session |
| `bun run build` | Production build to `./cli` |
| `bun run build:dev` | Dev build to `./cli-dev` |
| `bun run start` | Alias for `dev` |

## Feature Flags

Available via `--feature=<NAME>` or `--feature-set=dev-full`:

- `VOICE_MODE`, `BUDDY` (default)
- `DAEMON`, `BG_SESSIONS`, `TEMPLATES`
- `BRIDGE_MODE`, `BYOC_ENVIRONMENT_RUNNER`
- And many experimental features (see `scripts/build.ts`)

## Architecture Notes

- **Entry point:** `src/entrypoints/cli.tsx`
- **Build tool:** Bun bundler with bytecode compilation
- **Runtime:** Bun (dev) or Node.js 18+ (publish build)
- **UI framework:** Ink (React for terminal)

## Publishing to npm

```bash
cd dist/publish
npm publish --dry-run    # Preview
npm publish              # Publish
```

The `dist/publish/package.json` is configured for npm with:
- Name: `ola-cc`
- Node.js compatibility: `>=18.0.0`
- Minimal dependencies (only `ws`)

## Node.js Version Check

The CLI checks for Node.js 18+ at startup when running the publish build.

## Important Files

- `scripts/build.ts` - Main build script
- `scripts/build-publish.ts` - npm publish build script
- `src/entrypoints/cli.tsx` - CLI entry point with version check
- `.claude/settings.local.json` - Claude Code permissions
