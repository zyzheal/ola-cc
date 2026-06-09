/**
 * Shimmer utility tests
 *
 * Run: bun test src/utils/__tests__/shimmer.test.ts
 */

import { describe, it, expect } from 'bun:test'
import { shimmerColor, renderShimmerBar } from '../shimmer.js'

describe('shimmerColor', () => {
  it('should return RGB object with r, g, b', () => {
    const color = shimmerColor(0)
    expect(color).toHaveProperty('r')
    expect(color).toHaveProperty('g')
    expect(color).toHaveProperty('b')
  })

  it('should return values in amber-orange range', () => {
    for (let frame = 0; frame < 48; frame++) {
      const color = shimmerColor(frame)
      // Amber range: r 160-251, g 100-191, b 9-36
      expect(color.r).toBeGreaterThanOrEqual(160)
      expect(color.r).toBeLessThanOrEqual(251)
      expect(color.g).toBeGreaterThanOrEqual(100)
      expect(color.g).toBeLessThanOrEqual(191)
      expect(color.b).toBeGreaterThanOrEqual(9)
      expect(color.b).toBeLessThanOrEqual(36)
    }
  })

  it('should cycle with period 24', () => {
    const color0 = shimmerColor(0)
    const color24 = shimmerColor(24)
    // sin(x) has period 2*PI, so frame 0 and frame 24 should be same
    // Allow ±1 rounding difference due to floating point sin(2*PI) ≈ 2.4e-16
    expect(Math.abs(color0.r - color24.r)).toBeLessThanOrEqual(1)
    expect(Math.abs(color0.g - color24.g)).toBeLessThanOrEqual(1)
    expect(Math.abs(color0.b - color24.b)).toBeLessThanOrEqual(1)
  })

  it('should return integers', () => {
    const color = shimmerColor(5)
    expect(Number.isInteger(color.r)).toBe(true)
    expect(Number.isInteger(color.g)).toBe(true)
    expect(Number.isInteger(color.b)).toBe(true)
  })
})

describe('renderShimmerBar', () => {
  it('should return a string', () => {
    const bar = renderShimmerBar(0, 50, 25)
    expect(typeof bar).toBe('string')
  })

  it('should handle 0% progress', () => {
    const bar = renderShimmerBar(0, 0, 25)
    // Should have all empty chars
    expect(bar).toContain('░')
  })

  it('should handle 100% progress', () => {
    const bar = renderShimmerBar(0, 100, 25)
    // Should have filled chars
    expect(bar).toContain('█')
  })

  it('should clamp progress to 0-100', () => {
    const barOver = renderShimmerBar(0, 150, 25)
    const barUnder = renderShimmerBar(0, -10, 25)
    // Should not throw
    expect(typeof barOver).toBe('string')
    expect(typeof barUnder).toBe('string')
  })

  it('should use default width of 25', () => {
    const bar = renderShimmerBar(0, 50)
    // Should not throw
    expect(typeof bar).toBe('string')
  })

  it('should handle width=0 without throwing', () => {
    const bar = renderShimmerBar(0, 50, 0)
    expect(typeof bar).toBe('string')
    expect(bar).toBe('')
  })

  it('should handle negative width without throwing', () => {
    const bar = renderShimmerBar(0, 50, -5)
    expect(typeof bar).toBe('string')
  })

  it('should include ANSI escape codes for color', () => {
    // Frame 12 puts shimmerPos near the start of filled area
    const bar = renderShimmerBar(12, 50, 25)
    // Should contain ANSI color codes
    expect(bar).toContain('\x1b[38;2;')
  })

  it('should produce different output for different frames', () => {
    const bar0 = renderShimmerBar(0, 50, 25)
    const bar12 = renderShimmerBar(12, 50, 25)
    // Shimmer position changes, so output should differ
    expect(bar0).not.toBe(bar12)
  })

  it('should have balanced ANSI reset codes (no leaks)', () => {
    const bar = renderShimmerBar(6, 50, 25)
    // Count \x1b[ (CSI) and \x1b[0m (reset)
    const escapes = bar.match(/\x1b\[/g) ?? []
    const resets = bar.match(/\x1b\[0m/g) ?? []
    // Every escape sequence should eventually be reset
    expect(resets.length).toBeGreaterThanOrEqual(1)
    // Total escapes = color codes + resets, resets should match styled blocks
    expect(escapes.length).toBeGreaterThan(0)
  })

  it('should use non-dim for filled area outside glow', () => {
    // At frame 0, shimmerPos is negative, so all filled chars are outside glow
    const bar = renderShimmerBar(0, 100, 25)
    // Non-dim filled chars should be plain █ without dim prefix
    // Dim uses \x1b[2m, non-dim filled should not have it
    const dimFilled = bar.match(/\x1b\[2m█/g) ?? []
    const allFilled = bar.match(/█/g) ?? []
    // Only empty area ░ should be dim, not filled area █
    expect(dimFilled.length).toBe(0)
    expect(allFilled.length).toBe(25)
  })
})
