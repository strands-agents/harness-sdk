import { join } from 'node:path'
import type { WorkspaceAction } from '../agent/configuration.js'
import type { ParsedArgs } from '../cli/arguments.js'
import type { CliConfigSnapshot } from '../config/store.js'
import type { StartupScreen, WorkspaceChange } from '../ui/run.js'
import { openDevRun } from './open.js'
import { projectSetupSession } from './project-setup.js'
import { readDevWorkspace } from './workspace.js'

interface WorkspaceChangeOptions {
  args: ParsedArgs
  savedConfig: CliConfigSnapshot
  launchDirectory: string
  action: WorkspaceAction
  screen: StartupScreen
  select(args: ParsedArgs, directory: string): Promise<void>
}

export const prepareWorkspaceChange = async (options: WorkspaceChangeOptions): Promise<WorkspaceChange | undefined> => {
  const { args, savedConfig, launchDirectory, action, screen, select } = options
  if (!args.dev?.workspace) throw new Error('No dev workspace is active.')
  const workspace = await readDevWorkspace(args.dev.workspace)
  if (!workspace?.directory) throw new Error('Initialize this workspace with a .config binding before editing it.')
  const { directory } = workspace
  if (action === 'edit') {
    if (!screen.openProject) throw new Error('Workspace editing is unavailable in this terminal.')
    await screen.openProject({ root: directory, entrypoint: join(directory, '.config') })
    return undefined
  }
  const previousDirectory = process.cwd()
  const opened = await openDevRun({
    args,
    savedConfig,
    launchDirectory,
    screen,
    setup: projectSetupSession(),
    leaving: {
      workspace: { ...workspace, directory },
      entrypoints: [workspace.entrypoint, ...(args.agent ? [args.agent] : [])],
    },
  }).finally(() => process.chdir(previousDirectory))
  if (!opened) return undefined
  return {
    apply: () => select(opened.args, opened.workspace.root),
    rollback: async (): Promise<void> => {
      await select(args, previousDirectory)
      await opened.discard()
    },
    finish: opened.keep,
  }
}
