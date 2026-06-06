/**
 * SvelteExtractor tests — verify Svelte component parsing.
 */

import { describe, test, expect } from 'bun:test'
import { SvelteExtractor } from '../extractors/svelte-extractor.js'

describe('SvelteExtractor', () => {
  test('creates component node for .svelte file', () => {
    const source = `<script>
  let name = 'world';
</script>
<h1>Hello {name}!</h1>`
    const extractor = new SvelteExtractor('/src/lib/Greeting.svelte', source)
    const result = extractor.extract()

    expect(result.nodes.length).toBeGreaterThanOrEqual(1)
    const component = result.nodes.find(n => n.kind === 'component')
    expect(component).toBeDefined()
    expect(component!.name).toBe('Greeting')
    expect(component!.file).toBe('/src/lib/Greeting.svelte')
    expect(component!.language).toBe('svelte')
    expect(component!.is_exported).toBe(true)
    expect(component!.qualified_name).toBe('/src/lib/Greeting.svelte::Greeting')
  })

  test('extracts template function calls', () => {
    const source = `<script></script>
<div class={cn('base', isActive && 'active')}>
  {formatCurrency(price)}
</div>`
    const extractor = new SvelteExtractor('/src/Price.svelte', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'cn' && r.reference_kind === 'calls')).toBe(true)
    expect(refs.some(r => r.reference_name === 'formatCurrency' && r.reference_kind === 'calls')).toBe(true)
  })

  test('extracts template component usages (PascalCase)', () => {
    const source = `<script></script>
<div>
  <Modal open={showModal}>
    <Button on:click={close}>Close</Button>
  </Modal>
</div>`
    const extractor = new SvelteExtractor('/src/App.svelte', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'Modal' && r.reference_kind === 'references')).toBe(true)
    expect(refs.some(r => r.reference_name === 'Button' && r.reference_kind === 'references')).toBe(true)
  })

  test('filters out Svelte rune calls', () => {
    const source = `<script>
  let count = $state(0);
  let doubled = $derived(count * 2);
  let { name } = $props();
</script>
<div>{doubled}</div>`
    const extractor = new SvelteExtractor('/src/Counter.svelte', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === '$state')).toBe(false)
    expect(refs.some(r => r.reference_name === '$derived')).toBe(false)
    expect(refs.some(r => r.reference_name === '$props')).toBe(false)
  })

  test('skips Svelte block syntax', () => {
    const source = `<script>
  let items = [1, 2, 3];
</script>
{#if items.length > 0}
  {#each items as item}
    <span>{item}</span>
  {/each}
{:else}
  <span>Empty</span>
{/if}`
    const extractor = new SvelteExtractor('/src/List.svelte', source)
    const result = extractor.extract()

    // Svelte block keywords (#if, #each, :else, /if) should not be extracted as calls
    const calls = result.unresolved_references.filter(r => r.reference_kind === 'calls')
    expect(calls.some(r => r.reference_name === 'if')).toBe(false)
    expect(calls.some(r => r.reference_name === 'each')).toBe(false)
    expect(calls.some(r => r.reference_name === 'else')).toBe(false)
  })

  test('skips tags inside script and style blocks', () => {
    const source = `<script>
  const x = '<FakeComponent />';
</script>
<RealComponent />
<style>
  .class { color: red; }
</style>`
    const extractor = new SvelteExtractor('/src/App.svelte', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'RealComponent')).toBe(true)
    expect(refs.some(r => r.reference_name === 'FakeComponent')).toBe(false)
  })

  test('handles TypeScript script blocks', () => {
    const source = `<script lang="ts">
  interface Props { name: string; }
  let { name }: Props = $props();
</script>
<div>{name}</div>`
    const extractor = new SvelteExtractor('/src/Typed.svelte', source)
    const result = extractor.extract()

    // Should have warning about TreeSitter not being available
    expect(result.errors.some(e => e.severity === 'warning' && e.code === 'tree_sitter_unavailable')).toBe(true)
  })

  test('handles module script context', () => {
    const source = `<script context="module">
  export function load() { return {}; }
</script>
<script>
  let data = load();
</script>
<div />`
    const extractor = new SvelteExtractor('/src/Page.svelte', source)
    const result = extractor.extract()

    // Should have warnings for both script blocks
    const warnings = result.errors.filter(e => e.severity === 'warning')
    expect(warnings.length).toBe(2)
  })

  test('records correct line numbers', () => {
    const source = `<script></script>

<div>
  <MyComp />
</div>`
    const extractor = new SvelteExtractor('/src/App.svelte', source)
    const result = extractor.extract()

    const ref = result.unresolved_references.find(r => r.reference_name === 'MyComp')
    expect(ref).toBeDefined()
    expect(ref!.line).toBe(4) // 1-indexed
  })

  test('duration_ms is non-negative', () => {
    const source = `<script></script><div />`
    const result = new SvelteExtractor('/src/App.svelte', source).extract()
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
