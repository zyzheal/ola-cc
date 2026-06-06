/**
 * VueExtractor tests — verify Vue SFC parsing.
 */

import { describe, test, expect } from 'bun:test'
import { VueExtractor } from '../extractors/vue-extractor.js'

describe('VueExtractor', () => {
  test('creates component node for .vue file', () => {
    const source = `<template><div>Hello</div></template>\n<script>export default {}</script>`
    const extractor = new VueExtractor('/src/components/App.vue', source)
    const result = extractor.extract()

    expect(result.nodes.length).toBeGreaterThanOrEqual(1)
    const component = result.nodes.find(n => n.kind === 'component')
    expect(component).toBeDefined()
    expect(component!.name).toBe('App')
    expect(component!.file).toBe('/src/components/App.vue')
    expect(component!.language).toBe('vue')
    expect(component!.is_exported).toBe(true)
    expect(component!.qualified_name).toBe('/src/components/App.vue::App')
  })

  test('extracts script block with TypeScript detection', () => {
    const source = `<template><div>Hi</div></template>
<script lang="ts">
import { ref } from 'vue'
const count = ref(0)
</script>`
    const extractor = new VueExtractor('/src/Counter.vue', source)
    const result = extractor.extract()

    // Should have a warning about TreeSitter not being available
    expect(result.errors.some(e => e.severity === 'warning' && e.code === 'tree_sitter_unavailable')).toBe(true)
  })

  test('extracts template component usages (PascalCase)', () => {
    const source = `<template>
  <div>
    <MyButton />
    <UserProfile :name="user.name" />
  </div>
</template>
<script></script>`
    const extractor = new VueExtractor('/src/App.vue', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.length).toBeGreaterThanOrEqual(2)
    expect(refs.some(r => r.reference_name === 'MyButton')).toBe(true)
    expect(refs.some(r => r.reference_name === 'UserProfile')).toBe(true)
    expect(refs[0]!.reference_kind).toBe('references')
  })

  test('converts kebab-case template tags to PascalCase', () => {
    const source = `<template>
  <div>
    <my-button />
    <user-profile-card />
  </div>
</template>
<script></script>`
    const extractor = new VueExtractor('/src/App.vue', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'MyButton')).toBe(true)
    expect(refs.some(r => r.reference_name === 'UserProfileCard')).toBe(true)
  })

  test('skips Vue built-in components', () => {
    const source = `<template>
  <div>
    <Transition><div /></Transition>
    <KeepAlive><Comp /></KeepAlive>
    <Teleport to="body"><div /></Teleport>
    <Suspense><Async /></Suspense>
  </div>
</template>
<script></script>`
    const extractor = new VueExtractor('/src/App.vue', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'Transition')).toBe(false)
    expect(refs.some(r => r.reference_name === 'KeepAlive')).toBe(false)
    expect(refs.some(r => r.reference_name === 'Teleport')).toBe(false)
    expect(refs.some(r => r.reference_name === 'Suspense')).toBe(false)
    // But Async should be captured (it's inside Suspense)
    expect(refs.some(r => r.reference_name === 'Async')).toBe(true)
  })

  test('skips lowercase HTML elements', () => {
    const source = `<template>
  <div>
    <span>Hello</span>
    <p>World</p>
    <MyComponent />
  </div>
</template>
<script></script>`
    const extractor = new VueExtractor('/src/App.vue', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'div')).toBe(false)
    expect(refs.some(r => r.reference_name === 'span')).toBe(false)
    expect(refs.some(r => r.reference_name === 'p')).toBe(false)
    expect(refs.some(r => r.reference_name === 'MyComponent')).toBe(true)
  })

  test('skips tags inside script and style blocks', () => {
    const source = `<template>
  <MyComponent />
</template>
<script>
const x = '<NotAComponent />'
</script>
<style>
.MyStyle { color: red; }
</style>`
    const extractor = new VueExtractor('/src/App.vue', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'MyComponent')).toBe(true)
    expect(refs.some(r => r.reference_name === 'NotAComponent')).toBe(false)
  })

  test('records correct line numbers for template refs', () => {
    const source = `<template>
  <div>
    <Comp />
  </div>
</template>
<script></script>`
    const extractor = new VueExtractor('/src/App.vue', source)
    const result = extractor.extract()

    const ref = result.unresolved_references.find(r => r.reference_name === 'Comp')
    expect(ref).toBeDefined()
    expect(ref!.line).toBe(3) // 1-indexed
  })

  test('handles multiple script blocks', () => {
    const source = `<template><div /></template>
<script>
const a = 1
</script>
<script setup>
const b = 2
</script>`
    const extractor = new VueExtractor('/src/App.vue', source)
    const result = extractor.extract()

    // Should have warnings for both script blocks
    const warnings = result.errors.filter(e => e.severity === 'warning')
    expect(warnings.length).toBe(2)
  })

  test('handles extraction errors gracefully', () => {
    // Empty source shouldn't crash
    const extractor = new VueExtractor('/src/Empty.vue', '')
    const result = extractor.extract()

    expect(result.nodes.length).toBeGreaterThanOrEqual(1) // component node
    expect(result.errors.length).toBe(0)
  })

  test('duration_ms is non-negative', () => {
    const source = `<template><div /></template><script></script>`
    const result = new VueExtractor('/src/App.vue', source).extract()
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
