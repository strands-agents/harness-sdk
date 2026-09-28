import { LOCAL_COMMANDS } from './commands.js'
import type { ChatBackend, ChatPanelRow } from './types.js'

const CONTROLS = [
  ['Send a message', 'Enter', 'Send your message, or queue it while the harness is working.'],
  ['Add a line', 'Ctrl+J', 'Ctrl+J inserts a newline without sending.'],
  [
    'Steer running work',
    'Ctrl+G',
    'Ctrl+G sends your draft immediately; with an empty draft it steers the first queued message.',
  ],
  [
    'Interrupt or exit',
    'Esc / Ctrl+C',
    'Esc interrupts running work when no panel is open. Ctrl+C or Ctrl+D cancels busy work, or exits when idle.',
  ],
  [
    'Browse commands',
    '/',
    'Type / to browse commands. ↑/↓ selects, Tab completes, Enter runs a command or completes an argument, and Esc hides suggestions.',
  ],
  [
    'Browse panels',
    '↑↓ / Enter',
    '↑/↓ selects a row; Enter or a click opens it. Type to search searchable panels. Esc clears a search, then goes back or closes.',
  ],
  [
    'Read details',
    '↑↓ / PgUp / PgDn',
    '↑/↓ or the mouse wheel scrolls; Page Up/Down scrolls a page, Home/End jumps to the ends. Esc, Enter, or Backspace goes back.',
  ],
  ['Copy text', 'Drag', 'Drag across visible text and release to copy the selection.'],
  [
    'Scroll conversation',
    'Wheel / PgUp / PgDn',
    'Use the mouse wheel or Page Up/Down. Ctrl+↑/↓ scrolls, and Ctrl+Home/End jumps to the ends.',
  ],
] as const

export function helpRows(
  backend: ChatBackend,
  options: { sessions: boolean; skills: boolean; mcp: boolean; setup: boolean; tools: boolean; export: boolean }
): ChatPanelRow[] {
  const support: Record<string, boolean> = {
    compact: backend.compact !== undefined,
    clear: backend.clear !== undefined,
    sessions: options.sessions,
    skills: options.skills,
    mcp: options.mcp,
    permissions: backend.permissionStatus !== undefined,
    setup: options.setup,
    tools: options.tools,
    export: options.export,
  }
  const managedCommands = new Set(['fork', 'agents', 'rename', 'voice'])
  const tools = backend.info?.().tools
  return [
    ...CONTROLS.map(([label, shortcut, description], index) => ({
      label,
      description: `${shortcut}\n${description}`,
      section: 'Controls',
      filter: 'controls',
      value: `help:detail:control:${index}`,
    })),
    ...LOCAL_COMMANDS.map((command) => {
      const available = support[command.name] !== false
      const managed = managedCommands.has(command.name)
      return {
        label: command.usage,
        description: [
          command.description,
          ...(available ? [] : ['Unavailable on this connection.']),
          ...(managed ? ['Use this command in the conversation interface.'] : []),
        ].join('\n'),
        section: 'Commands',
        filter: 'commands',
        value: available && !managed ? `help:command:${command.name}` : `help:detail:command:${command.name}`,
      }
    }),
    ...(tools === undefined || tools.length === 0
      ? [
          {
            label: tools === undefined ? 'Tool list not reported' : 'No registered tools',
            description:
              tools === undefined
                ? 'This connection does not report its available tools. Tools may still be available to the agent.'
                : 'The current agent reports an empty tool list.',
            section: 'Available tools',
            filter: 'tools',
            value: 'help:detail:tools',
          },
        ]
      : tools.map((tool, index) => ({
          label: tool.name,
          description: `${tool.description || 'No description reported.'}\nSource: ${tool.source ?? `${backend.name} (${backend.id}); tool origin not reported`}`,
          section: 'Available tools',
          filter: 'tools',
          value: `help:detail:tool:${index}`,
        }))),
  ]
}
