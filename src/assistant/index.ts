function readAssistantModeFlag(): boolean {
  return (
    process.env.OLA_CC_ASSISTANT_MODE === '1' ||
    process.env.OLA_CC_ASSISTANT_MODE === 'true'
  )
}

export function isAssistantMode(): boolean {
  return readAssistantModeFlag()
}

export function isAssistantModeEnabled(): boolean {
  return readAssistantModeFlag()
}
