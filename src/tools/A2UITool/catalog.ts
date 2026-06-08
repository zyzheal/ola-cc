/**
 * Catalog — Component whitelist management
 *
 * Maintains registered catalogs and validates component types against them.
 */

import type { CatalogComponentDef, CatalogConfig } from './types.js'

const DEFAULT_COMPONENTS: CatalogComponentDef[] = [
  {
    type: 'Column',
    props: {
      children: { type: 'array', required: true },
      gap: { type: 'number', default: 8 },
    },
  },
  {
    type: 'Row',
    props: {
      children: { type: 'array', required: true },
      gap: { type: 'number', default: 8 },
    },
  },
  {
    type: 'Text',
    props: {
      text: { type: 'string', required: true },
      style: { type: 'object' },
      usageHint: { type: 'string' },
    },
  },
  {
    type: 'Card',
    props: {
      child: { type: 'string', required: true },
      title: { type: 'string' },
    },
  },
  {
    type: 'Button',
    props: {
      label: { type: 'string', required: true },
      variant: { type: 'string', default: 'primary' },
    },
    actions: ['onClick'],
  },
  {
    type: 'TextField',
    props: {
      label: { type: 'string' },
      placeholder: { type: 'string' },
      value: { type: 'string', default: '' },
    },
    actions: ['onChange'],
  },
  {
    type: 'Select',
    props: {
      label: { type: 'string' },
      options: { type: 'array', required: true },
      value: { type: 'string' },
    },
    actions: ['onChange'],
  },
]

export class Catalog {
  private catalogs: Map<string, CatalogConfig> = new Map()

  constructor() {
    this.register({
      id: 'default',
      components: DEFAULT_COMPONENTS,
    })
  }

  register(config: CatalogConfig): void {
    this.catalogs.set(config.id, config)
  }

  get(id: string): CatalogConfig {
    return this.catalogs.get(id) || this.catalogs.get('default')!
  }

  hasComponent(type: string): boolean {
    return this.get('default').components.some((c) => c.type === type)
  }

  getComponentDef(type: string): CatalogComponentDef | undefined {
    return this.get('default').components.find((c) => c.type === type)
  }

  get componentTypes(): string[] {
    return this.get('default').components.map((c) => c.type)
  }
}
