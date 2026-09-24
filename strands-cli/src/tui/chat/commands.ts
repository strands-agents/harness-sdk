export interface LocalCommandSpec {
  name: string
  usage: string
  description: string
  replacement?: string
}

export const LOCAL_COMMANDS: readonly LocalCommandSpec[] = [
  { name: 'help', usage: '/help', description: 'Browse controls, commands, and the current agent’s tools' },
  { name: 'context', usage: '/context', description: 'Show context usage' },
  { name: 'compact', usage: '/compact', description: 'Summarize older conversation context' },
  { name: 'clear', usage: '/clear', description: 'Start a fresh conversation' },
  { name: 'tasks', usage: '/tasks', description: 'Show todos and available background tasks' },
  { name: 'model', usage: '/model [model-id]', description: 'Show or switch the active model' },
  { name: 'effort', usage: '/effort [level]', description: 'Show or change the reasoning effort' },
  { name: 'fork', usage: '/fork [request]', description: 'Fork this conversation into an independent agent' },
  { name: 'agents', usage: '/agents', description: 'View and switch between forked conversations' },
  { name: 'rename', usage: '/rename <name>', description: 'Rename the currently viewed agent' },
  {
    name: 'sessions',
    usage: '/sessions [rename <name>]',
    description: 'Browse, resume, or rename the current saved conversation',
  },
  { name: 'tools', usage: '/tools', description: 'Choose the built-in tools the agent has' },
  { name: 'skills', usage: '/skills', description: 'Browse available and active skills' },
  { name: 'mcp', usage: '/mcp', description: 'Show configured MCP servers and connection state' },
  { name: 'permissions', usage: '/permissions [default|bypass]', description: 'Configure tool approvals' },
  { name: 'voice', usage: '/voice [on|off|status]', description: 'Open bidirectional voice controls' },
  { name: 'settings', usage: '/settings', description: 'Configure the terminal experience' },
  { name: 'setup', usage: '/setup', description: 'Configure providers and the default agent' },
  {
    name: 'export',
    usage: '/export [typescript|python <path.zip>]',
    description: 'Export the agent as a TypeScript or Python project',
  },
  { name: 'exit', usage: '/exit', description: 'Exit the CLI' },
]

export const LOCAL_COMMAND_NAMES = new Set(LOCAL_COMMANDS.map((command) => command.name))

export interface CommandAssistance {
  readonly signature?: string
  readonly completions: readonly LocalCommandSpec[]
}

export function commandAssistance(input: string): CommandAssistance | undefined {
  const match = input.match(/^\/([^\s]*)(?:\s([\s\S]*))?$/)
  if (!match) {
    return undefined
  }
  const name = (match[1] ?? '').toLowerCase()
  const argument = match[2]
  if (argument === undefined) {
    const completions = LOCAL_COMMANDS.filter((command) => command.name.startsWith(name))
    return completions.length > 0 ? { completions } : undefined
  }

  const command = LOCAL_COMMANDS.find((candidate) => candidate.name === name)
  if (!command) {
    return undefined
  }
  const completions = argumentCompletions(name, argument)
  if (argument.length > 0 && completions.length === 0) {
    return undefined
  }
  return {
    signature: command.usage,
    completions,
  }
}

export function parseCommandInvocation(
  input: string
): { prefix: '/' | '$'; name: string; token: string; argument: string } | undefined {
  const match = input.match(/^([/$])([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match?.[1] || !match[2]) {
    return undefined
  }
  const prefix = match[1] as '/' | '$'
  return {
    prefix,
    name: match[2],
    token: `${prefix}${match[2]}`,
    argument: (match[3] ?? '').trim(),
  }
}

function argumentCompletions(command: string, argument: string): readonly LocalCommandSpec[] {
  switch (command) {
    case 'voice':
      return valueCompletions(command, argument, [
        ['on', 'Start the voice session'],
        ['off', 'Stop the voice session'],
        ['status', 'Show voice controls'],
      ])
    case 'permissions':
      return valueCompletions(command, argument, [
        ['default', 'Ask according to the configured policy'],
        ['bypass', 'Allow tool calls without prompting'],
      ])
    case 'sessions':
      return valueCompletions(command, argument, [['rename', 'Rename the current saved session']])
    default:
      return []
  }
}

function valueCompletions(
  command: string,
  argument: string,
  values: readonly (readonly [value: string, description: string])[]
): readonly LocalCommandSpec[] {
  const prefix = argument.trim().toLowerCase()
  return values
    .filter(([value]) => value.startsWith(prefix))
    .map(([value, description]) => ({
      name: value,
      usage: value,
      description,
      replacement: `/${command} ${value} `,
    }))
}
