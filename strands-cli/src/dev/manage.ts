import { dirname, join } from 'node:path'
import type { WorkspaceAction } from '../agent/configuration.js'
import type { ParsedArgs } from '../cli/arguments.js'
import type { CliConfigSnapshot } from '../config/store.js'
import { containsPath } from '../paths.js'
import type { ImportedAgentProject } from '../project/import.js'
import type { StartupScreen, WorkspaceChange } from '../ui/run.js'
import type { BaseCliOption, HarnessChoice } from './picker.js'
import { projectSetupSession } from './project-setup.js'
import { createWorkspaceReplacement, type WorkspaceReplacement } from './replace.js'
import { baseHarnessProject, discoverLocalHarnesses, distinctHarnesses } from './selection.js'
import { confirmWorkspaceReplacement } from './settings.js'
import { readDevWorkspace, type DevWorkspace } from './workspace.js'
import type { DiscoveredHarness } from './search.js'

interface WorkspaceChangeOptions {
  args: ParsedArgs
  savedConfig: CliConfigSnapshot
  launchDirectory: string
  action: WorkspaceAction
  screen: StartupScreen
  select(args: ParsedArgs, directory: string): Promise<void>
}

type BoundWorkspace = DevWorkspace & { directory: string }

const outside =
  (directory: string) =>
  ({ root }: { root: string }): boolean =>
    !containsPath(directory, root) && !containsPath(root, directory)

const savedAgentProject = (
  savedConfig: CliConfigSnapshot,
  launchDirectory: string
): ImportedAgentProject | undefined => {
  try {
    return baseHarnessProject(savedConfig, launchDirectory)
  } catch {
    return undefined
  }
}

const baseCliOption = async (
  workspace: BoundWorkspace,
  { savedConfig, launchDirectory }: WorkspaceChangeOptions,
  current: readonly string[]
): Promise<BaseCliOption | undefined> => {
  if (workspace.config.origin.kind === 'cli') return undefined
  const option = { name: savedConfig.profile.name }
  if (!savedConfig.agentProject) return { ...option, path: savedConfig.path }
  const project = savedAgentProject(savedConfig, launchDirectory)
  if (!project || !outside(workspace.directory)(project)) return undefined
  const [visible] = await distinctHarnesses([{ ...project, name: option.name }], current)
  return visible ? { ...option, path: project.entrypoint } : undefined
}

const replacementWarning = ({ directory, root, config }: BoundWorkspace): string =>
  containsPath(directory, root)
    ? `When you select an agent, strands dev deletes your current agent (${config.name}) and all files in ${directory}.`
    : `When you select an agent, strands dev deletes your current agent (${config.name}) and the folder ${directory}. The project files in ${root} stay on disk.`

const replacementLabel = (choice: HarnessChoice, cliName: string): string => {
  switch (choice.kind) {
    case 'cli':
      return `Base CLI · ${cliName}`
    case 'discovered':
      return `${choice.harness.name} · ${choice.harness.entrypoint}`
    case 'create':
      return `New ${choice.language} agent · ${choice.name}`
  }
}

const chooseReplacement = async (
  workspace: BoundWorkspace,
  options: WorkspaceChangeOptions
): Promise<WorkspaceReplacement | undefined> => {
  const { args, savedConfig, launchDirectory, screen } = options
  const { directory } = workspace
  const current = [workspace.entrypoint, ...(args.agent ? [args.agent] : [])]
  const cli = await baseCliOption(workspace, options, current)
  const linked = savedConfig.agentProject ? cli?.path : undefined
  const snapshot = linked ? { ...savedConfig, agentProject: linked } : savedConfig
  screen.signal.throwIfAborted()
  const visible = outside(directory)
  const picker = {
    ...(cli ? { cli } : {}),
    harnesses: [],
    search: async (
      found: (harness: DiscoveredHarness) => void,
      signal: AbortSignal
    ): Promise<readonly DiscoveredHarness[]> =>
      (
        await discoverLocalHarnesses(
          launchDirectory,
          args.dev?.searchRoots ?? [],
          [...current, ...(linked ? [linked] : [])],
          {
            signal,
            found: (harness): void => {
              if (visible(harness)) found(harness)
            },
          }
        )
      ).filter(visible),
    warning: replacementWarning(workspace),
  }
  const { chooseHarness } = await import('./picker.js')
  for (;;) {
    const selected = await chooseHarness(picker, screen, async (choice) => ({
      label: replacementLabel(choice, savedConfig.profile.name),
      transaction: await createWorkspaceReplacement({
        workspace,
        snapshot,
        request: choice.kind === 'discovered' ? { kind: 'import', path: choice.harness.entrypoint } : choice,
        signal: screen.signal,
        prepare: async (project): Promise<void> => {
          const result = await projectSetupSession().prepare(project, screen)
          if (result !== 'ready')
            throw new Error('Workspace replacement cancelled. The previous workspace will be restored.')
        },
      }),
    }))
    if (!selected) return undefined
    if (await confirmWorkspaceReplacement(directory, selected.label, screen)) return selected.transaction
    if (screen.signal.aborted) return undefined
  }
}

export const prepareWorkspaceChange = async (options: WorkspaceChangeOptions): Promise<WorkspaceChange | undefined> => {
  const { args, action, screen, select } = options
  if (!args.dev?.workspace) throw new Error('No dev workspace is active.')
  const workspace = await readDevWorkspace(args.dev.workspace)
  if (!workspace?.directory) throw new Error('Initialize this workspace with a .config binding before editing it.')
  const { directory } = workspace
  if (action === 'edit') {
    if (!screen.openProject) throw new Error('Workspace editing is unavailable in this terminal.')
    await screen.openProject({ root: directory, entrypoint: join(directory, '.config') })
    return undefined
  }
  const transaction = await chooseReplacement({ ...workspace, directory }, options)
  if (!transaction) return undefined
  const previousDirectory = process.cwd()
  return {
    apply: async (): Promise<void> => {
      screen.show(undefined, 'Replacing workspace…')
      process.chdir(dirname(directory))
      const replacement = await transaction.apply()
      const { create: _create, ...dev } = args.dev!
      await select({ ...args, agent: replacement.entrypoint, dev: { ...dev, init: false } }, replacement.root)
    },
    rollback: async (): Promise<void> => {
      process.chdir(dirname(directory))
      await transaction.rollback()
      process.chdir(previousDirectory)
      await select(args, workspace.root)
    },
    finish: transaction.finish,
  }
}
