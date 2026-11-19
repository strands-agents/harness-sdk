import { join } from 'node:path'
import type { ParsedArgs } from '../cli/arguments.js'
import type { StartupScreen } from '../ui/run.js'
import { readDevWorkspace } from './workspace.js'

export const openWorkspaceConfiguration = async (args: ParsedArgs, screen: StartupScreen): Promise<void> => {
  if (!args.dev?.workspace) throw new Error('No dev workspace is active.')
  const workspace = await readDevWorkspace(args.dev.workspace)
  if (!workspace?.directory) throw new Error('Initialize this workspace with a .config binding before editing it.')
  if (!screen.openProject) throw new Error('Workspace editing is unavailable in this terminal.')
  await screen.openProject({ root: workspace.directory, entrypoint: join(workspace.directory, '.config') })
}
