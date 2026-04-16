# WASM Module Transformation Design

**Date:** 2026-04-16
**Branch:** feature-rust
**Author:** Claude Code

## Overview

Transform computation-heavy TypeScript modules in the Claude Code CLI into Rust + WASM for performance, security, portability, and bundle size benefits.

## Goals

1. **Performance** — CPU-heavy operations (diff, Unicode width calculation, ANSI rendering) move to native-speed Rust
2. **Security** — Sandboxed execution via WASM memory bounds and import restrictions
3. **Portability** — Single WASM binary replaces platform-specific native modules
4. **Bundle size** — Replace multiple JS dependencies with compact WASM blobs

## Transformation Priority Order

### Phase 1: `stringWidth` (highest ROI, smallest scope)
### Phase 2: `diff` utilities
### Phase 3: `vim` operators/motions/textObjects
### Phase 4: `ansiToPng` / terminal rendering
### Phase 5: `memdir` (largest, most complex)

---

## Phase 1: stringWidth WASM

### Current State
- File: `src/ink/stringWidth.ts`
- Dependencies: `emoji-regex`, `get-east-asian-width`
- Purpose: Calculate terminal display width of strings
- Hot path: called on every render for every line

### WASM Design
- Rust crate: `crates/string-width/`
- Exports: `fn string_width(s: &str) -> usize`
- Unicode data embedded via `unicode-width` crate + emoji handling
- Build: `wasm-pack build --target bundler`
- Integration: Replace TS import with WASM wrapper, fallback to JS if WASM fails

### Interface
```rust
#[wasm_bindgen]
pub fn string_width(s: &str) -> usize {
    // Unicode width calculation
}
```

---

## Phase 2: Diff Utilities WASM

### Current State
- Files: `src/utils/diff.ts`, `src/components/diff/`, `src/components/StructuredDiff/`
- Dependencies: `diff` (npm), `color-diff-napi` (shim)
- Purpose: Compute and render diffs for file edits

### WASM Design
- Rust crate: `crates/diff-engine/`
- Exports:
  - `fn compute_diff(old: &str, new: &str, context: usize) -> DiffResult`
  - `fn color_diff(hunks: &[Hunk]) -> ColoredOutput`
- Replace `diff` npm package for core computation
- Keep TS/React components for rendering, feed them WASM-computed hunks

### Interface
```rust
#[wasm_bindgen]
pub struct DiffResult { /* hunks, stats */ }

#[wasm_bindgen]
pub fn compute_diff(old: &str, new: &str, context_lines: u32) -> DiffResult;
```

---

## Phase 3: Vim Text Engine WASM

### Current State
- Files: `src/vim/operators.ts` (556 lines), `src/vim/motions.ts` (82), `src/vim/textObjects.ts` (186), `src/vim/transitions.ts` (490), `src/vim/types.ts` (199)
- Purpose: Vim editing commands (delete, change, yank, motions, text objects)
- Pure functions with `Cursor` and text state

### WASM Design
- Rust crate: `crates/vim-engine/`
- Data model: `VimBuffer` struct with text content, cursor position, marks, registers
- Exports:
  - `fn execute_operator(buffer: &mut VimBuffer, op: Operator, motion: Motion)`
  - `fn find_text_object(buffer: &VimBuffer, scope: TextObjScope) -> Range`
  - `fn resolve_motion(buffer: &VimBuffer, motion: Motion, count: u32) -> Cursor`
- Eliminate TS vim logic entirely, replace with WASM calls

### Interface
```rust
#[wasm_bindgen]
pub struct VimBuffer {
    text: String,
    cursor: usize,
    // marks, registers, etc.
}

#[wasm_bindgen]
impl VimBuffer {
    pub fn delete(&mut self, motion: &str, count: u32) -> String;
    pub fn change(&mut self, motion: &str, count: u32);
    pub fn yank(&self, motion: &str, count: u32) -> String;
    pub fn move_cursor(&mut self, motion: &str, count: u32);
}
```

---

## Phase 4: ANSI-to-PNG Rendering WASM

### Current State
- File: `src/utils/ansiToPng.ts` (215K lines(!)) — likely bundler-bloated
- Dependencies: `color-diff-napi` (shim), `ansi-to-svg`
- Purpose: Convert ANSI terminal output to images

### WASM Design
- Rust crate: `crates/ansi-renderer/`
- Exports:
  - `fn ansi_to_png(ansi_text: &str, opts: RenderOpts) -> Vec<u8>`
  - `fn ansi_to_svg(ansi_text: &str, opts: RenderOpts) -> String`
- Use `rusttype` or `ab_glyph` for font rendering, `png` crate for output
- Massive bundle size reduction from 215K lines to ~few hundred KB WASM

---

## Phase 5: Memdir WASM

### Current State
- Directory: `src/memdir/` (~100K lines across 20 files)
- Purpose: Persistent memory system for Claude Code sessions
- Components: storage, recall, relevance scoring, quality metrics, auto-pruning, security

### WASM Design
- Rust crate: `crates/memdir/`
- Split into sub-crates:
  - `memdir-core` — data types, scoring algorithms, TF-IDF engine
  - `memdir-storage` — SQLite-backed storage (via `wasm-bindgen` + OPFS or WASI)
  - `memdir-security` — access control, sandboxing
- Pure computation (scoring, relevance) → WASM
- I/O (file operations) → keep as TS host calls via WASM imports

---

## Cross-Cutting Concerns

### Build System
```
crates/
  string-width/
  diff-engine/
  vim-engine/
  ansi-renderer/
  memdir/
    memdir-core/
    memdir-storage/
    memdir-security/
```

- Toolchain: `wasm-pack` for WASM builds
- CI: Add WASM build step to `scripts/build.ts`
- Fallback: JS fallback for environments without WASM support

### Integration Pattern
Each WASM module follows the same pattern:
1. Rust crate with `#[wasm_bindgen]` exports
2. TypeScript wrapper: `src/wasm/stringWidth.ts` — loads WASM, provides same API as original
3. Feature flag: `--feature=wasm_modules` to enable
4. Fallback: If WASM load fails, use original JS implementation

### Testing
- Rust: unit tests in each crate (`#[cfg(test)]`)
- Integration: run existing TS tests against WASM-backed implementation
- Property-based: `proptest` in Rust for edge cases (Unicode, empty strings, etc.)
