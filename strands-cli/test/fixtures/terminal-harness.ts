import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { URL, fileURLToPath } from 'node:url'
import type { IModes } from '@xterm/headless'
import { expect } from 'vitest'

const execFileAsync = promisify(execFile)

export type TuiScenario =
  | 'follow-up'
  | 'queue'
  | 'voice'
  | 'approval'
  | 'setup-export'
  | 'panels'
  | 'shell-command'
  | 'shell-interrupt'
  | 'startup'
  | 'startup-typing'
  | 'resize'
  | 'exit'
  | 'exit-direct'
  | 'exit-exception'
  | 'exit-rejection'
  | 'exit-sigterm'
  | 'exit-sigint'
  | 'exit-sighup'

export type TuiDriverScenario =
  | TuiScenario
  | 'export-failure'
  | 'lifecycle-profile'
  | 'lifecycle-project'
  | 'lifecycle-setup-import'
  | 'live-self-building'
  | 'builtin-tools'

export interface TuiResult {
  returnCode: number
  inputModeRestored: boolean | null
  terminalModes: IModes
  output: string
  screens: string[]
  resizeScreens: Array<{ columns: number; rows: number; text: string }>
  exportSaved: boolean
}

export async function runTuiScenario(scenario: TuiScenario): Promise<TuiResult> {
  const fixture = fileURLToPath(new URL('./tui-integration-process.mjs', import.meta.url))
  const exportPath = join(tmpdir(), `strands-tui-export-${randomUUID()}.zip`)
  try {
    return await runTuiCommand({
      scenario,
      command: [process.execPath, '--import', import.meta.resolve('tsx/esm'), fixture],
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
  const driver = fileURLToPath(new URL('./tui-integration-driver.mjs', import.meta.url))
  const { stdout } = await execFileAsync(process.execPath, [driver, ...options.command], {
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
  })
  const result = JSON.parse(stdout) as Omit<TuiResult, 'output'> & {
    transcript: string
  }
  return {
    returnCode: result.returnCode,
    inputModeRestored: result.inputModeRestored,
    terminalModes: result.terminalModes,
    output: decode(result.transcript),
    screens: result.screens,
    resizeScreens: result.resizeScreens,
    exportSaved: result.exportSaved,
  }
}

export function expectRestoredTerminal(result: TuiResult): void {
  const enterAlternateScreen = '\u001b[?1049h'
  const leaveAlternateScreen = '\u001b[?1049l'

  if (result.inputModeRestored !== null) {
    expect(result.inputModeRestored).toBe(true)
  }
  expect(result.output.split(enterAlternateScreen).length - 1).toBe(1)
  expect(result.output.split(leaveAlternateScreen).length - 1).toBe(1)
  expect(result.output.indexOf(enterAlternateScreen)).toBeLessThan(result.output.indexOf(leaveAlternateScreen))
  // eslint-disable-next-line no-control-regex -- ConPTY combines parameters in terminal mode controls.
  const controls = [...result.output.matchAll(/\u001b\[\?([\d;]+)([hl])/gu)]
  expect(result.terminalModes, JSON.stringify(controls.map(([sequence]) => sequence))).toMatchObject({
    mouseTrackingMode: 'none',
    bracketedPasteMode: false,
    synchronizedOutputMode: false,
  })
  const modes = new Map<string, boolean>()
  for (const [, parameters, action] of controls) {
    for (const mode of parameters!.split(';')) modes.set(mode, action === 'h')
  }
  expect(modes.get('1006')).toBe(false)
  expect(modes.get('2031')).not.toBe(true)
  expect(modes.get('25')).toBe(true)
}

function decode(value: string): string {
  return Buffer.from(value, 'base64').toString()
}
