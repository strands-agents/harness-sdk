export const PERMISSION_CHOICES = {
  default: {
    label: 'Default (HITL)',
    description: 'Ask before protected tool calls.',
  },
  bypassPermissions: {
    label: 'Bypass',
    description: 'Run tools without approval prompts.',
  },
  custom: {
    label: 'Custom',
    description: 'Configure each tool.',
  },
} as const

export function permissionToolNames(tools: readonly string[], allowedTools: readonly string[]): string[] {
  return [...new Set([...tools, ...allowedTools])].sort((left, right) => left.localeCompare(right))
}

export function permissionToolDescription(allowed: boolean): string {
  return allowed ? 'Always allow · skips the approval prompt' : 'Default policy · asks only when approval is required'
}
