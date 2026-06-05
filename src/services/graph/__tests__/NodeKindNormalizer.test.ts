/**
 * Tests for NodeKindNormalizer
 */

import { describe, test, expect } from 'bun:test'
import { normalizeKind, isValidKind, VALID_KINDS, getKindAliases } from '../NodeKindNormalizer.js'

describe('NodeKindNormalizer', () => {
  describe('normalizeKind', () => {
    // ── Abbreviation aliases ──
    test.each([
      ['fn', 'function'],
      ['func', 'function'],
      ['cls', 'class'],
      ['mod', 'module'],
      ['ns', 'namespace'],
      ['iface', 'interface'],
      ['intf', 'interface'],
      ['enum_type', 'enum'],
      ['const', 'constant'],
      ['var', 'variable'],
      ['param', 'parameter'],
      ['proc', 'procedure'],
      ['comp', 'component'],
      ['ctor', 'constructor'],
      ['dtor', 'destructor'],
      ['prop', 'property'],
      ['deco', 'decorator'],
      ['annot', 'annotation'],
    ])('alias "%s" → "%s"', (input, expected) => {
      expect(normalizeKind(input)).toBe(expected)
    })

    // ── Language-specific aliases ──
    test.each([
      ['struct', 'class'],
      ['trait', 'interface'],
      ['protocol', 'interface'],
      ['impl', 'method'],
      ['class_method', 'method'],
      ['instance_method', 'method'],
      ['static_method', 'method'],
    ])('language alias "%s" → "%s"', (input, expected) => {
      expect(normalizeKind(input)).toBe(expected)
    })

    // ── Infrastructure aliases ──
    test.each([
      ['route', 'endpoint'],
      ['handler', 'endpoint'],
      ['controller', 'endpoint'],
      ['typedef', 'type_alias'],
      ['typealias', 'type_alias'],
      ['using', 'type_alias'],
      ['package', 'module'],
      ['svc', 'service'],
      ['mw', 'middleware'],
      ['cfg', 'config'],
      ['conf', 'config'],
    ])('infra alias "%s" → "%s"', (input, expected) => {
      expect(normalizeKind(input)).toBe(expected)
    })

    // ── Canonical pass-through ──
    // Note: 'constructor' is excluded from test.each because bun:test treats it as a built-in property.
    // It is tested explicitly below.
    test.each(VALID_KINDS.filter(k => k !== 'constructor'))('canonical "%s" passes through', (kind) => {
      expect(normalizeKind(kind)).toBe(kind)
    })

    test('canonical "constructor" passes through', () => {
      expect(normalizeKind('constructor')).toBe('constructor')
    })

    // ── Case insensitivity ──
    test('handles uppercase input', () => {
      expect(normalizeKind('FUNCTION')).toBe('function')
      expect(normalizeKind('Class')).toBe('class')
      expect(normalizeKind('FN')).toBe('function')
    })

    // ── Whitespace handling ──
    test('trims whitespace', () => {
      expect(normalizeKind('  function  ')).toBe('function')
      expect(normalizeKind('\tclass\n')).toBe('class')
    })

    // ── Prefix/suffix stripping ──
    test('strips common prefixes', () => {
      expect(normalizeKind('async_function')).toBe('function')
      expect(normalizeKind('abstract_class')).toBe('class')
      expect(normalizeKind('virtual_method')).toBe('method')
    })

    test('strips common suffixes', () => {
      expect(normalizeKind('function_type')).toBe('function')
      expect(normalizeKind('class_def')).toBe('class')
    })

    // ── Fallback to unknown ──
    test('returns "unknown" for unrecognized kinds', () => {
      expect(normalizeKind('something_weird')).toBe('unknown')
      expect(normalizeKind('xyz123')).toBe('unknown')
    })

    // ── Edge cases ──
    test('handles empty/null/undefined', () => {
      expect(normalizeKind('')).toBe('unknown')
      expect(normalizeKind(null as any)).toBe('unknown')
      expect(normalizeKind(undefined as any)).toBe('unknown')
    })

    // ── Misc alias categories ──
    test.each([
      ['accessor', 'getter'],
      ['mutator', 'setter'],
      ['indexer', 'property'],
      ['delegate', 'function'],
      ['callback', 'function'],
      ['coroutine', 'function'],
      ['async_function', 'function'],
      ['generator', 'function'],
      ['iterator', 'function'],
      ['resolver', 'function'],
      ['factory', 'function'],
      ['builder', 'class'],
      ['singleton', 'class'],
      ['record', 'class'],
      ['data_class', 'class'],
      ['value_object', 'class'],
      ['entity', 'class'],
      ['aggregate', 'class'],
      ['vo', 'class'],
      ['dto', 'class'],
    ])('misc alias "%s" → "%s"', (input, expected) => {
      expect(normalizeKind(input)).toBe(expected)
    })
  })

  describe('isValidKind', () => {
    test('returns true for all canonical kinds', () => {
      for (const kind of VALID_KINDS) {
        expect(isValidKind(kind)).toBe(true)
      }
    })

    test('returns true for canonical kinds regardless of case', () => {
      expect(isValidKind('Function')).toBe(true)
      expect(isValidKind('CLASS')).toBe(true)
    })

    test('returns false for aliases (they are not canonical)', () => {
      expect(isValidKind('fn')).toBe(false)
      expect(isValidKind('cls')).toBe(false)
      expect(isValidKind('struct')).toBe(false)
    })

    test('returns false for empty/null/undefined', () => {
      expect(isValidKind('')).toBe(false)
      expect(isValidKind(null as any)).toBe(false)
      expect(isValidKind(undefined as any)).toBe(false)
    })
  })

  describe('VALID_KINDS', () => {
    test('contains expected minimum count (canonical kinds)', () => {
      expect(VALID_KINDS.length).toBeGreaterThanOrEqual(30)
    })

    test('contains no duplicates', () => {
      const unique = new Set(VALID_KINDS)
      expect(unique.size).toBe(VALID_KINDS.length)
    })

    test('all entries are lowercase', () => {
      for (const kind of VALID_KINDS) {
        expect(kind).toBe(kind.toLowerCase())
      }
    })
  })

  describe('getKindAliases', () => {
    test('returns a copy (not mutating original)', () => {
      const a1 = getKindAliases()
      a1['test_key'] = 'test_value'
      const a2 = getKindAliases()
      expect(a2['test_key']).toBeUndefined()
    })

    test('contains expected alias entries', () => {
      const aliases = getKindAliases()
      expect(aliases['fn']).toBe('function')
      expect(aliases['cls']).toBe('class')
      expect(aliases['struct']).toBe('class')
      expect(aliases['trait']).toBe('interface')
    })
  })
})
