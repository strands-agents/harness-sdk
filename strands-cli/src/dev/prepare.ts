import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { type ParsedArgs } from '../cli/arguments.js'
import { CliConfigStore, type CliConfigSnapshot } from '../config/store.js'
import { containsPath, expandHome } from '../paths.js'
import { importAgentProject } from '../project/import.js'
import { prepareWorkspaceDependencies } from '../project/archive.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/text.js'
import {
  bindExistingAgent,
  createDevProject,
  createDevWorkspace,
  existingDevProject,
  folderClaims,
  newProjectFolder,
  numberedFolder,
  type FolderClaims,
} from './create.js'
import { DevFailure } from './errors.js'
import {
  findDevWorkspace,
  readDevWorkspace,
  entrypointWorkspaceFolder,
  workspaceFolder,
  WORKSPACE_FOLDER,
  type DevWorkspace,
} from './workspace.js'
import type { StartupScreen } from '../ui/run.js'
import type { FolderSuggestion, HarnessChoice } from './picker.js'
import type { DiscoveredHarness } from './search.js'
import { baseHarnessSelection, discoverLocalHarnesses, harnessFolder } from './selection.js'
import { ensureInitialCandidate, initializeWorkspaceBinding } from './initialize.js'

export interface PreparedDevRun {
  args: ParsedArgs
  config: CliConfigStore
  workspace: DevWorkspace
  rejectedFolders: readonly string[]
  discard(): Promise<void>
}

interface CreationRequest {
  kind: 'cli' | 'typescript' | 'python'
  destination: string | undefined
  cwd: string
  snapshot: CliConfigSnapshot
  claims: FolderClaims
  signal: AbortSignal | undefined
  deferDependencies: boolean
}

const createProject = async (
  claims: FolderClaims,
  options: Parameters<typeof createDevProject>[0]
): Promise<DevWorkspace> => {
  const created = await createDevProject(options)
  claims.claimCreated(created.root)
  return created
}

const createRequested = async ({
  kind,
  destination,
  cwd,
  snapshot,
  claims,
  signal,
  deferDependencies,
}: CreationRequest): Promise<DevWorkspace> => {
  const options = { snapshot, cwd, ...(signal ? { signal } : {}), ...(deferDependencies ? { deferDependencies } : {}) }
  if (kind !== 'cli' && !destination)
    return (
      (await existingDevProject(cwd, kind, snapshot.profile.name)) ??
      createProject(claims, { ...options, language: kind })
    )
  const target = resolve(cwd, destination ?? (await baseHarnessSelection(snapshot, cwd)).workspace)
  await claims.claim(target)
  return createDevWorkspace({ ...options, kind, destination: target })
}

interface FolderDefaults {
  folderFor: (choice: HarnessChoice) => FolderSuggestion | undefined
  newProject?: string
  suggestFor(harness: DiscoveredHarness): Promise<void>
}

const folderDefaults = async (
  cliFolder: string,
  { cwd, destination, avoided }: { cwd: string; destination: string | undefined; avoided: ReadonlySet<string> }
): Promise<FolderDefaults> => {
  const unlessAvoided = async (folder: string): Promise<string> =>
    avoided.has(folder) ? availableFolder(folder, undefined, avoided) : folder
  if (destination)
    return {
      folderFor: await folderSuggestion(await unlessAvoided(destination)),
      suggestFor: async (): Promise<void> => {},
    }
  const cli = await folderSuggestion(await unlessAvoided(cliFolder))
  const found = new Map<string, FolderSuggestion>()
  return {
    folderFor: (choice) =>
      choice.kind === 'cli'
        ? cli(choice)
        : choice.kind === 'discovered'
          ? (found.get(choice.harness.entrypoint) ?? {
              path: join(dirname(choice.harness.entrypoint), WORKSPACE_FOLDER),
              detected: false,
            })
          : undefined,
    newProject: await newProjectFolder(cwd),
    suggestFor: async (harness): Promise<void> => {
      const choice = { kind: 'discovered', harness } as const
      const suggested = await availableFolder(
        join(dirname(harness.entrypoint), WORKSPACE_FOLDER),
        (workspace): boolean => holdsChoice(workspace, choice),
        avoided
      )
      found.set(harness.entrypoint, (await folderSuggestion(suggested))(choice))
    },
  }
}

interface WorkspaceSelection {
  snapshot: CliConfigSnapshot
  claims: FolderClaims
  screen: StartupScreen | undefined
  avoided: ReadonlySet<string> | undefined
  warning: string | undefined
  deferDependencies: boolean
}

const selectWorkspace = async (
  args: ParsedArgs,
  { snapshot, claims, screen, avoided, warning, deferDependencies }: WorkspaceSelection
): Promise<DevWorkspace | undefined> => {
  const dev = args.dev!
  const cwd = process.cwd()
  const destination = dev.workspace ? await workspaceFolder(resolve(cwd, expandHome(dev.workspace))) : undefined
  const signal = screen?.signal
  if (dev.create)
    return createRequested({ kind: dev.create, destination, cwd, snapshot, claims, signal, deferDependencies })
  if (args.agent) return openExplicitHarness(resolve(cwd, expandHome(args.agent)), claims, destination)
  const existing =
    (await findDevWorkspace(destination ?? cwd)) ??
    (!destination ? await readDevWorkspace(join(cwd, WORKSPACE_FOLDER)) : undefined)
  const reselecting = avoided !== undefined
  if (existing && !reselecting) return existing
  if (destination && !dev.init && !reselecting)
    throw new Error(`No dev workspace at ${destination}. Run strands dev init --workspace <path> --create cli.`)
  if (!screen)
    throw new Error('Run strands dev init in a terminal, or select --workspace, --agent, or --create explicitly.')
  const base = await baseHarnessSelection(snapshot, cwd, destination)
  const { suggestFor, ...folders } = await folderDefaults(base.workspace, {
    cwd,
    destination,
    avoided: avoided ?? new Set(),
  })
  screen.signal.throwIfAborted()
  const { chooseHarness } = await import('./picker.js')
  return chooseHarness(
    {
      cli: { name: base.name, path: base.source },
      harnesses: [],
      ...(warning ? { warning } : {}),
      search: (found, signal) =>
        discoverLocalHarnesses(cwd, dev.searchRoots, base.excludedEntrypoints, {
          signal,
          found: async (harness): Promise<void> => {
            await suggestFor(harness)
            found(harness)
          },
        }),
      ...folders,
    },
    screen,
    async (choice, signal, chosen): Promise<DevWorkspace> => {
      signal.throwIfAborted()
      const folder = chosen ?? folders.folderFor(choice)?.path
      if (folder === undefined)
        return createInLaunchFolder(choice, { cwd, snapshot, claims, signal, deferDependencies })
      const directory = await workspaceFolder(resolve(cwd, expandHome(folder)))
      const placed = await placeHarness(choice, { directory, cwd, snapshot, claims, signal, deferDependencies })
      return placed.directory ? placed : initializeWorkspaceBinding(placed, directory)
    }
  )
}

interface HarnessPlacement {
  directory: string
  cwd: string
  snapshot: CliConfigSnapshot
  claims: FolderClaims
  signal: AbortSignal
  deferDependencies: boolean
}

const folderUnavailable = (directory: string, reason: string): DevFailure =>
  new DevFailure(
    [
      'Workspace folder is not available.',
      `Folder: ${sanitizeTerminalText(directory)}`,
      `Reason: ${reason}`,
      'Next: Choose a new or empty folder, or the existing workspace of this agent.',
    ].join('\n'),
    undefined
  )

const folderEntries = async (directory: string): Promise<string[]> => {
  try {
    return await readdir(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    if (code === 'ENOTDIR') throw folderUnavailable(directory, 'The path is a file, not a folder.')
    throw error
  }
}

const acceptsFolder = async (folder: string, holds?: (workspace: DevWorkspace) => boolean): Promise<boolean> => {
  const entries = await folderEntries(folder).catch(() => undefined)
  if (!entries) return false
  if (!entries.length) return true
  if (!holds) return false
  const existing = await readDevWorkspace(folder).catch(() => undefined)
  return existing !== undefined && holds(existing)
}

const availableFolder = async (
  preferred: string,
  holds?: (workspace: DevWorkspace) => boolean,
  avoided: ReadonlySet<string> = new Set()
): Promise<string> =>
  (await numberedFolder(preferred, (folder) => acceptsFolder(folder, avoided.has(folder) ? undefined : holds))) ??
  preferred

const folderSuggestion = async (path: string): Promise<(choice: HarnessChoice) => FolderSuggestion> => {
  const existing = await readDevWorkspace(path).catch(() => undefined)
  return (choice) => ({ path, detected: existing !== undefined && holdsChoice(existing, choice) })
}

const holdsChoice = ({ root, config }: DevWorkspace, choice: HarnessChoice): boolean => {
  switch (choice.kind) {
    case 'discovered':
      return root === choice.harness.root
    case 'cli':
      return config.origin.kind === 'cli'
    case 'create':
      return config.origin.kind === 'created' && config.name === choice.name && config.language === choice.language
  }
}

const reuseFolder = async (choice: HarnessChoice, directory: string, claims: FolderClaims): Promise<DevWorkspace> => {
  const existing = await readDevWorkspace(directory)
  if (existing && !holdsChoice(existing, choice))
    throw folderUnavailable(
      directory,
      `The folder contains the workspace of ${sanitizeTerminalText(existing.config.name)}.`
    )
  if (existing)
    return choice.kind === 'discovered' ? openExplicitHarness(choice.harness.entrypoint, claims, directory) : existing
  const legacy = choice.kind === 'cli' ? await readDevWorkspace(join(directory, 'base-cli')) : undefined
  if (legacy) return initializeWorkspaceBinding(legacy, directory)
  throw folderUnavailable(directory, 'The folder already contains files.')
}

const withProfileName = (snapshot: CliConfigSnapshot, name: string): CliConfigSnapshot => ({
  ...snapshot,
  profile: { ...snapshot.profile, name },
})

const createInFolder = async (
  choice: Exclude<HarnessChoice, { kind: 'discovered' }>,
  { directory, cwd, snapshot, claims, signal, deferDependencies }: HarnessPlacement
): Promise<DevWorkspace> => {
  await claims.claim(directory)
  return createDevWorkspace({
    destination: directory,
    kind: choice.kind === 'cli' ? 'cli' : choice.language,
    snapshot: choice.kind === 'create' ? withProfileName(snapshot, choice.name) : snapshot,
    ...(deferDependencies ? { deferDependencies: true } : {}),
    cwd,
    signal,
  })
}

const createInLaunchFolder = async (
  choice: HarnessChoice,
  { cwd, snapshot, claims, signal, deferDependencies }: Omit<HarnessPlacement, 'directory'>
): Promise<DevWorkspace> => {
  if (choice.kind !== 'create') throw new Error('Choose a workspace folder for this harness.')
  return createProject(claims, {
    language: choice.language,
    snapshot: withProfileName(snapshot, choice.name),
    cwd,
    signal,
    ...(deferDependencies ? { deferDependencies: true } : {}),
  })
}

const placeHarness = async (choice: HarnessChoice, placement: HarnessPlacement): Promise<DevWorkspace> => {
  const { directory, claims } = placement
  if ((await folderEntries(directory)).length) return reuseFolder(choice, directory, claims)
  if (choice.kind === 'discovered') return openExplicitHarness(choice.harness.entrypoint, claims, directory)
  return createInFolder(choice, placement)
}

const openExplicitHarness = async (path: string, claims: FolderClaims, folder?: string): Promise<DevWorkspace> => {
  const details = await lstat(path)
  if (details.isSymbolicLink()) throw new Error('Select a real harness path, not a symbolic link.')
  const project = importAgentProject(path)
  const directory =
    folder ??
    (await availableFolder(join(harnessFolder(path, project), WORKSPACE_FOLDER), ({ root }) => root === project.root))
  const existing = await readDevWorkspace(directory)
  if (!existing) {
    await claims.claim(directory)
    return bindExistingAgent(directory, project.entrypoint)
  }
  if (project.root !== existing.root) throw new Error('The explicit agent must belong to the bound project.')
  return {
    ...existing,
    entrypoint: project.entrypoint,
    config: {
      ...existing.config,
      language: project.language,
      entrypoint: relative(project.root, project.entrypoint).split(sep).join('/'),
    },
  }
}

const discardRejected = async (rejected: PreparedDevRun | undefined): Promise<string | undefined> => {
  try {
    await rejected?.discard()
    return undefined
  } catch (error) {
    return `Could not delete the folders of the failed setup: ${errorMessage(error)}`
  }
}

export const prepareDevRun = async (
  args: ParsedArgs,
  options: {
    config?: CliConfigStore
    savedConfig?: CliConfigSnapshot
    screen?: StartupScreen
    deferPreparation?: boolean
    rejected?: PreparedDevRun
  } = {}
): Promise<PreparedDevRun | undefined> => {
  const { screen, rejected } = options
  const config = options.config ?? (await CliConfigStore.load(undefined, { persist: false }))
  config.useEnvironmentFiles(args.envFiles)
  screen?.signal.throwIfAborted()
  screen?.show(undefined, 'Preparing local workspace…')
  const warning = await discardRejected(rejected)
  const claims = folderClaims()
  const avoided =
    rejected && new Set([...rejected.rejectedFolders, rejected.workspace.directory ?? rejected.workspace.root])
  const selected = await selectWorkspace(args, {
    snapshot: options.savedConfig ?? config.snapshot(),
    claims,
    screen,
    avoided,
    warning,
    deferDependencies: options.deferPreparation ?? false,
  })
  screen?.signal.throwIfAborted()
  if (!selected) return undefined
  const target = args.dev?.workspace
    ? await workspaceFolder(resolve(process.cwd(), expandHome(args.dev.workspace)))
    : entrypointWorkspaceFolder(selected)
  const persisted = await readDevWorkspace(selected.directory ?? selected.root)
  const bound = persisted?.root === selected.root ? persisted : selected
  await claims.claim(resolve(bound.directory ?? target))
  const main = await initializeWorkspaceBinding(bound, target)
  const workspace =
    selected.entrypoint === main.entrypoint
      ? main
      : {
          ...main,
          entrypoint: selected.entrypoint,
          config: { ...main.config, language: selected.config.language, entrypoint: selected.config.entrypoint },
        }
  let initial: string | undefined
  if (!options.deferPreparation) {
    if (screen) screen.show(undefined, 'Installing initial agent copy…')
    else process.stderr.write('Installing initial agent copy...\n')
    initial = await ensureInitialCandidate(main, screen?.signal)
  }
  const directory = workspace.directory ?? workspace.root
  const state = join(directory, '.strands/state')
  const localArgs: ParsedArgs = {
    ...args,
    dev: { ...args.dev!, workspace: directory },
    agent: workspace.entrypoint,
    envFiles: [...config.environmentFiles()],
    mcpConfig: args.mcpConfig.map((path) => resolve(process.cwd(), expandHome(path))),
    setup: false,
  }
  await config.setSettings({ mcpDiscovery: false, skillDiscovery: false, telemetry: false, updatePrompts: false })
  await config.useAgentProject(workspace.entrypoint)
  const label = sanitizeTerminalText(workspace.config.name)
  const entrypoint = sanitizeTerminalText(workspace.entrypoint)
  if (!screen) {
    process.stderr.write(
      `strands dev · ${label}\nWorkspace: ${sanitizeTerminalText(directory)}\nHarness: ${entrypoint} (${workspace.config.origin.kind})\nModel, tools, and instructions come from this workspace.\nInitial copy: ${sanitizeTerminalText(initial ?? 'Prepared after project setup')}\nState: ${sanitizeTerminalText(state)}\n`
    )
    if (args.dev?.init) process.stderr.write('Workspace ready. Run strands dev --workspace <path> to start it.\n')
  }
  if (
    !options.deferPreparation &&
    !args.dev?.init &&
    workspace.config.origin.kind !== 'discovered' &&
    (!workspace.directory || containsPath(workspace.directory, workspace.root))
  ) {
    if (screen) screen.show(undefined, 'Installing workspace dependencies…')
    else process.stderr.write('Preparing workspace dependencies...\n')
    await prepareWorkspaceDependencies(workspace.root, workspace.config.language)
  }
  screen?.signal.throwIfAborted()
  await readFile(workspace.entrypoint)
  return {
    args: localArgs,
    config,
    workspace,
    rejectedFolders: [...(avoided ?? [])],
    discard: claims.release,
  }
}
