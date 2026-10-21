import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { URL, fileURLToPath } from 'node:url'
import { expect } from 'vitest'

import type { TUI_CASE } from './catalog.js'

const execFileAsync = promisify(execFile)

export type TuiScenario = (typeof TUI_CASE)[keyof typeof TUI_CASE]['scenario']

export type TuiDriverScenario =
  | TuiScenario
  | 'export-failure'
  | 'lifecycle-profile'
  | 'lifecycle-project'
  | 'lifecycle-setup-import'
  | 'live-self-building'

export interface TuiResult {
  returnCode: number
  termiosRestored: boolean | null
  output: string
  screens: string[]
  resizeScreens: Array<{ columns: number; rows: number; text: string }>
  exportSaved: boolean
}

export async function runTuiScenario(scenario: TuiScenario): Promise<TuiResult> {
  const loader = new URL('../fixtures/strands-cli-routing-source-loader.mjs', import.meta.url).href
  const fixture = fileURLToPath(new URL('../fixtures/tui-integration-process.mjs', import.meta.url))
  const exportPath = join(tmpdir(), `strands-tui-export-${randomUUID()}.zip`)
  try {
    return await runTuiCommand({
      scenario,
      command: [process.execPath, '--no-warnings=ExperimentalWarning', '--experimental-loader', loader, fixture],
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      exportPath,
    })
  } finally {
    await rm(exportPath, { force: true })
  }
}

export async function runTuiCommand(options: {
  scenario: TuiDriverScenario
  command: readonly string[]
  cwd: string
  exportPath: string
  exportLanguage?: 'typescript' | 'python'
  importPath?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
}): Promise<TuiResult> {
  const windows = process.platform === 'win32'
  const driver = fileURLToPath(
    new URL(
      windows ? '../fixtures/tui-integration-conpty-driver.mjs' : '../fixtures/tui-integration-pty-driver.py',
      import.meta.url
    )
  )
  const { stdout } = await execFileAsync(
    windows ? process.execPath : (process.env.PYTHON ?? 'python3'),
    [driver, ...options.command],
    {
      cwd: options.cwd,
      timeout: options.timeout ?? 25_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        ...options.env,
        ...(options.exportLanguage ? { STRANDS_CLI_TEST_EXPORT_LANGUAGE: options.exportLanguage } : {}),
        STRANDS_CLI_TEST_EXPORT_PATH: options.exportPath,
        ...(options.importPath ? { STRANDS_CLI_TEST_IMPORT_PATH: options.importPath } : {}),
        STRANDS_CLI_TEST_SCENARIO: options.scenario,
      },
    }
  )
  const result = JSON.parse(stdout) as Omit<TuiResult, 'output'> & {
    transcript: string
  }
  return {
    returnCode: result.returnCode,
    termiosRestored: result.termiosRestored,
    output: decode(result.transcript),
    screens: result.screens,
    resizeScreens: result.resizeScreens,
    exportSaved: result.exportSaved,
  }
}

export function expectRestoredTerminal(result: TuiResult): void {
  const enterAlternateScreen = '\u001b[?1049h'
  const leaveAlternateScreen = '\u001b[?1049l'

  if (result.termiosRestored !== null) {
    expect(result.termiosRestored).toBe(true)
  }
  expect(result.output.split(enterAlternateScreen).length - 1).toBe(1)
  expect(result.output.split(leaveAlternateScreen).length - 1).toBe(1)
  expect(result.output.indexOf(enterAlternateScreen)).toBeLessThan(result.output.indexOf(leaveAlternateScreen))
}

function decode(value: string): string {
  return Buffer.from(value, 'base64').toString()
}
