import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyTerminalText, type TerminalOutput } from '../terminal/terminal.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/text.js'

export type FixRetry = 'setup' | 'reload' | 'restart'

export interface FixRequest {
  report: string
  directory: string
  retry: FixRetry
}

export interface FixOutcome {
  status: 'success' | 'delivered' | 'error'
  text: string
}

export interface TerminalTab {
  place: string
  command: string
  args: readonly string[]
}

type MacTerminal = 'iTerm.app' | 'ghostty' | 'Apple_Terminal'

const TAB_TIMEOUT_MS = 15_000

const MAC_TERMINALS: Readonly<Record<MacTerminal, { place: string; script: string }>> = {
  'iTerm.app': {
    place: 'iTerm2 tab',
    script: `
on run argv
  tell application id "com.googlecode.iterm2"
    tell current window
      set fixTab to (create tab with default profile)
      tell current session of fixTab to write text (item 1 of argv)
    end tell
  end tell
end run
`,
  },
  ghostty: {
    place: 'Ghostty tab',
    script: `
on run argv
  tell application id "com.mitchellh.ghostty"
    set fixSurface to new surface configuration
    set initial input of fixSurface to (item 1 of argv) & linefeed
    new tab with configuration fixSurface
  end tell
end run
`,
  },
  Apple_Terminal: {
    place: 'Terminal window',
    script: `
on run argv
  tell application id "com.apple.Terminal" to do script (item 1 of argv)
end run
`,
  },
}

const NEXT_STEP: Readonly<Record<FixRetry, { prompt: string; status: string }>> = {
  setup: {
    prompt: 'Then I will press r in the strands dev tab. It runs setup again and checks the agent.',
    status: 'Press r here when it is done.',
  },
  reload: {
    prompt: 'strands dev reloads the agent when its files change.',
    status: 'strands dev reloads the agent when its files change.',
  },
  restart: {
    prompt: 'Then I will restart strands dev to load the agent again.',
    status: 'Restart strands dev when it is done.',
  },
}

const STRANDS_DEV_CONTEXT = [
  'How strands dev runs an agent:',
  '- It prepares the project, then loads the entrypoint in the project runtime. Chat uses the same runtime.',
  '- A Python project runs in its .venv. strands dev installs requirements.txt, installs an installable pyproject.toml in editable mode, or runs uv sync --locked --inexact when uv.lock exists.',
  '- A Python entrypoint must define a Strands Agent named agent, for example agent = create_harness(...). The project folder and the entrypoint folder are on sys.path.',
  '- A TypeScript project uses npm ci when it has a lockfile, and npm install when it does not, both with --ignore-scripts. Then strands dev runs the build script, if the project has one.',
  '- A TypeScript entrypoint must contain export const agent = createHarness(...).',
  '- strands dev does not set up projects that use pnpm, yarn, bun, poetry, or Pipfile, or that are part of a Node workspace. Set those up with their own tools.',
  '- strands dev does not guess a package name for a missing import. A missing import usually comes from a missing dependency, the wrong project folder, or a local package that is not installed.',
  '- Setup logs are in .strands/state/setup/ in the project folder.',
]

let opening = false

const isMacTerminal = (program: string | undefined): program is MacTerminal =>
  program !== undefined && Object.hasOwn(MAC_TERMINALS, program)

export const fixPrompt = ({ report, directory, retry }: FixRequest): string =>
  [
    'strands dev cannot run the agent in this project. Find the cause and fix the project so that strands dev can load and run the agent.',
    '',
    `Project folder: ${directory}`,
    '',
    ...STRANDS_DEV_CONTEXT,
    '',
    'The error from strands dev:',
    sanitizeTerminalText(report),
    '',
    'What to do:',
    '1. Read the error and any setup log, and find the cause.',
    '2. Fix the cause in the project. Do not change what the agent does.',
    '3. Check that the entrypoint loads in the project runtime.',
    '4. Do not start strands dev. It is already open in another tab.',
    `5. Tell me what you changed. ${NEXT_STEP[retry].prompt}`,
  ].join('\n')

export const shellCommand = (words: readonly string[], platform: NodeJS.Platform = process.platform): string =>
  platform === 'win32'
    ? `& ${words.map((word) => `'${word.replaceAll("'", "''")}'`).join(' ')}`
    : words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ')

export const terminalTab = (
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): TerminalTab | undefined => {
  if (environment.TMUX) {
    return { place: 'tmux window', command: 'tmux', args: ['new-window', '-n', 'strands fix', command] }
  }
  const program = environment.TERM_PROGRAM
  if (platform !== 'darwin' || !isMacTerminal(program)) return undefined
  const { place, script } = MAC_TERMINALS[program]
  return { place, command: '/usr/bin/osascript', args: ['-e', script, '--', command] }
}

const LAUNCHER_RUN = `const { status, signal, error } = spawnSync(launch.node, [launch.cli, '--agent', '', launch.prompt], {
  cwd: launch.directory,
  stdio: 'inherit',
})
if (error || (status !== 0 && status !== 130)) {
  process.stderr.write('\\nStrands stopped: ' + (error ? error.message : 'exit ' + (status ?? signal)) + '. Press Enter to close.\\n')
  readSync(0, Buffer.alloc(1))
}
process.exitCode = status ?? 1
`

const launcherSource = (node: string, cli: string, request: FixRequest): string =>
  [
    "import { spawnSync } from 'node:child_process'",
    "import { readSync } from 'node:fs'",
    `const launch = ${JSON.stringify({ node, cli, directory: request.directory, prompt: fixPrompt(request) })}`,
    LAUNCHER_RUN,
  ].join('\n')

export const writeFixLauncher = async (
  request: FixRequest,
  cli: string | undefined = process.argv[1],
  node: string = process.execPath
): Promise<string> => {
  if (!cli) throw new Error('Cannot find the Strands CLI that is running.')
  const launcher = join(await mkdtemp(join(tmpdir(), 'strands-fix-')), 'fix.mjs')
  await writeFile(launcher, launcherSource(node, cli, request), { mode: 0o600 })
  return launcher
}

const openTab = ({ command, args }: TerminalTab, environment: NodeJS.ProcessEnv): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(command, args, { env: environment, timeout: TAB_TIMEOUT_MS, windowsHide: true }, (error, _, stderr) =>
      resolve(error ? stderr.trim().split('\n').at(-1) || error.message : undefined)
    )
  })

const launch = async (
  request: FixRequest,
  output: TerminalOutput,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<FixOutcome> => {
  const command = shellCommand([process.execPath, await writeFixLauncher(request)], platform)
  const tab = terminalTab(command, environment, platform)
  const failure = tab ? await openTab(tab, environment) : undefined
  if (tab && !failure) {
    return { status: 'success', text: `Opened Strands in a new ${tab.place}. ${NEXT_STEP[request.retry].status}` }
  }
  const reason = tab ? `Could not open a new ${tab.place} (${failure}). ` : ''
  const copied = await copyTerminalText(command, output)
  return {
    status: 'delivered',
    text: `${reason}Run this in a new terminal tab to open Strands${copied ? ' (copied)' : ''}: ${command}`,
  }
}

export const fixInNewTab = async (
  request: FixRequest,
  output: TerminalOutput,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<FixOutcome> => {
  if (opening) return { status: 'delivered', text: 'Strands is already opening in a new tab.' }
  opening = true
  try {
    return await launch(request, output, environment, platform)
  } catch (error) {
    return { status: 'error', text: `Could not open Strands: ${errorMessage(error)}` }
  } finally {
    opening = false
  }
}
