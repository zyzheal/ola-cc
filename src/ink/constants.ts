// Minimum interval for clock tick, frame updates, and animation timing.
// 16ms (~60fps) for smooth terminal animations.
export const FRAME_INTERVAL_MS = 16

// Clock tick interval: 33ms (~30fps). Spinner animations only need ~50ms
// refresh; 16ms ticks waste CPU by driving React commits faster than they
// can complete (30-65ms each). When commit time > tick interval, ticks
// accumulate and CPU hits 100%. 33ms gives the event loop ~18ms idle time
// per tick even with a 15ms commit, preventing the positive feedback loop.
export const CLOCK_TICK_MS = 33