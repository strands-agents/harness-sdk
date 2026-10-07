import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { URL, fileURLToPath } from 'node:url'
import { expect } from 'vitest'

const execFileAsync = promisify(execFile)

export type TuiScenario =
  'chat' | 'exit' | 'frog' | 'panels' | 'resize' | 'shell-command' | 'shell-interrupt' | 'startup' | 'startup-typing'

export interface TuiResult {
  returnCode: number
  termiosRestored: boolean | null
  output: string
  resizeOutput: string
  resizeBurstOutput: string
  resizeNoopOutput: string
}

export async function runTuiScenario(scenario: TuiScenario): Promise<TuiResult> {
  const windows = process.platform === 'win32'
  const driver = fileURLToPath(
    new URL(
      windows ? '../fixtures/tui-integration-conpty-driver.mjs' : '../fixtures/tui-integration-pty-driver.py',
      import.meta.url
    )
  )
  const loader = fileURLToPath(new URL('../fixtures/strands-cli-routing-source-loader.mjs', import.meta.url))
  const fixture = fileURLToPath(new URL('../fixtures/tui-integration-process.mjs', import.meta.url))
  const { stdout } = await execFileAsync(
    windows ? process.execPath : (process.env.PYTHON ?? 'python3'),
    [driver, process.execPath, '--no-warnings=ExperimentalWarning', '--experimental-loader', loader, fixture],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      timeout: 25_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        STRANDS_CLI_TEST_SCENARIO: scenario,
      },
    }
  )
  const result = JSON.parse(stdout) as Omit<TuiResult, 'output' | 'resizeOutput'> & {
    transcript: string
    resizeTranscript: string
    resizeBurstTranscript: string
    resizeNoopTranscript: string
  }
  return {
    returnCode: result.returnCode,
    termiosRestored: result.termiosRestored,
    output: decode(result.transcript),
    resizeOutput: decode(result.resizeTranscript),
    resizeBurstOutput: decode(result.resizeBurstTranscript),
    resizeNoopOutput: decode(result.resizeNoopTranscript),
  }
}

export function expectRestoredTerminal(result: TuiResult): void {
  const enterAlternateScreen = '\u001b[?1049h'
  const leaveAlternateScreen = '\u001b[?1049l'
  const enableMouse = '\u001b[?1002h\u001b[?1006h'
  const disableMouse = '\u001b[?1006l\u001b[?1003l\u001b[?1002l'

  if (result.termiosRestored !== null) {
    expect(result.termiosRestored).toBe(true)
  }
  expect(result.output.split(enterAlternateScreen).length - 1).toBe(1)
  expect(result.output.split(leaveAlternateScreen).length - 1).toBe(1)
  expect(result.output.split(enableMouse).length - 1).toBe(1)
  expect(result.output.split(disableMouse).length - 1).toBe(1)
  expect(result.output.indexOf(enterAlternateScreen)).toBeLessThan(result.output.indexOf(leaveAlternateScreen))
  expect(result.output.indexOf(enableMouse)).toBeLessThan(result.output.indexOf(disableMouse))
  expect(result.output.slice(result.output.lastIndexOf(leaveAlternateScreen))).not.toContain(enableMouse)
}

function decode(value: string): string {
  return Buffer.from(value, 'base64').toString()
}
