import { lstat, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { type ParsedArgs } from '../cli/arguments.js'
import { CliConfigStore } from '../config/store.js'
import { containsPath, expandHome } from '../paths.js'
import { importAgentProject } from '../project/import.js'
import { prepareWorkspaceDependencies } from '../project/archive.js'
import { sanitizeTerminalText } from '../terminal/text.js'
import { bindExistingAgent, createDevWorkspace } from './create.js'
import { discoverHarnesses } from './search.js'
import { readDevWorkspace, type DevWorkspace } from './workspace.js'
import type { StartupScreen } from '../ui/run.js'
import type { HarnessChoice } from './picker.js'
import { baseHarnessSelection, distinctHarnesses } from './selection.js'

export interface PreparedDevRun {
  args: ParsedArgs
  config: CliConfigStore
  workspace: DevWorkspace
}

const selectWorkspace = async (
  args: ParsedArgs,
  config: CliConfigStore,
  screen?: StartupScreen
): Promise<DevWorkspace | undefined> => {
  const dev = args.dev!
  const cwd = process.cwd()
  const destination = dev.workspace ? resolve(cwd, expandHome(dev.workspace)) : undefined
  if (dev.create)
    return createDevWorkspace({
      destination: destination ?? join('strands-dev', dev.create === 'cli' ? 'base-cli' : 'new-harness'),
      kind: dev.create,
      snapshot: config.snapshot(),
      cwd,
      ...(screen ? { signal: screen.signal } : {}),
    })
  if (args.agent) return openExplicitHarness(resolve(cwd, expandHome(args.agent)), destination)
  const existing =
    (await readDevWorkspace(destination ?? cwd)) ??
    (!destination ? await readDevWorkspace(join(cwd, 'strands-dev')) : undefined)
  if (existing) return existing
  if (destination && !dev.init)
    throw new Error(`No dev workspace at ${destination}. Run strands dev init --workspace <path> --create cli.`)
  if (!screen)
    throw new Error('Run strands dev init in a terminal, or select --workspace, --agent, or --create explicitly.')
  screen.show(undefined, 'Discovering local harnesses…')
  const discovery = await discoverHarnesses([cwd, ...dev.searchRoots.map((path) => resolve(cwd, expandHome(path)))])
  screen.signal.throwIfAborted()
  const base = await baseHarnessSelection(config.snapshot(), cwd, destination)
  const harnesses = await distinctHarnesses(discovery.harnesses, base.excludedEntrypoints)
  const { chooseHarness } = await import('./picker.js')
  const open = async (choice: HarnessChoice, signal: AbortSignal): Promise<DevWorkspace> => {
    signal.throwIfAborted()
    if (choice.kind === 'discovered') return openExplicitHarness(choice.harness.entrypoint, destination)
    const kind = choice.kind === 'cli' ? 'cli' : choice.language
    const name = choice.kind === 'cli' ? 'base-cli' : choice.name
    const snapshot = config.snapshot()
    if (choice.kind === 'create') snapshot.profile = { ...snapshot.profile, name: choice.name }
    return createDevWorkspace({
      destination: destination ?? join(cwd, 'strands-dev', name),
      kind,
      snapshot,
      cwd,
      signal,
    })
  }
  return chooseHarness(
    { cliName: base.name, cliPath: base.source, cliWorkspace: base.workspace, harnesses },
    screen,
    open
  )
}

const openExplicitHarness = async (path: string, directory?: string): Promise<DevWorkspace> => {
  const details = await lstat(path)
  if (details.isSymbolicLink()) throw new Error('Select a real harness path, not a symbolic link.')
  if (details.isDirectory()) {
    const existing = await readDevWorkspace(path)
    if (existing && !directory) return existing
  }
  const project = importAgentProject(path)
  if (directory) {
    const existing = await readDevWorkspace(directory)
    if (existing) {
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
  }
  const legacy = await readDevWorkspace(project.root)
  if (legacy && !directory)
    return {
      ...legacy,
      entrypoint: project.entrypoint,
      config: {
        ...legacy.config,
        language: project.language,
        entrypoint: relative(project.root, project.entrypoint).split(sep).join('/'),
      },
    }
  return bindExistingAgent(directory ?? join(project.root, 'strands-dev'), project.entrypoint)
}

export const prepareDevRun = async (
  args: ParsedArgs,
  options: { config?: CliConfigStore; screen?: StartupScreen } = {}
): Promise<PreparedDevRun | undefined> => {
  const { screen } = options
  const config = options.config ?? (await CliConfigStore.load(undefined, { persist: false }))
  config.useEnvironmentFiles(args.envFiles)
  screen?.signal.throwIfAborted()
  screen?.show(undefined, 'Preparing local workspace…')
  const workspace = await selectWorkspace(args, config, screen)
  screen?.signal.throwIfAborted()
  if (!workspace) return undefined
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
      `strands dev · ${label}\nWorkspace: ${sanitizeTerminalText(directory)}\nHarness: ${entrypoint} (${workspace.config.origin.kind})\nModel, tools, and instructions come from this workspace.\nState: ${sanitizeTerminalText(state)}\n`
    )
    if (args.dev?.init) process.stderr.write('Workspace ready. Run strands dev --workspace <path> to start it.\n')
  }
  if (
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
  return { args: localArgs, config, workspace }
}
