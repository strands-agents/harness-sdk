import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { CliConfigStore, userConfigPath, type CliConfigSnapshot } from '../config/store.js'
import type { ImportedAgentProject } from '../project/import.js'
import { saveAgentChoices } from './agent-choices.js'
import type { AgentOptions } from './agent-options.js'
import type { DevWorkspace } from './workspace.js'

const FINGERPRINT_PREFIX = 'profile-sha256:'
const FINGERPRINT_LENGTH = 16

export type BaseCliState =
  | { readonly kind: 'saved' }
  | { readonly kind: 'other'; readonly agent: string }
  | { readonly kind: 'current' }
  | { readonly kind: 'changed' }
  | { readonly kind: 'unknown' }

export interface BaseCliActions {
  state(): Promise<BaseCliState>
  save(): Promise<string>
}

type SavedChoices = { saveAgentOptions?: (change: AgentOptions) => Promise<boolean> }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null'
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
  return `{${entries.join(',')}}`
}

const samePath = (left: string, right: string): boolean => resolve(left) === resolve(right)

export const baseCliFingerprint = ({
  profile,
  profileBaseDir,
}: Pick<CliConfigSnapshot, 'profile' | 'profileBaseDir'>): string => {
  const digest = createHash('sha256').update(stableJson({ profile, profileBaseDir })).digest('hex')
  return `${FINGERPRINT_PREFIX}${digest.slice(0, FINGERPRINT_LENGTH)}`
}

type BaseCliWorkspace = Pick<DevWorkspace, 'entrypoint'> & { config: Pick<DevWorkspace['config'], 'origin'> }

export const baseCliState = async (workspace: BaseCliWorkspace, path = userConfigPath()): Promise<BaseCliState> => {
  const snapshot = (await CliConfigStore.load(path, { persist: false })).snapshot()
  if (snapshot.agentProject)
    return samePath(snapshot.agentProject, workspace.entrypoint)
      ? { kind: 'saved' }
      : { kind: 'other', agent: snapshot.agentProject }
  const made = workspace.config.origin.version
  if (!made?.startsWith(FINGERPRINT_PREFIX)) return { kind: 'unknown' }
  return made === baseCliFingerprint(snapshot) ? { kind: 'current' } : { kind: 'changed' }
}

export const saveToBaseCli = async (
  workspace: Pick<DevWorkspace, 'entrypoint'>,
  path = userConfigPath()
): Promise<string> => {
  await (await CliConfigStore.load(path)).setAgentProject(workspace.entrypoint)
  return path
}

export const baseCliActions = (workspace: DevWorkspace): { baseCli?: BaseCliActions } =>
  workspace.config.origin.kind === 'cli'
    ? { baseCli: { state: () => baseCliState(workspace), save: () => saveToBaseCli(workspace) } }
    : {}

export const savedProjectChoices = (config: CliConfigStore, project: ImportedAgentProject): SavedChoices => {
  const saved = config.snapshot().agentProject
  if (!saved || !samePath(saved, project.entrypoint)) return {}
  const workspace = { root: project.root, entrypoint: project.entrypoint, config: { language: project.language } }
  return { saveAgentOptions: (change: AgentOptions): Promise<boolean> => saveAgentChoices(workspace, change) }
}
