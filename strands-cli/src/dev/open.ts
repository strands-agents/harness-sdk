import type { ParsedArgs } from '../cli/arguments.js'
import type { CliConfigSnapshot, CliConfigStore } from '../config/store.js'
import type { StartupScreen } from '../ui/run.js'
import { ensureInitialCandidate } from './initialize.js'
import { prepareDevRun, type LeavingWorkspace, type PreparedDevRun } from './prepare.js'
import type { ProjectSetupSession } from './project-setup.js'
import type { DevWorkspace } from './workspace.js'

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

const initialCopy =
  (workspace: DevWorkspace, screen: StartupScreen) =>
  async (install: boolean): Promise<void> => {
    screen.show(undefined, 'Initializing developer workspace…')
    const { planProjectPreparation } = await import('../project/preparation-plan.js')
    const { executePreparation } = await import('../project/preparation.js')
    await ensureInitialCandidate(workspace, screen.signal, async (candidate): Promise<void> => {
      if (install) await executePreparation(await planProjectPreparation(candidate), { signal: screen.signal })
    })
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
    const result = await setup.prepare(
      { root, entrypoint, language: bound.language },
      screen,
      initialCopy(prepared.workspace, screen)
    )
    if (result === 'cancel') {
      await prepared.discard()
      return undefined
    }
    if (result === 'ready')
      return { ...prepared, args: { ...prepared.args, dev: { ...prepared.args.dev!, prepared: true } } }
    rejected = prepared
  }
}
