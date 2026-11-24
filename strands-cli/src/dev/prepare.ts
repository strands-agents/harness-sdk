import { realpathSync } from 'node:fs'
import { lstat, readFile, readdir, rmdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { type ParsedArgs } from '../cli/arguments.js'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'
import { CliConfigStore, type CliConfigSnapshot, type ConfigLayer } from '../config/store.js'
import { isProfileBaseCli, promoteBaseCliLook, refreshBaseCliView } from './base-cli.js'
import { containsPath, expandHome, strandsUserPath } from '../paths.js'
import { importAgentProject, type ImportedAgentProject } from '../project/import.js'
import { prepareWorkspaceDependencies } from '../project/archive.js'
import { planProjectPreparation } from '../project/preparation-plan.js'
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
  missingAgentPath,
  readDevWorkspace,
  readWorkspaceBinding,
  entrypointWorkspaceFolder,
  updateWorkspaceCli,
  workspaceFolder,
  WORKSPACE_FOLDER,
  type DevWorkspace,
} from './workspace.js'
import type { StartupScreen } from '../ui/run.js'
import type { FolderSuggestion, HarnessChoice } from './picker.js'
import { discoverHarnesses, type DiscoveredHarness } from './search.js'
import { initializeWorkspaceBinding } from './initialize.js'
import type { ProjectSetupSession } from './project-setup.js'

export interface PreparedDevRun {
  args: ParsedArgs
  config: CliConfigStore
  workspace: DevWorkspace
  discard(): Promise<void>
  keep(): Promise<void>
}

interface BaseHarnessSelection {
  name: string
  source: string
  workspace: string
  excludedEntrypoints: readonly string[]
  holds(workspace: DevWorkspace): boolean
}

const harnessFolder = (source: string, project: ImportedAgentProject): string =>
  dirname(/\.zip$/iu.test(source) ? resolve(expandHome(source)) : project.entrypoint)

export const baseHarnessSelection = async (
  snapshot: CliConfigSnapshot,
  cwd: string,
  destination?: string
): Promise<BaseHarnessSelection> => {
  const project = snapshot.agentProject
    ? importAgentProject(resolve(cwd, expandHome(snapshot.agentProject)))
    : undefined
  const source = project?.entrypoint ?? snapshot.path
  const workspace = destination ? resolve(cwd, destination) : strandsUserPath(WORKSPACE_FOLDER)
  const sameFile = (left: string, right: string): boolean =>
    canonicalPath(resolve(cwd, expandHome(left))) === canonicalPath(resolve(cwd, expandHome(right)))
  const madeFromThisCli = ({ config, entrypoint }: DevWorkspace): boolean => {
    const { source: origin } = config.origin
    if (origin === undefined) return true
    if (!snapshot.agentProject) return sameFile(origin, snapshot.path)
    return sameFile(entrypoint, source) || sameFile(origin, snapshot.agentProject)
  }
  const holds = (bound: DevWorkspace): boolean => bound.config.origin.kind === 'cli' && madeFromThisCli(bound)
  const bound = await readDevWorkspace(workspace).catch(async (failure: unknown) => {
    if ((await missingAgentPath(workspace, failure)) === undefined) throw failure
    return undefined
  })
  const existing = bound && holds(bound) ? bound : undefined
  return {
    name: existing?.config.name ?? snapshot.profile.name,
    source,
    workspace,
    excludedEntrypoints: [...(snapshot.agentProject ? [source] : []), ...(existing ? [existing.entrypoint] : [])],
    holds,
  }
}

const canonicalPath = (path: string): string => {
  const absolute = resolve(expandHome(path))
  try {
    return realpathSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
    throw error
  }
}

const withPreparationStatus = async (harness: DiscoveredHarness): Promise<DiscoveredHarness> => {
  try {
    const plan = await planProjectPreparation(harness)
    return { ...harness, preparationStatus: plan.manager === 'manual' ? 'Manual setup' : 'Needs setup' }
  } catch {
    return { ...harness, preparationStatus: 'Check setup' }
  }
}

const byEntrypoint = (left: DiscoveredHarness, right: DiscoveredHarness): number =>
  left.entrypoint < right.entrypoint ? -1 : left.entrypoint > right.entrypoint ? 1 : 0

export const discoverLocalHarnesses = async (
  cwd: string,
  searchRoots: readonly string[],
  excludedEntrypoints: readonly string[],
  search: { signal?: AbortSignal; found?(harness: DiscoveredHarness): void | Promise<void> } = {}
): Promise<{ harnesses: DiscoveredHarness[] }> => {
  const excluded = new Set(excludedEntrypoints.map(canonicalPath))
  const kept = new Map<string, DiscoveredHarness>()
  let reported = Promise.resolve()
  const report = (harness: DiscoveredHarness): void => {
    reported = reported.then(async () => {
      const path = canonicalPath(harness.entrypoint)
      const previous = kept.get(path)
      if (excluded.has(path) || (previous && (previous.workspace || !harness.workspace))) return
      const prepared = await withPreparationStatus(harness)
      kept.set(path, prepared)
      await search.found?.(prepared)
    })
  }
  const discovery = await discoverHarnesses([cwd, ...searchRoots.map((path) => resolve(cwd, expandHome(path)))], {
    ...(search.signal ? { signal: search.signal } : {}),
    found: report,
  })
  discovery.harnesses.forEach(report)
  await reported
  return { harnesses: [...kept.values()].sort(byEntrypoint) }
}

type Holds = (workspace: DevWorkspace, choice: HarnessChoice) => boolean

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

const workspaceSettings = (directory: string): ConfigLayer => ({
  source: join(directory, '.config'),
  read: async () => (await readWorkspaceBinding(directory))?.binding.cli,
  write: (sections) => updateWorkspaceCli(directory, sections),
})

const pickerUnavailable = (init: boolean): DevFailure =>
  new DevFailure(
    [
      init ? 'No harness selected.' : 'No dev workspace in this folder.',
      'Reason: The harness picker needs a terminal.',
      init
        ? 'Next: Pass --agent <path> for an existing agent, or --create <language> for a new one. The language is cli, typescript, or python.'
        : 'Next: Run strands dev init in a terminal, or pass --workspace <path>, --agent <path>, or --create <language>.',
    ].join('\n'),
    undefined
  )

const selectWorkspace = async (
  args: ParsedArgs,
  { snapshot, claims, screen, reselecting, warning, deferDependencies }: WorkspaceSelection
): Promise<DevWorkspace | undefined> => {
  const dev = args.dev!
  const cwd = process.cwd()
  const destination = dev.workspace ? await workspaceFolder(resolve(cwd, expandHome(dev.workspace))) : undefined
  const signal = screen?.signal
  if (dev.create) {
    const base = dev.create === 'cli' ? await baseHarnessSelection(snapshot, cwd, destination) : undefined
    const choice: HarnessChoice =
      dev.create === 'cli' ? { kind: 'cli' } : { kind: 'create', language: dev.create, name: snapshot.profile.name }
    const placement = { cwd, snapshot, claims, signal, deferDependencies, replace: false, holds: holdsChoiceFor(base) }
    const directory = destination ?? base?.workspace
    if (!directory) return createInLaunchFolder(choice, placement)
    return placeHarness(choice, { ...placement, directory: resolve(cwd, directory) })
  }
  if (args.agent) return openExplicitHarness(resolve(cwd, expandHome(args.agent)), { claims, folder: destination })
  const launch = reselecting ? undefined : await launchHolder(cwd, destination)
  if (launch && 'failure' in launch && !(dev.init && screen)) throw launch.failure
  if (launch && 'workspace' in launch) return launch.workspace
  if (destination && !dev.init && !reselecting)
    throw new Error(`No dev workspace at ${destination}. Run strands dev init --workspace <path> --create cli.`)
  if (!screen) throw pickerUnavailable(dev.init)
  const base = await baseHarnessSelection(snapshot, cwd, destination)
  const holds = holdsChoiceFor(base)
  const { suggestFor, ...folders } = await folderDefaults(base.workspace, { cwd, destination, holds })
  const excluded = base.excludedEntrypoints
  const notice = [
    warning,
    launch &&
      `${sanitizeTerminalText(launch.folder)} holds the workspace of ${launch.name}. Select an agent to replace it.`,
  ]
    .filter(Boolean)
    .join(' ')
  screen.signal.throwIfAborted()
  const { chooseHarness } = await import('./picker.js')
  return chooseHarness(
    {
      cli: { name: base.name, path: base.source },
      harnesses: [],
      ...(notice ? { warning: notice } : {}),
      modelNotice: (language) => newProjectModelNotice(snapshot, language),
      search: (found, signal) =>
        discoverLocalHarnesses(cwd, dev.searchRoots, excluded, {
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

type FolderHolder = { folder: string; name: string } & ({ workspace: DevWorkspace } | { failure: DevFailure })

const workspaceAgentMissing = (folder: string, agent: string, cause: unknown): DevFailure =>
  new DevFailure(
    [
      'Workspace agent not found.',
      `Folder: ${sanitizeTerminalText(folder)}`,
      `Agent: ${sanitizeTerminalText(agent)}`,
      'Reason: The .config file of this workspace names an agent that is missing.',
      'Next: Restore the agent, or run strands dev init in a terminal and select another agent. ' +
        'Dev asks you to type DELETE before it replaces this workspace.',
    ].join('\n'),
    cause
  )

const folderHolder = async (folder: string): Promise<FolderHolder | undefined> => {
  try {
    const workspace = await findDevWorkspace(folder)
    return workspace && { folder, name: holderOf(workspace), workspace }
  } catch (failure) {
    const missing = await missingAgentPath(folder, failure)
    if (missing === undefined) throw failure
    return {
      folder,
      name: `a missing agent (${sanitizeTerminalText(missing)})`,
      failure: workspaceAgentMissing(folder, missing, failure),
    }
  }
}

const launchHolder = async (cwd: string, destination: string | undefined): Promise<FolderHolder | undefined> =>
  destination ? folderHolder(destination) : ((await folderHolder(cwd)) ?? folderHolder(join(cwd, WORKSPACE_FOLDER)))

const folderSuggestion = async (path: string, holds: Holds): Promise<(choice: HarnessChoice) => FolderSuggestion> => {
  const holder = await folderHolder(path).catch(() => undefined)
  return (choice) => {
    if (!holder) return { path, detected: false }
    if ('workspace' in holder && holds(holder.workspace, choice)) return { path, detected: true }
    return { path, detected: false, occupiedBy: holder.name }
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
  | { kind: 'occupied'; holder: string }
  | { kind: 'files' }

const folderState = async (directory: string, choice: HarnessChoice, holds: Holds): Promise<FolderState> => {
  if (!(await folderEntries(directory)).length) return { kind: 'empty' }
  const holder = await folderHolder(directory)
  if (holder && 'workspace' in holder && holds(holder.workspace, choice))
    return { kind: 'held', workspace: holder.workspace }
  if (holder) return { kind: 'occupied', holder: holder.name }
  const legacy = choice.kind === 'cli' ? await readDevWorkspace(join(directory, 'base-cli')) : undefined
  return legacy ? { kind: 'legacy', workspace: legacy } : { kind: 'files' }
}

const freeOccupiedFolder = async (
  directory: string,
  holder: string,
  { claims, replace, project }: Pick<HarnessPlacement, 'claims' | 'replace'> & { project?: string }
): Promise<void> => {
  if (!replace) throw new WorkspaceFolderInUse(directory, holder)
  await claims.replace(directory, project && containsPath(project, directory) ? dirname(project) : undefined)
}

const generalPurposeSnapshot = (snapshot: CliConfigSnapshot, name: string): CliConfigSnapshot => {
  const { model, modelModule, effort, caching, dependencies } = snapshot.profile
  return {
    ...snapshot,
    profile: {
      ...globalThis.structuredClone(DEFAULT_HARNESS_AGENT_CONFIG),
      name,
      model,
      modelModule,
      effort,
      caching,
      dependencies,
      skills: false,
    },
  }
}

const createInFolder = async (
  choice: Exclude<HarnessChoice, { kind: 'discovered' }>,
  { directory, cwd, snapshot, claims, signal, deferDependencies }: HarnessPlacement
): Promise<DevWorkspace> => {
  await claims.claim(directory)
  return createDevWorkspace({
    destination: directory,
    kind: choice.kind === 'cli' ? 'cli' : choice.language,
    snapshot: choice.kind === 'create' ? generalPurposeSnapshot(snapshot, choice.name) : snapshot,
    ...(deferDependencies ? { deferDependencies: true } : {}),
    ...(signal ? { signal } : {}),
    cwd,
  })
}

const launchProjectState = async (root: string, choice: HarnessChoice, holds: Holds): Promise<FolderState> => {
  if (!(await folderEntries(root)).length) return { kind: 'empty' }
  const existing = await readDevWorkspace(join(root, WORKSPACE_FOLDER)).catch(() => undefined)
  if (existing?.root !== root) return { kind: 'files' }
  return holds(existing, choice)
    ? { kind: 'held', workspace: existing }
    : { kind: 'occupied', holder: holderOf(existing) }
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
  if (state.kind === 'occupied') await freeOccupiedFolder(root, state.holder, placement)
  else await removeEmptyFolder(root)
  const created = await createDevProject({
    language: choice.language,
    snapshot: generalPurposeSnapshot(snapshot, choice.name),
    cwd,
    ...(signal ? { signal } : {}),
    ...(deferDependencies ? { deferDependencies: true } : {}),
  })
  claims.claimCreated(created.root)
  return created
}

const placeHarness = async (choice: HarnessChoice, placement: HarnessPlacement): Promise<DevWorkspace> => {
  const { directory, claims, holds } = placement
  const state = await folderState(directory, choice, holds)
  if (state.kind === 'files') throw folderUnavailable(directory, 'The folder already contains files.')
  if (state.kind === 'legacy') return initializeWorkspaceBinding(state.workspace, directory)
  if (state.kind === 'held' && choice.kind !== 'discovered') return state.workspace
  const project = choice.kind === 'discovered' ? choice.harness.root : undefined
  if (state.kind === 'occupied')
    await freeOccupiedFolder(directory, state.holder, { ...placement, ...(project ? { project } : {}) })
  if (choice.kind === 'discovered')
    return openExplicitHarness(choice.harness.entrypoint, {
      claims,
      folder: directory,
      replace: placement.replace,
    })
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
  const holder = await folderHolder(directory)
  if (holder && 'failure' in holder) throw holder.failure
  if (holder?.workspace.root === project.root) return withEntrypoint(holder.workspace, project)
  if (holder) await freeOccupiedFolder(directory, holder.name, { claims, replace, project: project.root })
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
    if (await isProfileBaseCli(workspace)) await refreshBaseCliView(workspace, config.snapshot())
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
    await config.useLayer(undefined)
    await config.setSettings({ mcpDiscovery: false, skillDiscovery: false, telemetry: false, updatePrompts: false })
    await config.useAgentProject(workspace.entrypoint)
    if (workspace.directory) {
      const layer = workspaceSettings(workspace.directory)
      await config.useLayer(layer)
      // A look the Base CLI workspace still holds moves to cli.toml; when that fails, dev opens as before.
      const saved = config.snapshot().path
      if (saved !== 'in-memory' && (await isProfileBaseCli(workspace, saved)))
        await promoteBaseCliLook(config, await layer.read(), saved).catch(() => undefined)
    }
    const label = sanitizeTerminalText(workspace.config.name)
    const entrypoint = sanitizeTerminalText(workspace.entrypoint)
    if (!screen) {
      process.stderr.write(
        `strands dev · ${label}\nWorkspace: ${sanitizeTerminalText(directory)}\nHarness: ${entrypoint} (${workspace.config.origin.kind})\nModel, tools, and instructions come from this workspace.\nState: ${sanitizeTerminalText(state)}\n`
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

interface DevRunRequest {
  args: ParsedArgs
  savedConfig: CliConfigSnapshot
  launchDirectory: string
  screen: StartupScreen
  setup: ProjectSetupSession
  config: CliConfigStore
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
      config,
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

export const openWorkspaceConfiguration = async (args: ParsedArgs, screen: StartupScreen): Promise<void> => {
  if (!args.dev?.workspace) throw new Error('No dev workspace is active.')
  const workspace = await readDevWorkspace(args.dev.workspace)
  if (!workspace?.directory) throw new Error('Initialize this workspace with a .config binding before editing it.')
  if (!screen.openProject) throw new Error('Workspace editing is unavailable in this terminal.')
  await screen.openProject({ root: workspace.directory, entrypoint: join(workspace.directory, '.config') })
}
