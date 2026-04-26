import { describe, it, expect } from 'bun:test'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
  type PermissionRuleValue,
} from './permissionRuleParser.js'

// ─── permissionRuleValueFromString ──────────────────────────────────────────

describe('permissionRuleValueFromString', () => {
  describe('simple tool name', () => {
    it('parses bare tool name', () => {
      const result = permissionRuleValueFromString('Bash')
      expect(result.toolName).toBe('Bash')
      expect(result.ruleContent).toBeUndefined()
    })

    it('parses tool name with underscores', () => {
      const result = permissionRuleValueFromString('FileEdit')
      expect(result.toolName).toBe('FileEdit')
    })
  })

  describe('tool with content (e.g., Agent or path patterns)', () => {
    it('parses Agent(AgentType)', () => {
      const result = permissionRuleValueFromString('Agent(coder)')
      expect(result.toolName).toBe('Agent')
      expect(result.ruleContent).toBe('coder')
    })

    it('parses tool with empty content as bare tool name', () => {
      const result = permissionRuleValueFromString('Bash()')
      expect(result.toolName).toBe('Bash')
      expect(result.ruleContent).toBeUndefined()
    })

    it('parses MCP server-level rule mcp__server', () => {
      const result = permissionRuleValueFromString('mcp__myserver')
      expect(result.toolName).toBe('mcp__myserver')
      expect(result.ruleContent).toBeUndefined()
    })

    it('parses MCP tool-level rule mcp__server__tool', () => {
      const result = permissionRuleValueFromString('mcp__myserver__mytool')
      expect(result.toolName).toBe('mcp__myserver__mytool')
      expect(result.ruleContent).toBeUndefined()
    })
  })

  describe('escaped parentheses', () => {
    it('treats escaped paren as part of tool name', () => {
      const result = permissionRuleValueFromString('Tool\\(test\\)')
      // Should not parse as content since parens are escaped
      expect(result.toolName).toBe('Tool\\(test\\)')
    })
  })

  describe('malformed input', () => {
    it('handles unclosed parenthesis as bare tool name', () => {
      const result = permissionRuleValueFromString('Agent(coder')
      expect(result.toolName).toBe('Agent(coder')
    })

    it('handles closing paren before opening as bare tool name', () => {
      const result = permissionRuleValueFromString('Agent)coder(')
      expect(result.toolName).toBe('Agent)coder(')
    })

    it('handles content after closing paren as bare tool name', () => {
      const result = permissionRuleValueFromString('Agent(coder)extra')
      expect(result.toolName).toBe('Agent(coder)extra')
    })
  })
})

// ─── permissionRuleValueToString ────────────────────────────────────────────

describe('permissionRuleValueToString', () => {
  it('converts bare tool name', () => {
    const value: PermissionRuleValue = { toolName: 'Bash' }
    expect(permissionRuleValueToString(value)).toBe('Bash')
  })

  it('converts tool with content', () => {
    const value: PermissionRuleValue = { toolName: 'Agent', ruleContent: 'coder' }
    expect(permissionRuleValueToString(value)).toBe('Agent(coder)')
  })

  it('converts tool with empty content as bare tool name', () => {
    const value: PermissionRuleValue = { toolName: 'Bash', ruleContent: '' }
    // Empty ruleContent is falsy, so permissionRuleValueToString returns bare tool name
    expect(permissionRuleValueToString(value)).toBe('Bash')
  })
})

// ─── Round-trip consistency ─────────────────────────────────────────────────

describe('round-trip', () => {
  it('string → parse → stringify → matches original', () => {
    const inputs = ['Bash', 'Agent(coder)', 'mcp__server', 'FileEdit']
    for (const input of inputs) {
      const parsed = permissionRuleValueFromString(input)
      const stringified = permissionRuleValueToString(parsed)
      expect(stringified).toBe(input)
    }
  })
})
