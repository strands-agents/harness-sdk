import { lstat, readFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { type ParsedArgs } from '../cli/arguments.js'
import { CliConfigStore } from '../config/store.js'
import { expandHome } from '../paths.js'
import { importAgentProject } from '../project/import.js'
import { prepareWorkspaceDependencies } from '../project/archive.js'
import { sanitizeTerminalText } from '../terminal/text.js'
import { createDevWorkspace } from './create.js'
import { discoverHarnesses } from './search.js'
import { initializeDevWorkspace, readDevWorkspace, type DevWorkspace } from './workspace.js'

export interface PreparedDevRun {
  args: ParsedArgs
  config: CliConfigStore
  workspace: DevWorkspace
}

const selectWorkspace = async (args: ParsedArgs, config: CliConfigStore): Promise<DevWorkspace | undefined> => {
  const dev = args.dev!
  const cwd = process.cwd()
  const destination = dev.workspace ? resolve(cwd, expandHome(dev.workspace)) : undefined
  if (dev.create)
    return createDevWorkspace({
      destination: destination ?? join('strands-dev', dev.create === 'cli' ? 'base-cli' : 'new-harness'),
      kind: dev.create,
      snapshot: config.snapshot(),
      cwd,
    })
  if (args.agent) return openExplicitHarness(resolve(cwd, expandHome(args.agent)), destination)
  const existing = await readDevWorkspace(destination ?? cwd)
  if (existing) return existing
  if (destination && !dev.init)
    throw new Error(`No dev workspace at ${destination}. Run strands dev init --workspace <path> --create cli.`)
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Run strands dev init in a terminal, or select --workspace, --agent, or --create explicitly.')
  const discovery = await discoverHarnesses([cwd, ...dev.searchRoots.map((path) => resolve(cwd, expandHome(path)))])
  for (const warning of discovery.warnings) process.stderr.write(`warning: ${sanitizeTerminalText(warning)}\n`)
  const { chooseHarness } = await import('./picker.js')
  const choice = await chooseHarness({ cliName: config.snapshot().profile.name, harnesses: discovery.harnesses })
  if (!choice) return undefined
  if (choice.kind === 'discovered') return openExplicitHarness(choice.harness.entrypoint, destination)
  const kind = choice.kind === 'cli' ? 'cli' : choice.language
  const name = choice.kind === 'cli' ? 'base-cli' : choice.name
  const snapshot = config.snapshot()
  if (choice.kind === 'create') snapshot.profile = { ...snapshot.profile, name: choice.name }
  return createDevWorkspace({ destination: destination ?? join(cwd, 'strands-dev', name), kind, snapshot, cwd })
}

const openExplicitHarness = async (path: string, root?: string): Promise<DevWorkspace> => {
  const details = await lstat(path)
  if (details.isSymbolicLink()) throw new Error('Select a real harness path, not a symbolic link.')
  if (details.isDirectory()) {
    const workspace = await readDevWorkspace(path)
    if (workspace) return workspace
  }
  const project = importAgentProject(path)
  if (root && resolve(root) !== resolve(project.root))
    throw new Error(
      'The explicit harness must belong to the selected workspace. Use --agent without --workspace to initialize its project.'
    )
  const existing = await readDevWorkspace(project.root)
  if (existing) {
    if (project.entrypoint === existing.entrypoint) return existing
    return {
      ...existing,
      entrypoint: project.entrypoint,
      config: {
        ...existing.config,
        language: project.language,
        entrypoint: relative(existing.root, project.entrypoint).split(sep).join('/'),
      },
    }
  }
  return initializeDevWorkspace(project.root, {
    version: 1,
    name: basename(project.root),
    language: project.language,
    entrypoint: relative(project.root, project.entrypoint).split(sep).join('/'),
    origin: { kind: 'discovered', source: project.entrypoint },
  })
}

export const prepareDevRun = async (args: ParsedArgs): Promise<PreparedDevRun | undefined> => {
  const config = await CliConfigStore.load(undefined, { persist: false })
  config.useEnvironmentFiles(args.envFiles)
  const workspace = await selectWorkspace(args, config)
  if (!workspace) return undefined
  const state = join(workspace.root, '.strands/state')
  const localArgs: ParsedArgs = {
    ...args,
    dev: { ...args.dev!, workspace: workspace.root },
    agent: workspace.entrypoint,
    envFiles: [...config.environmentFiles()],
    mcpConfig: args.mcpConfig.map((path) => resolve(process.cwd(), expandHome(path))),
    setup: false,
  }
  await config.setSettings({ mcpDiscovery: false, skillDiscovery: false, telemetry: false, updatePrompts: false })
  await config.useAgentProject(workspace.entrypoint)
  const label = sanitizeTerminalText(workspace.config.name)
  const entrypoint = sanitizeTerminalText(workspace.entrypoint)
  process.stderr.write(
    `strands dev · ${label}\nWorkspace: ${sanitizeTerminalText(workspace.root)}\nHarness: ${entrypoint} (${workspace.config.origin.kind})\nModel, tools, and instructions come from this workspace, not the saved CLI profile.\nState: ${sanitizeTerminalText(state)}\n`
  )
  if (args.dev?.init) process.stderr.write('Workspace ready. Run strands dev --workspace <path> to start it.\n')
  if (!args.dev?.init && workspace.config.origin.kind !== 'discovered') {
    process.stderr.write('Preparing workspace dependencies...\n')
    await prepareWorkspaceDependencies(workspace.root, workspace.config.language)
  }
  await readFile(workspace.entrypoint)
  return { args: localArgs, config, workspace }
}
