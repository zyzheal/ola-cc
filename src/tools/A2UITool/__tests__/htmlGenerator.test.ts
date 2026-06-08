import { describe, test, expect, beforeEach } from 'bun:test'
import { HTMLGenerator } from '../htmlGenerator.js'
import type { A2UIMessage, CatalogConfig } from '../types.js'

describe('HTMLGenerator', () => {
  let generator: HTMLGenerator
  let defaultCatalog: CatalogConfig

  beforeEach(() => {
    generator = new HTMLGenerator()
    defaultCatalog = {
      id: 'default',
      components: [
        { type: 'Button', props: { label: { type: 'string', required: true } }, actions: ['onClick'] },
        { type: 'Text', props: { text: { type: 'string', required: true } } },
      ],
    }
  })

  test('should generate valid HTML', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            { id: 'btn-1', component: { type: 'Button', props: { label: 'Click' } } },
          ],
        },
      },
    ]

    const html = generator.generate({
      messages,
      surfaceId: 'test-surface',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'test-token-123',
    })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('</html>')
  })

  test('should include nonce in CSP and script tags', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    // Should have nonce in CSP
    expect(html).toMatch(/script-src.*'nonce-[^']+'/)
    // Should have nonce on style tag
    expect(html).toMatch(/<style nonce="[^"]+">/)
  })

  test('should inject action port correctly', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 30000,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('data-port="30000"')
    expect(html).toContain('http://localhost:30000')
  })

  test('should inject surface ID', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'my-surface-123',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('data-surface-id="my-surface-123"')
  })

  test('should escape HTML in surface ID', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: '<script>alert("xss")</script>',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    // Should be escaped
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
  })

  test('should escape HTML in title', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
      title: '<img onerror="alert(1)">',
    })

    expect(html).not.toContain('<img onerror')
    expect(html).toContain('&lt;img')
  })

  test('should use dark theme by default', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('class="dark"')
  })

  test('should use light theme when specified', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
      theme: 'light',
    })

    expect(html).toContain('class="light"')
  })

  test('should inject A2UI messages as JSON', () => {
    const messages: A2UIMessage[] = [
      {
        surfaceUpdate: {
          components: [
            { id: 'btn-1', component: { type: 'Button', props: { label: 'Test' } } },
          ],
        },
      },
    ]

    const html = generator.generate({
      messages,
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    // Should be in a script[type="application/json"] tag
    expect(html).toContain('<script id="a2ui-data" type="application/json">')
    expect(html).toContain('"type":"Button"')
  })

  test('should inject action token', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'my-secret-token',
    })

    expect(html).toContain('data-token="my-secret-token"')
  })

  test('should include component catalog in config', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('data-catalog=')
    expect(html).toContain('"type":"Button"')
  })

  test('should generate default title when not specified', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'surf-abc',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    expect(html).toContain('<title>A2UI - surf-abc</title>')
  })

  test('should use custom title when specified', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
      title: 'My Dashboard',
    })

    expect(html).toContain('<title>My Dashboard</title>')
  })

  test('should include SRI integrity attributes on CDN scripts', () => {
    const html = generator.generate({
      messages: [],
      surfaceId: 'test',
      actionPort: 28900,
      catalog: defaultCatalog,
      actionToken: 'token',
    })

    // React CDN script should have integrity attribute
    expect(html).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/)
    // Both scripts should have crossorigin attribute
    const crossoriginCount = (html.match(/crossorigin/g) || []).length
    expect(crossoriginCount).toBeGreaterThanOrEqual(2)
  })
})
