import { lstat, readFile, readdir, rmdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { type ParsedArgs } from '../cli/arguments.js'
import { CliConfigStore, type CliConfigSnapshot } from '../config/store.js'
import { containsPath, expandHome } from '../paths.js'
import { importAgentProject, type ImportedAgentProject } from '../project/import.js'
import { prepareWorkspaceDependencies } from '../project/archive.js'
import { errorMessage, sanitizeTerminalText } from '../terminal/text.js'
import {
  bindExistingAgent,
  createDevProject,
  createDevWorkspace,
  folderClaims,
  newProjectModelNotice,
  projectFolder,
  type FolderClaims,
} from './create.js'
import { DevFailure, WorkspaceFolderInUse } from './errors.js'
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
import { baseHarnessSelection, discoverLocalHarnesses, harnessFolder, type BaseHarnessSelection } from './selection.js'
import { ensureInitialCandidate, initializeWorkspaceBinding } from './initialize.js'

export interface PreparedDevRun {
  args: ParsedArgs
  config: CliConfigStore
  workspace: DevWorkspace
  discard(): Promise<void>
  keep(): Promise<void>
}

type Holds = (workspace: DevWorkspace, choice: HarnessChoice) => boolean

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
  const base = kind === 'cli' ? await baseHarnessSelection(snapshot, cwd, destination) : undefined
  const choice: HarnessChoice =
    kind === 'cli' ? { kind: 'cli' } : { kind: 'create', language: kind, name: snapshot.profile.name }
  const placement = { cwd, snapshot, claims, signal, deferDependencies, replace: false, holds: holdsChoiceFor(base) }
  const directory = destination ?? base?.workspace
  if (!directory) return createInLaunchFolder(choice, placement)
  return placeHarness(choice, { ...placement, directory: resolve(cwd, directory) })
}

interface FolderDefaults {
  folderFor: (choice: HarnessChoice) => FolderSuggestion | undefined
  newProject?: string
  suggestFor(harness: DiscoveredHarness): Promise<void>
}

const folderDefaults = async (
  cliFolder: string,
  { cwd, destination, holds }: { cwd: string; destination: string | undefined; holds: Holds }
): Promise<FolderDefaults> => {
  if (destination)
    return {
      folderFor: await folderSuggestion(destination, holds),
      suggestFor: async (): Promise<void> => {},
    }
  const cli = await folderSuggestion(cliFolder, holds)
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
    newProject: projectFolder(cwd),
    suggestFor: async (harness): Promise<void> => {
      const choice = { kind: 'discovered', harness } as const
      const suggestion = await folderSuggestion(join(dirname(harness.entrypoint), WORKSPACE_FOLDER), holds)
      found.set(harness.entrypoint, suggestion(choice))
    },
  }
}

interface WorkspaceSelection {
  snapshot: CliConfigSnapshot
  claims: FolderClaims
  screen: StartupScreen | undefined
  reselecting: boolean
  warning: string | undefined
  deferDependencies: boolean
}

const selectWorkspace = async (
  args: ParsedArgs,
  { snapshot, claims, screen, reselecting, warning, deferDependencies }: WorkspaceSelection
): Promise<DevWorkspace | undefined> => {
  const dev = args.dev!
  const cwd = process.cwd()
  const destination = dev.workspace ? await workspaceFolder(resolve(cwd, expandHome(dev.workspace))) : undefined
  const signal = screen?.signal
  if (dev.create)
    return createRequested({ kind: dev.create, destination, cwd, snapshot, claims, signal, deferDependencies })
  if (args.agent) return openExplicitHarness(resolve(cwd, expandHome(args.agent)), { claims, folder: destination })
  const existing =
    (await findDevWorkspace(destination ?? cwd)) ??
    (!destination ? await readDevWorkspace(join(cwd, WORKSPACE_FOLDER)) : undefined)
  if (existing && !reselecting) return existing
  if (destination && !dev.init && !reselecting)
    throw new Error(`No dev workspace at ${destination}. Run strands dev init --workspace <path> --create cli.`)
  if (!screen)
    throw new Error('Run strands dev init in a terminal, or select --workspace, --agent, or --create explicitly.')
  const base = await baseHarnessSelection(snapshot, cwd, destination)
  const holds = holdsChoiceFor(base)
  const { suggestFor, ...folders } = await folderDefaults(base.workspace, { cwd, destination, holds })
  screen.signal.throwIfAborted()
  const { chooseHarness } = await import('./picker.js')
  return chooseHarness(
    {
      cli: { name: base.name, path: base.source },
      harnesses: [],
      ...(warning ? { warning } : {}),
      modelNotice: (language) => newProjectModelNotice(snapshot, language),
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
    async (choice, signal, chosen, replace = false): Promise<DevWorkspace> =>
      undoOnFailure(claims, async () => {
        signal.throwIfAborted()
        const placement = { cwd, snapshot, claims, signal, deferDependencies, replace, holds }
        const folder = chosen ?? folders.folderFor(choice)?.path
        if (folder === undefined) return createInLaunchFolder(choice, placement)
        const directory = await workspaceFolder(resolve(cwd, expandHome(folder)))
        const placed = await placeHarness(choice, { ...placement, directory })
        return placed.directory ? placed : initializeWorkspaceBinding(placed, directory)
      })
  )
}

interface HarnessPlacement {
  directory: string
  cwd: string
  snapshot: CliConfigSnapshot
  claims: FolderClaims
  signal: AbortSignal | undefined
  deferDependencies: boolean
  replace: boolean
  holds: Holds
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

const holderOf = ({ config, entrypoint }: DevWorkspace): string =>
  `${sanitizeTerminalText(config.name)} (${sanitizeTerminalText(entrypoint)})`

const folderSuggestion = async (path: string, holds: Holds): Promise<(choice: HarnessChoice) => FolderSuggestion> => {
  const existing = await readDevWorkspace(path).catch(() => undefined)
  return (choice) => {
    if (!existing) return { path, detected: false }
    return holds(existing, choice)
      ? { path, detected: true }
      : { path, detected: false, occupiedBy: holderOf(existing) }
  }
}

const holdsChoiceFor =
  (base: BaseHarnessSelection | undefined): Holds =>
  (workspace, choice) => {
    switch (choice.kind) {
      case 'discovered':
        return workspace.root === choice.harness.root
      case 'cli':
        return base?.holds(workspace) ?? false
      case 'create':
        return (
          workspace.config.origin.kind === 'created' &&
          workspace.config.name === choice.name &&
          workspace.config.language === choice.language
        )
    }
  }

type FolderState =
  | { kind: 'empty' }
  | { kind: 'held'; workspace: DevWorkspace }
  | { kind: 'legacy'; workspace: DevWorkspace }
  | { kind: 'occupied'; workspace: DevWorkspace }
  | { kind: 'files' }

const folderState = async (directory: string, choice: HarnessChoice, holds: Holds): Promise<FolderState> => {
  if (!(await folderEntries(directory)).length) return { kind: 'empty' }
  const existing = await readDevWorkspace(directory)
  if (existing) return { kind: holds(existing, choice) ? 'held' : 'occupied', workspace: existing }
  const legacy = choice.kind === 'cli' ? await readDevWorkspace(join(directory, 'base-cli')) : undefined
  return legacy ? { kind: 'legacy', workspace: legacy } : { kind: 'files' }
}

const freeOccupiedFolder = async (
  directory: string,
  occupant: DevWorkspace,
  { claims, replace, project }: Pick<HarnessPlacement, 'claims' | 'replace'> & { project?: string }
): Promise<void> => {
  if (!replace) throw new WorkspaceFolderInUse(directory, holderOf(occupant))
  await claims.replace(directory, project && containsPath(project, directory) ? dirname(project) : undefined)
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
    ...(signal ? { signal } : {}),
    cwd,
  })
}

const launchProjectState = async (root: string, choice: HarnessChoice, holds: Holds): Promise<FolderState> => {
  if (!(await folderEntries(root)).length) return { kind: 'empty' }
  const existing = await readDevWorkspace(join(root, WORKSPACE_FOLDER)).catch(() => undefined)
  if (existing?.root !== root) return { kind: 'files' }
  return { kind: holds(existing, choice) ? 'held' : 'occupied', workspace: existing }
}

const createInLaunchFolder = async (
  choice: HarnessChoice,
  placement: Omit<HarnessPlacement, 'directory'>
): Promise<DevWorkspace> => {
  if (choice.kind !== 'create') throw new Error('Choose a workspace folder for this harness.')
  const { cwd, snapshot, claims, signal, deferDependencies, holds } = placement
  const root = projectFolder(cwd)
  const state = await launchProjectState(root, choice, holds)
  if (state.kind === 'held' || state.kind === 'legacy') return state.workspace
  if (state.kind === 'files')
    throw folderUnavailable(root, 'The folder holds files that are not a strands dev project. Move or rename it first.')
  if (state.kind === 'occupied') await freeOccupiedFolder(root, state.workspace, placement)
  else await removeEmptyFolder(root)
  return createProject(claims, {
    language: choice.language,
    snapshot: withProfileName(snapshot, choice.name),
    cwd,
    ...(signal ? { signal } : {}),
    ...(deferDependencies ? { deferDependencies: true } : {}),
  })
}

const placeHarness = async (choice: HarnessChoice, placement: HarnessPlacement): Promise<DevWorkspace> => {
  const { directory, claims, holds } = placement
  const state = await folderState(directory, choice, holds)
  if (state.kind === 'files') throw folderUnavailable(directory, 'The folder already contains files.')
  if (state.kind === 'legacy') return initializeWorkspaceBinding(state.workspace, directory)
  if (state.kind === 'held' && choice.kind !== 'discovered') return state.workspace
  const project = choice.kind === 'discovered' ? choice.harness.root : undefined
  if (state.kind === 'occupied')
    await freeOccupiedFolder(directory, state.workspace, { ...placement, ...(project ? { project } : {}) })
  if (choice.kind === 'discovered')
    return openExplicitHarness(choice.harness.entrypoint, { claims, folder: directory, replace: placement.replace })
  return createInFolder(choice, placement)
}

const withEntrypoint = (existing: DevWorkspace, project: ImportedAgentProject): DevWorkspace => ({
  ...existing,
  entrypoint: project.entrypoint,
  config: {
    ...existing.config,
    language: project.language,
    entrypoint: relative(project.root, project.entrypoint).split(sep).join('/'),
  },
})

const openExplicitHarness = async (
  path: string,
  { claims, folder, replace = false }: { claims: FolderClaims; folder?: string | undefined; replace?: boolean }
): Promise<DevWorkspace> => {
  const details = await lstat(path)
  if (details.isSymbolicLink()) throw new Error('Select a real harness path, not a symbolic link.')
  const project = importAgentProject(path)
  const directory = folder ?? join(harnessFolder(path, project), WORKSPACE_FOLDER)
  const existing = await readDevWorkspace(directory)
  if (existing?.root === project.root) return withEntrypoint(existing, project)
  if (existing) await freeOccupiedFolder(directory, existing, { claims, replace, project: project.root })
  else if ((await folderEntries(directory)).length)
    throw folderUnavailable(directory, 'The folder already contains files.')
  await claims.claim(directory)
  return bindExistingAgent(directory, project.entrypoint)
}

const undoOnFailure = async <Result>(claims: FolderClaims, work: () => Promise<Result>): Promise<Result> => {
  try {
    return await work()
  } catch (error) {
    try {
      await claims.release()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], `${errorMessage(error)} ${errorMessage(cleanup)}`, { cause: cleanup })
    }
    throw error
  }
}

const removeEmptyFolder = async (path: string): Promise<void> => {
  try {
    await rmdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
  return undoOnFailure(claims, async () => {
    const selected = await selectWorkspace(args, {
      snapshot: options.savedConfig ?? config.snapshot(),
      claims,
      screen,
      reselecting: rejected !== undefined,
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
      discard: claims.release,
      keep: claims.commit,
    }
  })
}
