import React from 'react'
import { Text } from '../../ink.js'
import type { Input } from './ProcessDiagnosticTool.js'

export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  if (!input.target_type || !input.target_value) return null
  return (
    <Text dimColor>
      Diagnosing {input.target_type}: {input.target_value}
    </Text>
  )
}
