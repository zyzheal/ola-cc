/**
 * DfmExtractor tests — verify Delphi DFM/FMX form parsing.
 */

import { describe, test, expect } from 'bun:test'
import { DfmExtractor } from '../extractors/dfm-extractor.js'

describe('DfmExtractor', () => {
  const sampleDfm = `object MainForm: TMainForm
  Left = 0
  Top = 0
  Caption = 'My Application'
  object Panel1: TPanel
    Left = 0
    Top = 0
    object Button1: TButton
      Left = 10
      Top = 10
      OnClick = Button1Click
    end
    object Edit1: TEdit
      Left = 10
      Top = 40
      OnChange = Edit1Change
    end
  end
  object MainMenu1: TMainMenu
    object FileMenu: TMenuItem
      Caption = '&File'
      object OpenItem: TMenuItem
        Caption = '&Open'
        OnClick = OpenItemClick
      end
    end
  end
end`

  test('creates file node for DFM form', () => {
    const extractor = new DfmExtractor('/src/MainForm.dfm', sampleDfm)
    const result = extractor.extract()

    const fileNode = result.nodes.find(n => n.kind === 'file')
    expect(fileNode).toBeDefined()
    expect(fileNode!.name).toBe('MainForm.dfm')
    expect(fileNode!.language).toBe('pascal')
  })

  test('extracts top-level component', () => {
    const extractor = new DfmExtractor('/src/MainForm.dfm', sampleDfm)
    const result = extractor.extract()

    const mainForm = result.nodes.find(n => n.name === 'MainForm')
    expect(mainForm).toBeDefined()
    expect(mainForm!.kind).toBe('component')
    expect(mainForm!.signature).toBe('TMainForm')
  })

  test('extracts nested components', () => {
    const extractor = new DfmExtractor('/src/MainForm.dfm', sampleDfm)
    const result = extractor.extract()

    expect(result.nodes.find(n => n.name === 'Panel1')).toBeDefined()
    expect(result.nodes.find(n => n.name === 'Button1')).toBeDefined()
    expect(result.nodes.find(n => n.name === 'Edit1')).toBeDefined()
    expect(result.nodes.find(n => n.name === 'MainMenu1')).toBeDefined()
    expect(result.nodes.find(n => n.name === 'FileMenu')).toBeDefined()
    expect(result.nodes.find(n => n.name === 'OpenItem')).toBeDefined()
  })

  test('creates containment edges for nesting', () => {
    const extractor = new DfmExtractor('/src/MainForm.dfm', sampleDfm)
    const result = extractor.extract()

    const mainForm = result.nodes.find(n => n.name === 'MainForm')!
    const panel = result.nodes.find(n => n.name === 'Panel1')!
    const button = result.nodes.find(n => n.name === 'Button1')!

    expect(result.edges.some(e => e.source === mainForm.id && e.target === panel.id && e.kind === 'contains')).toBe(true)
    expect(result.edges.some(e => e.source === panel.id && e.target === button.id && e.kind === 'contains')).toBe(true)
  })

  test('extracts event handler references', () => {
    const extractor = new DfmExtractor('/src/MainForm.dfm', sampleDfm)
    const result = extractor.extract()

    const button = result.nodes.find(n => n.name === 'Button1')!
    const edit = result.nodes.find(n => n.name === 'Edit1')!
    const openItem = result.nodes.find(n => n.name === 'OpenItem')!

    expect(result.unresolved_references.some(
      r => r.from_node_id === button.id && r.reference_name === 'Button1Click',
    )).toBe(true)
    expect(result.unresolved_references.some(
      r => r.from_node_id === edit.id && r.reference_name === 'Edit1Change',
    )).toBe(true)
    expect(result.unresolved_references.some(
      r => r.from_node_id === openItem.id && r.reference_name === 'OpenItemClick',
    )).toBe(true)
  })

  test('handles inherited objects', () => {
    const source = `inherited MyForm: TMyForm
  Left = 0
end`
    const extractor = new DfmExtractor('/src/MyForm.dfm', source)
    const result = extractor.extract()

    const form = result.nodes.find(n => n.name === 'MyForm')
    expect(form).toBeDefined()
    expect(form!.signature).toBe('TMyForm')
  })

  test('handles inline objects', () => {
    const source = `object Container: TPanel
  inline Child: TButton
    Left = 0
  end
end`
    const extractor = new DfmExtractor('/src/test.dfm', source)
    const result = extractor.extract()

    expect(result.nodes.find(n => n.name === 'Container')).toBeDefined()
    expect(result.nodes.find(n => n.name === 'Child')).toBeDefined()
  })

  test('handles multi-line properties', () => {
    const source = `object Form1: TForm
  Items = (
    'one'
    'two'
    'three'
  )
  Config = <
    item
      Name = 'a'
    end>
  object Btn: TButton
    OnClick = BtnClick
  end
end`
    const extractor = new DfmExtractor('/src/test.dfm', source)
    const result = extractor.extract()

    // Should not crash on multi-line properties
    expect(result.nodes.find(n => n.name === 'Form1')).toBeDefined()
    expect(result.nodes.find(n => n.name === 'Btn')).toBeDefined()
    expect(result.unresolved_references.some(r => r.reference_name === 'BtnClick')).toBe(true)
  })

  test('handles empty source', () => {
    const extractor = new DfmExtractor('/src/empty.dfm', '')
    const result = extractor.extract()

    expect(result.nodes.length).toBe(1) // file node
    expect(result.errors.length).toBe(0)
  })

  test('duration_ms is non-negative', () => {
    const result = new DfmExtractor('/src/test.dfm', sampleDfm).extract()
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })
})
