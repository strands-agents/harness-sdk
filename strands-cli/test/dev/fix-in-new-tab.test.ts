import { execFile, spawnSync } from 'node:child_process'
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fixInNewTab,
  fixPrompt,
  shellCommand,
  terminalTab,
  writeFixLauncher,
  type FixRequest,
} from '../../src/dev/fix-in-new-tab.js'
import * as terminal from '../../src/terminal/terminal.js'
import { temporaryDirectory, trackTemporaryDirectory } from '../fixtures/tempdir.js'

const run = promisify(execFile)
const output = { write: () => true }

afterEach(() => vi.restoreAllMocks())

const request = (overrides: Partial<FixRequest> = {}): FixRequest => ({
  report: "Project entrypoint failed\nNo module named 'refund_desk'",
  directory: '/projects/refund-desk',
  retry: 'setup',
  ...overrides,
})

const launcherIn = (command: string): string => {
  const launcher = /'([^']*fix\.mjs)'/u.exec(command)?.[1]
  if (!launcher) throw new Error(`No launcher in ${command}`)
  trackTemporaryDirectory(dirname(launcher))
  return launcher
}

const fakeTmux = async (script: string): Promise<{ bin: string; record: string }> => {
  const bin = await temporaryDirectory()
  const record = join(bin, 'arguments.json')
  await writeFile(join(bin, 'tmux'), `#!/bin/sh\n${script.replace('RECORD', record)}\n`)
  await chmod(join(bin, 'tmux'), 0o755)
  return { bin, record }
}

describe('fix prompt', () => {
  it.each([
    ['setup', 'Then I will press r in the strands dev tab. It runs setup again and checks the agent.'],
    ['reload', 'strands dev reloads the agent when its files change.'],
    ['restart', 'Then I will restart strands dev to load the agent again.'],
  ] as const)('shouldAskForAFixWithTheErrorAndStrandsDevContextWhenTheRetryIs%s', (retry, nextStep) => {
    const prompt = fixPrompt(request({ retry }))

    expect(prompt).toContain('Project folder: /projects/refund-desk')
    expect(prompt).toContain("Project entrypoint failed\nNo module named 'refund_desk'")
    expect(prompt).toContain('The project folder and the entrypoint folder are on sys.path.')
    expect(prompt).toContain('Do not start strands dev.')
    expect(prompt).toContain('both with --ignore-scripts')
    expect(prompt).toContain('does not set up projects that use pnpm, yarn, bun, poetry, or Pipfile')
    expect(prompt.endsWith(nextStep)).toBe(true)
  })

  it('shouldRemoveTerminalControlSequencesFromTheReport', () => {
    expect(fixPrompt(request({ report: '\u001b[31mBuild failed\u001b[0m' }))).toContain('\nBuild failed\n')
  })
})

describe('shell command', () => {
  it.each([
    ['linux', ['/usr/bin/node', "/tmp/it's/fix.mjs"], `'/usr/bin/node' '/tmp/it'\\''s/fix.mjs'`],
    ['darwin', ['/opt/node', '/tmp/fix.mjs'], `'/opt/node' '/tmp/fix.mjs'`],
    ['win32', ['C:\\node.exe', "C:\\it's\\fix.mjs"], `& 'C:\\node.exe' 'C:\\it''s\\fix.mjs'`],
  ] as const)('shouldQuoteEveryWordWhenThePlatformIs%s', (platform, words, expected) => {
    expect(shellCommand(words, platform)).toBe(expected)
  })
})

describe('terminal tab', () => {
  it.each([
    ['iTerm.app', 'iTerm2 tab', 'com.googlecode.iterm2'],
    ['ghostty', 'Ghostty tab', 'com.mitchellh.ghostty'],
    ['Apple_Terminal', 'Terminal window', 'com.apple.Terminal'],
  ])('shouldScriptTheTerminalWhenMacOSRuns%s', (program, place, application) => {
    const tab = terminalTab("'node' 'fix.mjs'", { TERM_PROGRAM: program }, 'darwin')

    expect(tab).toMatchObject({ place, command: '/usr/bin/osascript' })
    expect(tab?.args.slice(-2)).toEqual(['--', "'node' 'fix.mjs'"])
    expect(tab?.args[1]).toContain(`application id "${application}"`)
  })

  it('shouldOpenATmuxWindowWhenTheCLIRunsInsideTmux', () => {
    expect(
      terminalTab("'node' 'fix.mjs'", { TMUX: '/tmp/tmux-1/default', TERM_PROGRAM: 'iTerm.app' }, 'darwin')
    ).toEqual({ place: 'tmux window', command: 'tmux', args: ['new-window', '-n', 'strands fix', "'node' 'fix.mjs'"] })
  })

  it.each([
    ['linux', { TERM_PROGRAM: 'iTerm.app' }],
    ['darwin', { TERM_PROGRAM: 'vscode' }],
    ['darwin', {}],
    ['win32', { WT_SESSION: '1' }],
  ] as const)('shouldFindNoTabWhenThePlatformIs%sAndTheTerminalIsUnknown', (platform, environment) => {
    expect(terminalTab("'node' 'fix.mjs'", environment, platform)).toBeUndefined()
  })
})

describe('fix launcher', () => {
  it('shouldStartTheBuiltInAgentInTheProjectFolderWithThePromptAsOneArgument', async () => {
    const directory = await temporaryDirectory()
    const record = join(directory, 'record.json')
    const cli = join(directory, 'cli.mjs')
    await writeFile(
      cli,
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))\n`
    )
    const fix = request({ directory, report: 'Line one\nLine "two" with $HOME and `ticks`' })
    const launcher = await writeFixLauncher(fix, cli)
    trackTemporaryDirectory(dirname(launcher))

    await run(process.execPath, [launcher])

    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({
      argv: ['--agent', '', fixPrompt(fix)],
      cwd: await realpath(directory),
    })
  })

  it('shouldShowTheExitAndWaitForEnterWhenTheCLIFails', async () => {
    const directory = await temporaryDirectory()
    const cli = join(directory, 'cli.mjs')
    await writeFile(cli, 'process.exit(3)\n')
    const launcher = await writeFixLauncher(request({ directory }), cli)
    trackTemporaryDirectory(dirname(launcher))

    const result = spawnSync(process.execPath, [launcher], { input: '\n', encoding: 'utf8' })

    expect(result.status).toBe(3)
    expect(result.stderr).toContain('Strands stopped: exit 3. Press Enter to close.')
  })
})

describe('fix in new tab', () => {
  it('shouldCopyACommandWhenNoSupportedTerminalIsFound', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)

    const outcome = await fixInNewTab(request(), output, {}, 'linux')

    const command = copy.mock.calls[0]![0]
    launcherIn(command)
    expect(command.startsWith(`'${process.execPath}' '`)).toBe(true)
    expect(outcome).toEqual({
      status: 'delivered',
      text: `Run this in a new terminal tab to open Strands (copied): ${command}`,
    })
  })

  it.skipIf(process.platform === 'win32')('shouldOpenATmuxWindowThatRunsTheLauncher', async () => {
    const { bin, record } = await fakeTmux(`printf '%s\\n' "$@" > RECORD`)

    const outcome = await fixInNewTab(request(), output, { TMUX: '1', PATH: bin }, 'linux')

    const [, , , command] = (await readFile(record, 'utf8')).trim().split('\n')
    launcherIn(command!)
    expect((await readFile(record, 'utf8')).trim().split('\n').slice(0, 3)).toEqual(['new-window', '-n', 'strands fix'])
    expect(outcome).toEqual({
      status: 'success',
      text: 'Opened Strands in a new tmux window. Press r here when it is done.',
    })
  })

  it.skipIf(process.platform === 'win32')('shouldExplainTheFailureAndCopyTheCommandWhenTheTabDoesNotOpen', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(false)
    const { bin } = await fakeTmux(`echo 'no server running' >&2\nexit 1`)

    const outcome = await fixInNewTab(request({ retry: 'reload' }), output, { TMUX: '1', PATH: bin }, 'linux')

    const command = copy.mock.calls[0]![0]
    launcherIn(command)
    expect(outcome).toEqual({
      status: 'delivered',
      text: `Could not open a new tmux window (no server running). Run this in a new terminal tab to open Strands: ${command}`,
    })
  })
})
