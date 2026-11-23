import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { HarnessAgentConfig } from '@strands-agents/harness'

import { parseSettings, SETTING_DEFINITIONS, type ChatSettings, type SettingKey } from '../config/settings.js'
import { CliConfigStore, savedAgentProject, userConfigPath, type CliConfigSnapshot } from '../config/store.js'
import { containsPath, strandsUserPath } from '../paths.js'
import { writeAgentProject } from '../project/export.js'
import { importAgentProject, type ImportedAgentProject } from '../project/import.js'
import { installProjectDependencies } from '../project/install.js'
import { saveAgentChoices } from './agent-choices.js'
import {
  AgentOptionsNotEditable,
  agentOptionDefault,
  editAgentOptions,
  type AgentOptionEdit,
  type AgentOptions,
} from './agent-options.js'
import { readWorkspaceBinding, updateWorkspaceCli } from './binding.js'
import { profileProject } from './create.js'
import { WORKSPACE_FOLDER, type DevWorkspace } from './workspace.js'
import { isRecord } from '../values.js'

const VIEW_KEPT = new Set(['node_modules', 'package-lock.json', '.agent', '.strands', 'dist', '.venv', '__pycache__'])
const VIEW_FOLDER = 'agent'
const VIEW_ENTRYPOINTS = new Set(['agent/agent.ts', 'agent/agent.py'])
const VIEW_MANIFEST = 'base-cli-view.json'
const DEPENDENCY_FILES = new Set(['package.json', 'requirements.txt', 'pyproject.toml'])
const PROFILE_OPTIONS = new Set([
  'model',
  'effort',
  'instructions',
  'caching',
  'contextManager',
  'builtinTools',
  'builtinPlugins',
  'mcpServers',
])

type SavedChoices = { saveAgentOptions?: (change: AgentOptions) => Promise<boolean> }
type ProfileValues = Record<string, unknown>

const samePath = (left: string, right: string): boolean => resolve(left) === resolve(right)

const portable = (path: string): string => path.split(sep).join('/')

const isGeneratedView = (workspace: DevWorkspace): boolean =>
  workspace.directory !== undefined &&
  samePath(workspace.root, join(workspace.directory, VIEW_FOLDER)) &&
  VIEW_ENTRYPOINTS.has(portable(relative(workspace.root, workspace.entrypoint)))

export const isProfileBaseCli = async (workspace: DevWorkspace, path = userConfigPath()): Promise<boolean> =>
  workspace.config.origin.kind === 'cli' && isGeneratedView(workspace) && (await savedAgentProject(path)) === undefined

const manifestPath = (workspace: DevWorkspace): string =>
  join(workspace.directory ?? workspace.root, '.strands', 'state', VIEW_MANIFEST)

const readManifest = async (workspace: DevWorkspace): Promise<ReadonlySet<string>> => {
  const text = await readFile(manifestPath(workspace), 'utf8').catch(() => undefined)
  const files: unknown = text === undefined ? [] : JSON.parse(text)
  return new Set(Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [])
}

const writeManifest = async (workspace: DevWorkspace, files: readonly string[]): Promise<void> => {
  await mkdir(dirname(manifestPath(workspace)), { recursive: true })
  await writeFile(manifestPath(workspace), `${JSON.stringify([...files].sort(), null, 2)}\n`)
}

const filesUnder = async (root: string, folder = root): Promise<string[]> => {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (folder === root && VIEW_KEPT.has(entry.name)) continue
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)))
    else files.push(relative(root, path))
  }
  return files
}

const removeEmptyFolders = async (root: string, folder: string): Promise<void> => {
  for (let current = folder; containsPath(root, current) && current !== root; current = dirname(current)) {
    const removed = await rmdir(current).then(
      () => true,
      () => false
    )
    if (!removed) return
  }
}

const syncView = async (
  source: string,
  target: string,
  previous: ReadonlySet<string>
): Promise<{ wanted: string[]; changed: string[] }> => {
  const wanted = await filesUnder(source)
  const changed: string[] = []
  for (const file of wanted) {
    const contents = await readFile(join(source, file))
    const current = await readFile(join(target, file)).catch(() => undefined)
    if (current?.equals(contents)) continue
    await mkdir(dirname(join(target, file)), { recursive: true })
    await writeFile(join(target, file), contents)
    changed.push(file)
  }
  const kept = new Set(wanted)
  for (const file of previous) {
    if (kept.has(file) || !containsPath(target, join(target, file))) continue
    await rm(join(target, file), { force: true })
    await removeEmptyFolders(target, dirname(join(target, file)))
    changed.push(file)
  }
  return { wanted, changed }
}

const profileFolder = (snapshot: CliConfigSnapshot): string => snapshot.profileBaseDir ?? dirname(snapshot.path)

export const refreshBaseCliView = async (workspace: DevWorkspace, snapshot: CliConfigSnapshot): Promise<boolean> => {
  const staging = await mkdtemp(join(dirname(workspace.root), '.base-cli-view-'))
  try {
    const input = await profileProject(snapshot, profileFolder(snapshot), workspace.config.language)
    const generated = join(staging, basename(workspace.root))
    await writeAgentProject(input.profile, input.language, input.skills, generated, input.baseDir, false, 'directory')
    const { wanted, changed } = await syncView(generated, workspace.root, await readManifest(workspace))
    await writeManifest(workspace, wanted)
    if (changed.some((file) => DEPENDENCY_FILES.has(file)))
      await installProjectDependencies(importAgentProject(workspace.root))
    return changed.length > 0
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const updateBaseCli = async (
  workspace: DevWorkspace,
  update: (profile: HarnessAgentConfig) => HarnessAgentConfig,
  path: string
): Promise<void> => {
  const store = await CliConfigStore.load(path)
  await store.updateProfile(update)
  await refreshBaseCliView(workspace, store.snapshot())
}

export const saveBaseCliChoices = async (
  workspace: DevWorkspace,
  change: AgentOptions,
  path = userConfigPath()
): Promise<boolean> => {
  await updateBaseCli(
    workspace,
    (profile) => ({
      ...profile,
      ...(change.model !== undefined
        ? { model: change.model, modelModule: change.model === profile.model ? profile.modelModule : null }
        : {}),
      ...(change.effort !== undefined ? { effort: change.effort } : {}),
    }),
    path
  )
  return true
}

const listNames = (option: string, value: unknown): string[] => {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  throw new AgentOptionsNotEditable(`${option} in the Base CLI profile is not a list of names.`)
}

export const baseCliEditProblem = (edit: AgentOptionEdit): string | undefined =>
  PROFILE_OPTIONS.has(edit.option)
    ? undefined
    : `${edit.option} cannot be changed in the Base CLI profile from strands dev.`

const applyEdit = (profile: ProfileValues, edit: AgentOptionEdit): ProfileValues => {
  const { option } = edit
  if ('value' in edit)
    return {
      ...profile,
      [option]: edit.value,
      ...(option === 'model' && edit.value !== profile.model ? { modelModule: null } : {}),
    }
  const current = profile[option] ?? agentOptionDefault(option)
  if ('removeKeys' in edit) {
    if (current === null || typeof current !== 'object' || Array.isArray(current))
      throw new AgentOptionsNotEditable(`${option} in the Base CLI profile is not a map of names.`)
    return {
      ...profile,
      [option]: Object.fromEntries(Object.entries(current).filter(([key]) => !edit.removeKeys.includes(key))),
    }
  }
  return {
    ...profile,
    [option]: listNames(option, current).filter((_item, index) => !edit.removeItems.includes(index)),
  }
}

export const editBaseCliProfile = async (
  workspace: DevWorkspace,
  edits: readonly AgentOptionEdit[],
  path = userConfigPath()
): Promise<boolean> => {
  const problem = edits.map(baseCliEditProblem).find(Boolean)
  if (problem) throw new AgentOptionsNotEditable(problem)
  await refreshBaseCliFromDisk(workspace, path)
  await editAgentOptions(workspace, edits)
  try {
    const store = await CliConfigStore.load(path)
    await store.updateProfile(
      (profile) => edits.reduce<ProfileValues>(applyEdit, { ...profile }) as unknown as HarnessAgentConfig
    )
  } finally {
    await refreshBaseCliFromDisk(workspace, path)
  }
  return true
}

export const refreshBaseCliFromDisk = async (workspace: DevWorkspace, path = userConfigPath()): Promise<boolean> =>
  refreshBaseCliView(workspace, (await CliConfigStore.load(path, { persist: false })).snapshot())

export interface ProfileBaseCliChat {
  saveAgentOptions(change: AgentOptions): Promise<boolean>
  /** Saves a settings change of the dev chat, whose settings are `config`. */
  saveSettings(config: CliConfigStore, change: Partial<ChatSettings>): Promise<void>
  /** With `config`, the settings of the dev chat, `changed` also takes the look that cli.toml holds now into it. */
  configWatch: { path: string; changed(config?: CliConfigStore): Promise<boolean> }
}

/**
 * The settings that are the look of the CLI itself. The Base CLI is the agent that plain strands runs, so its dev
 * workspace saves them to cli.toml and not to the workspace: dev and plain strands then look the same.
 */
export const BASE_CLI_LOOK: readonly SettingKey[] = SETTING_DEFINITIONS.filter(
  ({ section }) => section === 'Appearance'
).map(({ key }) => key)

/** The look in `saved`, without a value that is not one the setting can take. */
const lookOf = (saved: unknown): Partial<ChatSettings> => {
  if (!isRecord(saved)) return {}
  const valid = parseSettings(saved)
  return Object.fromEntries(
    BASE_CLI_LOOK.filter((key) => key in saved && isDeepStrictEqual(valid[key], saved[key])).map((key) => [
      key,
      valid[key],
    ])
  )
}

/**
 * Saves a settings change made in the dev chat of the Base CLI. The look goes to cli.toml, where an open plain strands
 * picks it up, and the workspace keeps the rest.
 */
export const saveBaseCliSettings = async (
  config: CliConfigStore,
  change: Partial<ChatSettings>,
  path = userConfigPath()
): Promise<void> => {
  const look = lookOf(change)
  if (Object.keys(look).length > 0) {
    await (await CliConfigStore.load(path)).setSettings(look)
    await config.adoptSavedSettings(look)
  }
  const rest = Object.fromEntries(Object.entries(change).filter(([key]) => !(key in look)))
  if (Object.keys(rest).length > 0) await config.setSettings(rest)
}

/** Takes the look that cli.toml holds now into the settings of the dev chat: plain strands, or a hand, changed it. */
export const takeSavedBaseCliLook = async (config: CliConfigStore, path = userConfigPath()): Promise<void> =>
  config.adoptSavedSettings(lookOf((await CliConfigStore.load(path, { persist: false })).snapshot().settings))

/**
 * Moves a look that the Base CLI workspace still holds into cli.toml, as dev opens it. An earlier strands dev saved it
 * there, and it is what dev showed, so it is the one to keep.
 */
export const promoteBaseCliLook = async (
  config: CliConfigStore,
  held: unknown,
  path = userConfigPath()
): Promise<void> => saveBaseCliSettings(config, lookOf(isRecord(held) ? held.settings : undefined), path)

/**
 * The same move as plain strands starts, so a theme picked in dev is the theme of the CLI before dev opens again.
 * `config` is the saved CLI config, and `directory` the workspace of the Base CLI.
 */
export const adoptBaseCliWorkspaceLook = async (
  config: CliConfigStore,
  directory = dirname(baseCliWorkspaceConfigPath())
): Promise<void> => {
  const bound = await readWorkspaceBinding(directory).catch(() => undefined)
  const cli = bound?.binding.cli
  if (bound?.binding.origin.kind !== 'cli' || !isRecord(cli) || !isRecord(cli.settings)) return
  const look = lookOf(cli.settings)
  if (Object.keys(look).length === 0) return
  await config.setSettings(look)
  const { settings, ...others } = cli
  const kept = Object.fromEntries(Object.entries(settings as object).filter(([key]) => !(key in look)))
  await updateWorkspaceCli(directory, { ...others, ...(Object.keys(kept).length > 0 ? { settings: kept } : {}) })
}

export const profileBaseCliChat = async (
  workspace: DevWorkspace,
  path = userConfigPath()
): Promise<ProfileBaseCliChat | undefined> => {
  if (!(await isProfileBaseCli(workspace, path))) return undefined
  return {
    saveAgentOptions: (change): Promise<boolean> => saveBaseCliChoices(workspace, change, path),
    saveSettings: (config, change): Promise<void> => saveBaseCliSettings(config, change, path),
    configWatch: {
      path,
      // True hot-reloads the dev chat, so a cli.toml edit lands like a source edit does. A save made
      // from dev itself already synced the view, so the watcher's refresh then changes nothing.
      changed: async (config): Promise<boolean> => {
        if (config) await takeSavedBaseCliLook(config, path)
        return refreshBaseCliFromDisk(workspace, path)
      },
    },
  }
}

export const savedProjectChoices = (config: CliConfigStore, project: ImportedAgentProject): SavedChoices => {
  const saved = config.snapshot().agentProject
  if (!saved || !samePath(saved, project.entrypoint)) return {}
  const workspace = { root: project.root, entrypoint: project.entrypoint, config: { language: project.language } }
  return { saveAgentOptions: (change: AgentOptions): Promise<boolean> => saveAgentChoices(workspace, change) }
}

/** The `.config` of the default Base CLI workspace, where dev saves its `/settings` changes. */
export const baseCliWorkspaceConfigPath = (): string => join(strandsUserPath(WORKSPACE_FOLDER), '.config')

/** Whether plain strands applies Base CLI profile changes to its open sessions; the dev workspace value wins. */
export const sessionModelSyncEnabled = async (snapshot: CliConfigSnapshot): Promise<boolean> => {
  const bound = await readWorkspaceBinding(dirname(baseCliWorkspaceConfigPath())).catch(() => undefined)
  const settings = bound?.binding.cli?.settings
  const saved = isRecord(settings) ? settings.sessionModelSync : undefined
  return typeof saved === 'boolean' ? saved : snapshot.settings.sessionModelSync
}
