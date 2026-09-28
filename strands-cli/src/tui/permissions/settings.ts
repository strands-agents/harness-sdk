export const PERMISSION_CHOICES = {
  default: {
    label: 'Ask when needed (HITL)',
    description: 'Safe actions run automatically; sensitive actions ask first.',
  },
  bypassPermissions: {
    label: 'Allow all tools',
    description: 'Run every tool without asking first.',
  },
  custom: {
    label: 'Choose by tool',
    description: 'Choose which tools can run without asking.',
  },
} as const

export function permissionToolNames(tools: readonly string[], allowedTools: readonly string[]): string[] {
  return [...new Set([...tools, ...allowedTools])].sort((left, right) => left.localeCompare(right))
}

export function permissionToolDescription(allowed: boolean, toolDescription?: string): string {
  const behavior = allowed ? 'On: runs without asking' : 'Off: asks when approval is required'
  return toolDescription ? `${behavior} · ${toolDescription}` : behavior
}
