import type { ParsedArgs } from '../cli/arguments.js'
import type { CliConfigSnapshot, CliConfigStore } from '../config/store.js'
import type { StartupScreen } from '../ui/run.js'
import { prepareDevRun, type PreparedDevRun } from './prepare.js'
import type { ProjectSetupSession } from './project-setup.js'

export interface DevRunRequest {
  args: ParsedArgs
  savedConfig: CliConfigSnapshot
  launchDirectory: string
  screen: StartupScreen
  setup: ProjectSetupSession
  config?: CliConfigStore
  rejected?: PreparedDevRun
}

const pickerArgs = (args: ParsedArgs): ParsedArgs => {
  const { init, searchRoots, workspace } = args.dev!
  return { ...args, agent: undefined, dev: { init, searchRoots, ...(workspace ? { workspace } : {}) } }
}

export const openDevRun = async (request: DevRunRequest): Promise<PreparedDevRun | undefined> => {
  const { args, savedConfig, launchDirectory, screen, setup, config } = request
  let rejected = request.rejected
  for (;;) {
    process.chdir(launchDirectory)
    const prepared = await prepareDevRun(rejected ? pickerArgs(args) : args, {
      ...(config ? { config } : {}),
      savedConfig,
      screen,
      deferPreparation: true,
      ...(rejected ? { rejected } : {}),
    })
    if (!prepared) return undefined
    if (screen.signal.aborted) {
      await prepared.discard()
      return undefined
    }
    const { root, entrypoint, config: bound } = prepared.workspace
    const result = await setup.prepare({ root, entrypoint, language: bound.language }, screen)
    if (result === 'cancel') {
      await prepared.discard()
      return undefined
    }
    if (result === 'ready')
      return { ...prepared, args: { ...prepared.args, dev: { ...prepared.args.dev!, prepared: true } } }
    rejected = prepared
  }
}
