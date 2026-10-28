import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { URL, fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { sanitizeTerminalText } from '../src/tui/terminal/sanitize.js'

// Colored output paints solid cells as backgrounds, leaving only the half-block glyphs as text.
const STRANDS_WORDMARK = /STRANDS|╔════╝|█▀▀ ▀█▀ █▀█ ▄▀█ █▄ █ █▀▄ █▀▀|▀▀ ▀ ▀ {2}▀ {2}▄▀ {3}▄ {4}▀▄ {2}▀▀/

vi.setConfig({ testTimeout: 20_000 })

const execFileAsync = promisify(execFile)

interface PtyResult {
  returnCode: number
  termiosRestored: boolean
  transcript: string
  resizeTranscript: string
  resizeBurstTranscript: string
  resizeNoopTranscript: string
}

async function runPtySmoke(
  intro = false,
  shellMode?: 'command' | 'interrupt',
  startupTyping = false,
  frog = false,
  resize = false,
  exitMode?: 'exit' | 'exception' | 'rejection'
): Promise<PtyResult & { output: string }> {
  const driver = fileURLToPath(new URL('./fixtures/tui-pty-driver.py', import.meta.url))
  const loader = fileURLToPath(new URL('./fixtures/strands-cli-routing-source-loader.mjs', import.meta.url))
  const fixture = fileURLToPath(new URL('./fixtures/tui-lifecycle-process.mjs', import.meta.url))
  const { stdout } = await execFileAsync(
    process.env.PYTHON ?? 'python3',
    [driver, process.execPath, '--no-warnings=ExperimentalWarning', '--experimental-loader', loader, fixture],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        STRANDS_CLI_TEST_INTRO: intro ? 'true' : 'false',
        ...(shellMode ? { STRANDS_CLI_TEST_SHELL_MODE: shellMode } : {}),
        ...(startupTyping ? { STRANDS_CLI_TEST_STARTUP_TYPING: 'true' } : {}),
        ...(frog ? { STRANDS_CLI_TEST_FROG_MODE: 'true' } : {}),
        ...(resize ? { STRANDS_CLI_TEST_RESIZE: 'true' } : {}),
        ...(exitMode ? { STRANDS_CLI_TEST_EXIT_MODE: exitMode } : {}),
      },
    }
  )
  const result = JSON.parse(stdout) as PtyResult
  return { ...result, output: Buffer.from(result.transcript, 'base64').toString() }
}

function expectRestoredTerminal(result: PtyResult & { output: string }): void {
  const enterAlternateScreen = '\u001b[?1049h'
  const leaveAlternateScreen = '\u001b[?1049l'
  const enableMouse = '\u001b[?1002h\u001b[?1006h'
  const disableMouse = '\u001b[?1006l\u001b[?1003l\u001b[?1002l'

  expect(result.termiosRestored).toBe(true)
  expect(result.output.split(enterAlternateScreen).length - 1).toBe(1)
  expect(result.output.split(leaveAlternateScreen).length - 1).toBe(1)
  expect(result.output.split(enableMouse).length - 1).toBe(1)
  expect(result.output.split(disableMouse).length - 1).toBe(1)
  expect(result.output.indexOf(enterAlternateScreen)).toBeLessThan(result.output.indexOf(leaveAlternateScreen))
  expect(result.output.indexOf(enableMouse)).toBeLessThan(result.output.indexOf(disableMouse))
  expect(result.output.slice(result.output.lastIndexOf(leaveAlternateScreen))).not.toContain(enableMouse)
  expect(result.output.lastIndexOf('\u001b[?1002h')).toBeLessThan(result.output.lastIndexOf(disableMouse))
  expect(result.output.lastIndexOf('\u001b[?1003h')).toBeLessThan(result.output.lastIndexOf(disableMouse))
}

describe.skipIf(process.platform === 'win32')('TUI PTY lifecycle', () => {
  // Mouse reporting must stay disabled after exit: https://github.com/strands-agents/harness-sdk/issues/4961
  it.each([
    ['exit', 23],
    ['exception', 1],
    ['rejection', 1],
  ] as const)('restores the terminal after an abrupt %s', async (mode, status) => {
    const result = await runPtySmoke(false, undefined, false, false, false, mode)

    expect(result.returnCode).toBe(status)
    expectRestoredTerminal(result)
  })

  it('resizes the real PTY without blanking and restores the terminal after /exit', async () => {
    const result = await runPtySmoke(false, undefined, false, false, true)
    const frames = Buffer.from(result.resizeTranscript, 'base64').toString()
    const burst = Buffer.from(result.resizeBurstTranscript, 'base64').toString()
    const noop = Buffer.from(result.resizeNoopTranscript, 'base64').toString()

    expect(result.returnCode).toBe(0)
    expect(frames.split('\u001b[1;1H')).toHaveLength(7)
    expect(burst.split('\u001b[1;1H')).toHaveLength(2)
    expect(noop).toBe('')
    for (const code of ['2J', '3J', '2K']) {
      expect(frames + burst).not.toContain(`\u001b[${code}`)
    }
    expectRestoredTerminal(result)
  })

  it('accepts typed edits and restores the terminal after /exit', async () => {
    const result = await runPtySmoke()

    expect(result.returnCode).toBe(0)
    expectRestoredTerminal(result)
  })

  it('bypasses the intro when the full frog does not fit and restores the terminal after /exit', async () => {
    const result = await runPtySmoke(true)
    const beforePrompt = result.output.slice(0, result.output.indexOf('Enter to send'))

    expect(result.returnCode).toBe(0)
    expect(sanitizeTerminalText(beforePrompt)).toMatch(STRANDS_WORDMARK)
    expect(sanitizeTerminalText(beforePrompt)).not.toContain('[ space to skip ]')
    expect(result.output).toContain('Enter to send')
    expect(beforePrompt.split('\u001b[2J').length - 1).toBe(1)
    expectRestoredTerminal(result)
  })

  it('accepts spaced text at startup and restores the terminal after /exit', async () => {
    const result = await runPtySmoke(true, undefined, true)
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toMatch(STRANDS_WORDMARK)
    expect(clean).not.toContain('[ space to skip ]')
    expect(clean).toContain('Enter to send')
    expect(clean).toContain('startup draft')
    expectRestoredTerminal(result)
  })

  it('runs one bang command inside the TUI and renders its full output', async () => {
    const result = await runPtySmoke(false, 'command')
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('__SHELL_LINE_1__')
    expect(clean).toContain('__SHELL_LINE_4__')
    expectRestoredTerminal(result)
  })

  it('plays the hidden frog animation and restores the terminal after /exit', async () => {
    const result = await runPtySmoke(false, undefined, false, true)
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('▗▄▄▖')
    expectRestoredTerminal(result)
  })

  it('delivers Ctrl-C to the active bang command without exiting', async () => {
    const result = await runPtySmoke(false, 'interrupt')
    const clean = sanitizeTerminalText(result.output)

    expect(result.returnCode).toBe(0)
    expect(clean).toContain('Cancelled')
    expectRestoredTerminal(result)
  })
})
