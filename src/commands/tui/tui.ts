import type { LocalCommandCall } from '../../types/command.js'
import {
  isFullscreenEnvEnabled,
  setFullscreenOverride,
  getFullscreenOverride,
  isTmuxControlMode,
  notifyFullscreenChange,
} from '../../utils/fullscreen.js'

export const call: LocalCommandCall = async (args) => {
  const arg = args?.trim().toLowerCase()

  // /tui — toggle current state
  // /tui on — force enable
  // /tui off — force disable
  // /tui status — show current state
  // /tui fullscreen — alias for /tui on

  if (arg === 'status') {
    const current = isFullscreenEnvEnabled()
    const override = getFullscreenOverride()
    return {
      type: 'text',
      value: [
        `Fullscreen: ${current ? 'ON' : 'OFF'}`,
        override !== undefined ? `Override: ${override ? 'ON' : 'OFF'}` : 'Override: none (using default)',
      ].join('\n'),
    }
  }

  if (arg === 'on' || arg === 'fullscreen' || arg === 'enable') {
    // Safety check: warn if tmux -CC is detected
    const tmuxWarning = isTmuxControlMode()
      ? '\n⚠️ WARNING: tmux -CC (iTerm2 integration mode) detected. Fullscreen mode may cause terminal state corruption (mouse wheel dead, double-click breaks alt-screen). Use /tui off to disable if issues occur.'
      : ''
    setFullscreenOverride(true)
    notifyFullscreenChange()
    return {
      type: 'text',
      value: `Fullscreen mode enabled. Use /tui off to disable.${tmuxWarning}`,
    }
  }

  if (arg === 'off' || arg === 'disable') {
    setFullscreenOverride(false)
    notifyFullscreenChange()
    return {
      type: 'text',
      value: 'Fullscreen mode disabled. Use /tui on to re-enable.',
    }
  }

  if (arg === 'reset') {
    setFullscreenOverride(undefined)
    notifyFullscreenChange()
    const current = isFullscreenEnvEnabled()
    return {
      type: 'text',
      value: `Fullscreen override cleared. Current state: ${current ? 'ON' : 'OFF'} (default behavior)`,
    }
  }

  // Toggle
  const current = isFullscreenEnvEnabled()
  setFullscreenOverride(!current)
  notifyFullscreenChange()
  return {
    type: 'text',
    value: `Fullscreen mode ${!current ? 'enabled' : 'disabled'}. Use /tui ${!current ? 'off' : 'on'} to ${!current ? 'disable' : 'enable'}.`,
  }
}
