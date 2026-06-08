import { describe, test, expect } from 'bun:test'
import { Catalog } from '../catalog.js'

describe('Catalog', () => {
  test('should initialize with default catalog', () => {
    const catalog = new Catalog()
    const defaultConfig = catalog.get('default')

    expect(defaultConfig.id).toBe('default')
    expect(defaultConfig.components.length).toBeGreaterThan(0)
  })

  test('should have all required default components', () => {
    const catalog = new Catalog()
    const requiredTypes = ['Column', 'Row', 'Text', 'Card', 'Button', 'TextField', 'Select']

    for (const type of requiredTypes) {
      expect(catalog.hasComponent(type)).toBe(true)
    }
  })

  test('should return default catalog for unknown id', () => {
    const catalog = new Catalog()
    const unknown = catalog.get('nonexistent')

    expect(unknown.id).toBe('default')
  })

  test('should register custom catalog', () => {
    const catalog = new Catalog()
    catalog.register({
      id: 'custom',
      components: [
        {
          type: 'CustomWidget',
          props: { value: { type: 'string', required: true } },
        },
      ],
    })

    expect(catalog.get('custom').id).toBe('custom')
    expect(catalog.hasComponent('CustomWidget')).toBe(false) // hasComponent checks default
  })

  test('should get component definition', () => {
    const catalog = new Catalog()
    const buttonDef = catalog.getComponentDef('Button')

    expect(buttonDef).toBeDefined()
    expect(buttonDef?.type).toBe('Button')
    expect(buttonDef?.actions).toContain('onClick')
  })

  test('should return undefined for unknown component', () => {
    const catalog = new Catalog()
    const unknown = catalog.getComponentDef('UnknownComponent')

    expect(unknown).toBeUndefined()
  })

  test('should list all component types', () => {
    const catalog = new Catalog()
    const types = catalog.componentTypes

    expect(types).toContain('Button')
    expect(types).toContain('TextField')
    expect(types.length).toBe(7)
  })

  test('Button component should have correct props', () => {
    const catalog = new Catalog()
    const button = catalog.getComponentDef('Button')

    expect(button?.props.label).toEqual({ type: 'string', required: true })
    expect(button?.props.variant).toEqual({ type: 'string', default: 'primary' })
  })

  test('TextField component should have onChange action', () => {
    const catalog = new Catalog()
    const textField = catalog.getComponentDef('TextField')

    expect(textField?.actions).toContain('onChange')
  })
})
