import * as React from 'react'
import { BgSessionView } from '../../components/agents/BgSessionView.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <BgSessionView onExit={onDone} />
}
