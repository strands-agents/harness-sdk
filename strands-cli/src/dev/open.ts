import type { ParsedArgs } from '../cli/arguments.js'
import type { CliConfigSnapshot, CliConfigStore } from '../config/store.js'
import type { StartupScreen } from '../ui/run.js'
import { prepareDevRun, type LeavingWorkspace, type PreparedDevRun } from './prepare.js'
import type { ProjectSetupSession } from './project-setup.js'

export interface DevRunRequest {
  args: ParsedArgs
  savedConfig: CliConfigSnapshot
  launchDirectory: string
  screen: StartupScreen
  setup: ProjectSetupSession
  config?: CliConfigStore
  rejected?: PreparedDevRun
  leaving?: LeavingWorkspace
}

const pickerArgs = (args: ParsedArgs, keepWorkspace: boolean): ParsedArgs => {
  const { init, searchRoots, workspace } = args.dev!
  return {
    ...args,
    agent: undefined,
    dev: { init, searchRoots, ...(keepWorkspace && workspace ? { workspace } : {}) },
  }
}

export const openDevRun = async (request: DevRunRequest): Promise<PreparedDevRun | undefined> => {
  const { args, savedConfig, launchDirectory, screen, setup, config, leaving } = request
  let rejected = request.rejected
  for (;;) {
    process.chdir(launchDirectory)
    const prepared = await prepareDevRun(rejected || leaving ? pickerArgs(args, !leaving) : args, {
      ...(config ? { config } : {}),
      savedConfig,
      screen,
      deferPreparation: true,
      ...(rejected ? { rejected } : {}),
      ...(leaving ? { leaving } : {}),
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
