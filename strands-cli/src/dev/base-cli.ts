import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { HarnessAgentConfig } from '@strands-agents/harness'

import { parseSettings, SETTING_DEFINITIONS, type ChatSettings, type SettingKey } from '../config/settings.js'
import { CliConfigStore, savedAgentProject, userConfigPath, type CliConfigSnapshot } from '../config/store.js'
import { containsPath } from '../paths.js'
import { writeAgentProject } from '../project/export.js'
import { importAgentProject } from '../project/import.js'
import { installProjectDependencies } from '../project/install.js'
import {
  AgentOptionsNotEditable,
  agentOptionDefault,
  editAgentOptions,
  type AgentOptionEdit,
  type AgentOptions,
} from './agent-options.js'
import { profileProject } from './create.js'
import type { DevWorkspace } from './workspace.js'
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

type ProfileValues = Record<string, unknown>

const isGeneratedView = (workspace: DevWorkspace): boolean =>
  workspace.directory !== undefined &&
  resolve(workspace.root) === resolve(workspace.directory, VIEW_FOLDER) &&
  VIEW_ENTRYPOINTS.has(relative(workspace.root, workspace.entrypoint).split(sep).join('/'))

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

export const refreshBaseCliView = async (workspace: DevWorkspace, snapshot: CliConfigSnapshot): Promise<boolean> => {
  const staging = await mkdtemp(join(dirname(workspace.root), '.base-cli-view-'))
  try {
    const input = await profileProject(snapshot, dirname(snapshot.path), workspace.config.language)
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

export const saveBaseCliChoices = async (
  workspace: DevWorkspace,
  change: AgentOptions,
  path = userConfigPath()
): Promise<boolean> => {
  const store = await CliConfigStore.load(path)
  await store.updateProfile((profile) => ({
    ...profile,
    ...(change.model !== undefined
      ? { model: change.model, modelModule: change.model === profile.model ? profile.modelModule : null }
      : {}),
    ...(change.effort !== undefined ? { effort: change.effort } : {}),
  }))
  await refreshBaseCliView(workspace, store.snapshot())
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

const refreshBaseCliFromDisk = async (workspace: DevWorkspace, path = userConfigPath()): Promise<boolean> =>
  refreshBaseCliView(workspace, (await CliConfigStore.load(path, { persist: false })).snapshot())

interface ProfileBaseCliChat {
  saveAgentOptions(change: AgentOptions): Promise<boolean>
  /** Saves a settings change of the dev chat, whose settings are `config`. */
  saveSettings(config: CliConfigStore, change: Partial<ChatSettings>): Promise<void>
  /** With `config`, the settings of the dev chat, `changed` also takes the look that cli.toml holds now into it. */
  configWatch: { path: string; changed(config?: CliConfigStore): Promise<boolean> }
}

/** The look of the CLI itself, which the Base CLI's dev workspace saves to cli.toml so plain strands matches. */
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

/** Saves a Base CLI dev chat's settings: the look goes to cli.toml, and the workspace keeps the rest. */
const saveBaseCliSettings = async (
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
const takeSavedBaseCliLook = async (config: CliConfigStore, path = userConfigPath()): Promise<void> =>
  config.adoptSavedSettings(lookOf((await CliConfigStore.load(path, { persist: false })).snapshot().settings))

/** Moves a look the Base CLI workspace still holds into cli.toml as dev opens, since it is what dev showed. */
export const promoteBaseCliLook = async (
  config: CliConfigStore,
  held: unknown,
  path = userConfigPath()
): Promise<void> => saveBaseCliSettings(config, lookOf(isRecord(held) ? held.settings : undefined), path)

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
      // True hot-reloads the dev chat; a save from dev itself already synced the view, so it changes nothing.
      changed: async (config): Promise<boolean> => {
        if (config) await takeSavedBaseCliLook(config, path)
        return refreshBaseCliFromDisk(workspace, path)
      },
    },
  }
}
