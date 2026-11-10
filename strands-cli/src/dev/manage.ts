import { dirname, join } from 'node:path'
import type { CliConfigStore } from '../config/store.js'
import type { ParsedArgs } from '../cli/arguments.js'
import type { StartupScreen, WorkspaceChange } from '../ui/run.js'
import { readDevWorkspace } from './workspace.js'
import { chooseWorkspaceReplacement, type WorkspaceSettingsAction } from './settings.js'
import { createWorkspaceReplacement } from './replace.js'
import { projectSetupSession } from './project-setup.js'

export const prepareWorkspaceChange = async (options: {
  args: ParsedArgs
  config: CliConfigStore
  action: WorkspaceSettingsAction
  screen: StartupScreen
  select(args: ParsedArgs, directory: string): Promise<void>
}): Promise<WorkspaceChange | undefined> => {
  const { args, config, action, screen, select } = options
  if (!args.dev?.workspace) throw new Error('No dev workspace is active.')
  const workspace = await readDevWorkspace(args.dev.workspace)
  if (!workspace?.directory) throw new Error('Initialize this workspace with a .config binding before editing it.')
  if (action === 'edit') {
    if (!screen.openProject) throw new Error('Workspace editing is unavailable in this terminal.')
    await screen.openProject({ root: workspace.directory, entrypoint: join(workspace.directory, '.config') })
    return undefined
  }
  const request = await chooseWorkspaceReplacement(workspace.directory, action, screen)
  if (!request) return undefined
  const transaction = await createWorkspaceReplacement({
    workspace,
    snapshot: config.snapshot(),
    request,
    signal: screen.signal,
    prepare: async (project): Promise<void> => {
      const result = await projectSetupSession().prepare(project, screen)
      if (result !== 'ready')
        throw new Error('Workspace replacement cancelled. The previous workspace will be restored.')
    },
  })
  const previousDirectory = process.cwd()
  return {
    apply: async (): Promise<void> => {
      screen.show(undefined, 'Replacing workspace…')
      process.chdir(dirname(workspace.directory!))
      const replacement = await transaction.apply()
      const { create: _create, ...dev } = args.dev!
      await select({ ...args, agent: replacement.entrypoint, dev: { ...dev, init: false } }, replacement.root)
    },
    rollback: async (): Promise<void> => {
      process.chdir(dirname(workspace.directory!))
      await transaction.rollback()
      process.chdir(previousDirectory)
      await select(args, workspace.root)
    },
    finish: transaction.finish,
  }
}
