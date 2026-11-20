import { mkdir, mkdtemp, readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import type { HarnessAgentConfig } from '@strands-agents/harness'

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
import { readWorkspaceBinding } from './binding.js'
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
  configWatch: { path: string; changed(): Promise<boolean> }
}

export const profileBaseCliChat = async (
  workspace: DevWorkspace,
  path = userConfigPath()
): Promise<ProfileBaseCliChat | undefined> => {
  if (!(await isProfileBaseCli(workspace, path))) return undefined
  return {
    saveAgentOptions: (change): Promise<boolean> => saveBaseCliChoices(workspace, change, path),
    configWatch: {
      path,
      changed: async (): Promise<boolean> => {
        await refreshBaseCliFromDisk(workspace, path)
        return false
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
