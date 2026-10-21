import type { ChatPermissionMode, ChatPermissionPreset } from '../chat/types.js'

export const PERMISSION_CHOICES = {
  default: {
    label: 'Ask when needed (HITL)',
    description: 'Safe actions run automatically; sensitive actions ask first.',
  },
  bypassPermissions: {
    label: 'Allow all tools',
    description: 'Run every tool without asking first.',
  },
  ask: {
    label: 'Ask',
    description: 'Ask before any tool that requires approval.',
  },
  bypass: {
    label: 'Bypass',
    description: 'Run every tool without asking.',
  },
  custom: {
    label: 'Custom',
    description: 'Choose which tools can run without asking.',
  },
} as const

export function permissionModeDisplayLabel(mode: ChatPermissionMode, preset?: ChatPermissionPreset): string {
  return PERMISSION_CHOICES[preset ?? (mode === 'default' ? 'ask' : 'bypass')].label
}

export function permissionToolNames(tools: readonly string[], allowedTools: readonly string[]): string[] {
  return [...new Set([...tools, ...allowedTools])].sort((left, right) => left.localeCompare(right))
}

export function permissionToolDescription(allowed: boolean, toolDescription?: string): string {
  const behavior = allowed ? 'On: runs without asking' : 'Off: asks when approval is required'
  return toolDescription ? `${behavior} · ${toolDescription}` : behavior
}
