# WASM Module Transformation - Implementation Plan

**Date:** 2026-04-16
**Branch:** feature-rust
**Based on:** docs/superpowers/specs/2026-04-16-wasm-module-transformation-design.md

## Overview

This plan details the step-by-step implementation of transforming TypeScript modules to Rust + WASM in the Claude Code CLI. Each phase is independently completable and testable.

## Architecture

```
crates/
  string-width/          # Phase 1: terminal string width calculation
    Cargo.toml
    src/lib.rs           # Core Rust implementation
    pkg/                 # wasm-pack output (auto-generated)
  diff-engine/           # Phase 2: diff computation (planned)
  vim-engine/            # Phase 3: vim text operations (planned)
  ansi-renderer/         # Phase 4: ANSI to image rendering (planned)
  memdir/                # Phase 5: memory system (planned)
src/wasm/
  stringWidth.ts         # TypeScript WASM wrapper
  pkg/string_width.js    # Generated WASM bindings
```

## Phase 1: stringWidth WASM Module

### Goal
Replace `src/ink/stringWidth.ts` hot-path computation with Rust WASM.

### Implementation Steps

#### Step 1: Create Rust Crate
- [x] `crates/string-width/Cargo.toml` -- dependencies: `wasm-bindgen`, `unicode-width`
- [x] `crates/string-width/src/lib.rs` -- core implementation
- [x] `crates/Cargo.toml` -- workspace root

#### Step 2: Rust Implementation Details
The Rust implementation replicates the TypeScript behavior:

| Feature | TS Implementation | Rust Implementation |
|---------|------------------|---------------------|
| ASCII fast path | byte scan | `bytes().all()` |
| ANSI stripping | regex-like scan | character iterator |
| Zero-width chars | explicit ranges in `isZeroWidth()` | match arms in `is_zero_width()` |
| East Asian width | `get-east-asian-width` npm | `unicode-width` crate |
| Emoji width | `emoji-regex` + heuristics | codepoint range checks |
| Regional indicators | grapheme loop | state machine (prev_was_regional) |

Key design decisions:
- No `unicode-segmentation` dependency -- avoid pulling in large Unicode data tables
- State machine for regional indicators instead of grapheme clustering
- `unicode-width` crate provides UAX#11 compliant width calculation
- Emoji detection uses simplified codepoint ranges (matches TS `needsSegmentation`)

#### Step 3: Build with wasm-pack
```bash
cd crates/string-width
wasm-pack build --target bundler
```
Output: `crates/string-width/pkg/` (string_width_bg.wasm, string_width.js, etc.)

#### Step 4: TypeScript Integration
- [x] `src/wasm/stringWidth.ts` -- wrapper with JS fallback
- [x] `src/wasm/pkg/string_width.js` -- generated WASM bindings (placeholder before build)
- [ ] Update `src/ink/stringWidth.ts` to use WASM when available

#### Step 5: Feature Flag Integration
Add to build system (`scripts/build.ts`):
```typescript
const wasmModules = features.has('wasm_modules')
```

Integration pattern in `stringWidth.ts`:
```typescript
const bunStringWidth = typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
  ? Bun.stringWidth
  : null

let wasmStringWidth: ((s: string) => number) | null = null
try {
  const wasm = await import('../wasm/pkg/string_width.js')
  wasmStringWidth = wasm.string_width_wasm
} catch { /* WASM not available */ }

export const stringWidth = bunStringWidth
  ? (s) => bunStringWidth(s, BUN_STRING_WIDTH_OPTS)
  : wasmStringWidth ?? stringWidthJavaScript
```

#### Step 6: Testing
- Rust unit tests in `#[cfg(test)]` module (ASCII, CJK, emoji, ANSI, combining marks)
- TS tests in `src/wasm/stringWidth.test.ts` (consistency with JS fallback)
- Property-based tests with `proptest` for Unicode edge cases (future)

### Current Status
- [x] Rust crate scaffolded
- [x] Core implementation written
- [x] TS wrapper written
- [x] Test files written
- [ ] wasm-pack build (requires shell execution)
- [ ] Integration with existing codebase
- [ ] All tests passing

## Phase 2: Diff Utilities WASM (Planned)

### Scope
- `crates/diff-engine/` -- Rust diff computation
- Replace `diff` npm package for `structuredPatch` equivalent
- Keep TS components for rendering

### Key Exports
```rust
#[wasm_bindgen]
pub struct DiffHunk { old_start, new_start, lines }

#[wasm_bindgen]
pub fn compute_diff(old: &str, new: &str, context: u32) -> Vec<DiffHunk>
```

### Dependencies
- `similar` crate (Rust diff library)

## Phase 3: Vim Engine WASM (Planned)

### Scope
- `crates/vim-engine/` -- Vim motion/operator/text-object engine
- Replace ~1400 lines of TS vim logic

## Phase 4: ANSI Renderer WASM (Planned)

### Scope
- `crates/ansi-renderer/` -- ANSI to PNG/SVG rendering
- Replace 215K-line `src/utils/ansiToPng.ts`

## Phase 5: Memdir WASM (Planned)

### Scope
- `crates/memdir/` -- Memory system computation
- TF-IDF, relevance scoring, quality metrics

## Build Integration

### scripts/build.ts additions
1. Detect `wasm_modules` feature flag
2. Run `wasm-pack build` for enabled crates
3. Copy `.wasm` files to build output
4. Include WASM bindings in bundle

### CI considerations
- Install `wasm-pack` in CI
- Cache `~/.cargo/registry` and `target/` directories
- WASM build adds ~30s to CI time

## Rollout Strategy

1. Phase 1 lands behind feature flag (`--feature=wasm_modules`)
2. Dogfood with internal team
3. Measure performance (stringWidth calls per frame, latency)
4. If performance gains confirmed, enable by default
5. Proceed to Phase 2+

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| WASM load failure | JS fallback always available |
| Unicode edge cases | Property-based tests, compare with Bun.stringWidth |
| Bundle size increase | WASM is ~50KB gzip, smaller than npm deps |
| Build complexity | wasm-pack handles cross-compilation |
