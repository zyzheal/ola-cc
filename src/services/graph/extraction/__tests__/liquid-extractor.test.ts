/**
 * LiquidExtractor tests — verify Liquid template parsing.
 */

import { describe, test, expect } from 'bun:test'
import { LiquidExtractor } from '../extractors/liquid-extractor.js'

describe('LiquidExtractor', () => {
  test('creates file node for liquid template', () => {
    const source = `<h1>{{ page.title }}</h1>`
    const extractor = new LiquidExtractor('/templates/page.liquid', source)
    const result = extractor.extract()

    expect(result.nodes.length).toBeGreaterThanOrEqual(1)
    const fileNode = result.nodes.find(n => n.kind === 'file')
    expect(fileNode).toBeDefined()
    expect(fileNode!.name).toBe('page.liquid')
    expect(fileNode!.language).toBe('liquid')
    expect(fileNode!.qualified_name).toBe('/templates/page.liquid')
  })

  test('extracts render references', () => {
    const source = `{% render 'product-card' with product as item %}
{% render 'price-badge' %}`
    const extractor = new LiquidExtractor('/templates/collection.liquid', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'snippets/product-card.liquid')).toBe(true)
    expect(refs.some(r => r.reference_name === 'snippets/price-badge.liquid')).toBe(true)
  })

  test('extracts include references', () => {
    const source = `{% include 'header' %}
{% include 'footer' %}`
    const extractor = new LiquidExtractor('/templates/layout.liquid', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'snippets/header.liquid')).toBe(true)
    expect(refs.some(r => r.reference_name === 'snippets/footer.liquid')).toBe(true)
  })

  test('extracts section references', () => {
    const source = `{% section 'hero-banner' %}
{% section 'featured-products' %}`
    const extractor = new LiquidExtractor('/templates/index.liquid', source)
    const result = extractor.extract()

    const refs = result.unresolved_references
    expect(refs.some(r => r.reference_name === 'sections/hero-banner.liquid')).toBe(true)
    expect(refs.some(r => r.reference_name === 'sections/featured-products.liquid')).toBe(true)
  })

  test('extracts schema blocks with name', () => {
    const source = `{% schema %}
{
  "name": "Hero Banner",
  "settings": []
}
{% endschema %}`
    const extractor = new LiquidExtractor('/sections/hero.liquid', source)
    const result = extractor.extract()

    const schema = result.nodes.find(n => n.kind === 'constant')
    expect(schema).toBeDefined()
    expect(schema!.name).toBe('Hero Banner')
    expect(schema!.docstring).toBeDefined()
  })

  test('extracts schema with translation object name', () => {
    const source = `{% schema %}
{
  "name": { "en": "Hero", "fr": "Héros" },
  "settings": []
}
{% endschema %}`
    const extractor = new LiquidExtractor('/sections/hero.liquid', source)
    const result = extractor.extract()

    const schema = result.nodes.find(n => n.kind === 'constant')
    expect(schema).toBeDefined()
    expect(schema!.name).toBe('Hero')
  })

  test('extracts assign statements', () => {
    const source = `{% assign greeting = "Hello" %}
{% assign name = "World" %}
<p>{{ greeting }} {{ name }}</p>`
    const extractor = new LiquidExtractor('/templates/hello.liquid', source)
    const result = extractor.extract()

    const vars = result.nodes.filter(n => n.kind === 'variable')
    expect(vars.length).toBe(2)
    expect(vars.some(v => v.name === 'greeting')).toBe(true)
    expect(vars.some(v => v.name === 'name')).toBe(true)
  })

  test('creates containment edges', () => {
    const source = `{% render 'card' %}`
    const extractor = new LiquidExtractor('/templates/page.liquid', source)
    const result = extractor.extract()

    const fileNode = result.nodes.find(n => n.kind === 'file')
    expect(fileNode).toBeDefined()

    const containsEdges = result.edges.filter(e => e.source === fileNode!.id && e.kind === 'contains')
    expect(containsEdges.length).toBeGreaterThanOrEqual(1)
  })

  test('handles invalid JSON in schema gracefully', () => {
    const source = `{% schema %}
{ not valid json }
{% endschema %}`
    const extractor = new LiquidExtractor('/sections/broken.liquid', source)
    const result = extractor.extract()

    const schema = result.nodes.find(n => n.kind === 'constant')
    expect(schema).toBeDefined()
    expect(schema!.name).toBe('schema') // fallback name
  })

  test('handles empty source', () => {
    const extractor = new LiquidExtractor('/templates/empty.liquid', '')
    const result = extractor.extract()

    expect(result.nodes.length).toBe(1) // file node
    expect(result.errors.length).toBe(0)
  })

  test('records correct line numbers', () => {
    const source = `line1
line2
{% render 'card' %}`
    const extractor = new LiquidExtractor('/templates/page.liquid', source)
    const result = extractor.extract()

    const ref = result.unresolved_references.find(r => r.reference_name === 'snippets/card.liquid')
    expect(ref).toBeDefined()
    expect(ref!.line).toBe(3)
  })

  test('duration_ms is non-negative', () => {
    const result = new LiquidExtractor('/templates/page.liquid', 'hi').extract()
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
