# Node.js 22+ TTY stdin handling fix

## Problem
In Node.js 22+ TTY environments, pressing Enter key in the published CLI build (dist/publish/cli.js) did not work. The stdin 'readable' events were not firing properly.

## Root Cause
Node.js 22+ has stricter Readable stream state management. The key issue is the interaction between:

1. `on('readable')` sets `flowing = false` (paused mode)
2. `resume()` sets `flowing = true` (flowing mode)

If the stream state is not properly managed when transitioning between early input capture and Ink's stdin handling, the 'readable' events won't fire.

## Fix Implementation

### 1. startCapturingEarlyInput() - src/utils/earlyInput.ts
**Before (bug):**
```typescript
process.stdin.on('readable', readableHandler)
// Missing: resume() call!
```

**After (fixed):**
```typescript
// Node.js 22+ fix: resume MUST be called AFTER adding the 'readable' listener
process.stdin.on('readable', readableHandler)
process.stdin.resume()
```

### 2. stopCapturingEarlyInput() - src/utils/earlyInput.ts
**Before (bug):**
```typescript
process.stdin.removeListener('readable', readableHandler)
process.stdin.setRawMode(false)
// Missing: pause() call before setRawMode!
```

**After (fixed):**
```typescript
// Node.js 22+ fix: pause first to reset stream state
process.stdin.pause()
if (process.stdin.setRawMode) {
  process.stdin.setRawMode(false)
}
```

### 3. handleSetRawMode() - src/ink/components/App.tsx
**Before (bug):**
```typescript
stopCapturingEarlyInput();
// Drain stdin
while (stdin.read() !== null) { /* drain */ }
stdin.setRawMode(true);
stdin.addListener('readable', this.handleReadable);
stdin.resume();
```

**After (fixed):**
```typescript
stopCapturingEarlyInput();
// Node.js 22 fix: resume to enable draining after pause
stdin.resume();
// Drain stdin
while (stdin.read() !== null) { /* drain */ }
// Node.js 22 fix: pause before adding listener
stdin.pause();
stdin.setRawMode(true);
stdin.addListener('readable', this.handleReadable);
// Node.js 22+ fix: resume AFTER adding listener
stdin.resume();
```

## Stream State Flow (Fixed)

The complete stream state flow now looks like:

1. **Initial:** `flowing = null` (initial state)
2. **After addListener('readable'):** `flowing = false` (paused)
3. **After resume():** `flowing = true` (flowing) - events fire
4. **After removeListener('readable'):** `flowing = true` (still flowing)
5. **After pause():** `flowing = false` (paused) - clean reset
6. **After setRawMode(false):** `flowing = false` (paused)
7. **In handleSetRawMode - resume for drain:** `flowing = true` (flowing)
8. **After drain:** `flowing = true` (flowing)
9. **Pause before addListener:** `flowing = false` (paused)
10. **After setRawMode(true):** `flowing = false` (paused)
11. **After addListener('readable'):** `flowing = false` (paused)
12. **After final resume():** `flowing = true` (flowing) - events fire correctly!

## Verification

To verify the fix works, run in a real TTY terminal:

```bash
node scripts/verify-node22-auto.js
```

Or run the CLI and press Enter:

```bash
node dist/publish/cli.js
# Press Enter - should work now
```

## Files Changed

1. `src/utils/earlyInput.ts` - Added `resume()` after `on('readable')` and `pause()` before `setRawMode(false)`
2. `src/ink/components/App.tsx` - Added `resume()` before drain and `pause()` before `addListener('readable')`

## Bundle Verification

The fixes are confirmed in the bundle:
- `stdin.on("readable",eS6),process.stdin.resume` - earlyInput start fix
- `stdin.removeListener("readable",eS6)...stdin.pause` - earlyInput stop fix
- `K.resume()...K.pause()...addListener("readable")...K.resume` - handleSetRawMode fix