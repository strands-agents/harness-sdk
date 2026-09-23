import { randomUUID } from 'node:crypto'
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  DEFAULT_HARNESS_AGENT_CONFIG,
  defineHarnessAgentConfig,
  type Effort,
  type HarnessAgentConfig,
  type HarnessConfigContextManager,
} from '@strands-agents/harness'
import { normalizeHarnessAgentConfig } from '@strands-agents/harness/internal'

import { DEFAULT_CHAT_SETTINGS, parseSettings, type ChatSettings } from './settings.js'
import { errorMessage } from './terminal/sanitize.js'
import {
  applyProviderEnvironmentValues,
  detectEnvironment,
  PROVIDER_ENVIRONMENT_KEYS,
  PROVIDER_CREDENTIAL_KEYS,
  type DetectedProviderEnvironment,
  type ProviderEnvironment,
  type ProviderEnvironmentKey,
} from './provider/environment.js'

export {
  applyProviderEnvironmentValues,
  PROVIDER_ENVIRONMENT_KEYS,
  PROVIDER_CREDENTIAL_KEYS,
  withAwsProfileRegion,
  type DetectedProviderEnvironment,
  type DetectedProviderEnvironmentValue,
  type ProviderEnvironment,
  type ProviderEnvironmentKey,
  type ProviderEnvironmentSource,
} from './provider/environment.js'

export type PermissionMode = 'default' | 'bypassPermissions'
export type ProviderId = 'bedrock' | 'bedrock-mantle' | 'anthropic' | 'openai' | 'google' | 'ollama' | 'litellm'
export type ProfileEffort = Effort
export type ProfileContextManager = HarnessConfigContextManager

export const SETUP_VERSION = 1

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  bedrock: 'Amazon Bedrock',
  'bedrock-mantle': 'Amazon Bedrock (Mantle)',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google Gemini',
  ollama: 'Ollama',
  litellm: 'LiteLLM',
}

export const PROVIDER_IDS: readonly ProviderId[] = Object.keys(PROVIDER_LABELS) as ProviderId[]

interface PermissionConfig {
  mode: PermissionMode
  allow: readonly string[]
}

export interface CliConfigSnapshot {
  path: string
  onboarding: { version: number }
  providers: { enabled: readonly ProviderId[] }
  profile: HarnessAgentConfig
  profileBaseDir?: string
  agentProject?: string
  permissions: PermissionConfig
  settings: ChatSettings
}

export interface SetupConfiguration {
  providers: readonly ProviderId[]
  profile: HarnessAgentConfig
  profileBaseDir?: string | null
  permissionMode: PermissionMode
  allowedTools?: readonly string[]
  providerEnvironment: ProviderEnvironment
  settings?: Partial<ChatSettings>
}

type ConfigDocument = Record<string, unknown>

/** Resolves a path under `~/.strands/cli`, the CLI's user-level config, state, and cache directory. */
export function userDirectory(...segments: string[]): string {
  return join(homedir(), '.strands', 'cli', ...segments)
}

export class CliConfigStore {
  private _profileBaseDir: string | undefined
  private _environmentFiles: readonly string[] = []
  private _sessionProviderEnvironment: ProviderEnvironment = {}
  private _writeQueue = Promise.resolve()

  private constructor(
    private readonly _path: string,
    private _document: ConfigDocument,
    private _onboardingVersion: number,
    private _providers: readonly ProviderId[],
    private _providerEnvironment: ProviderEnvironment,
    private _profile: HarnessAgentConfig,
    private _permissions: PermissionConfig,
    private _settings: ChatSettings,
    private readonly _persistent = true
  ) {
    this._profileBaseDir =
      _document.profileBaseDir === undefined
        ? undefined
        : requiredText(_document.profileBaseDir, `Invalid CLI config at ${_path}: profileBaseDir`)
  }

  static async load(path = userDirectory('config.json')): Promise<CliConfigStore> {
    const loadedDocument = await readConfigDocument(path)
    const document = withoutProviderCredentials(loadedDocument)
    const store = new CliConfigStore(
      path,
      document,
      parseOnboardingVersion(document.onboarding, path),
      parseProviders(document.providers, path),
      parseProviderEnvironment(document.providers, path),
      parseProfile(document.profile, path),
      parsePermissions(document.permissions, path),
      parseSettings(document.settings, path)
    )
    if (document !== loadedDocument) {
      await writeConfigDocument(path, document)
    }
    return store
  }

  static memory(
    permissions: Partial<PermissionConfig> = {},
    settings: Partial<ChatSettings> = {},
    setup: Partial<{
      onboardingVersion: number
      providers: readonly ProviderId[]
      providerEnvironment: ProviderEnvironment
      profile: Partial<HarnessAgentConfig>
      profileBaseDir: string
    }> = {}
  ): CliConfigStore {
    const onboardingVersion = setup.onboardingVersion ?? SETUP_VERSION
    const providers = uniqueProviders(setup.providers ?? ['bedrock'])
    const providerEnvironment = normalizeStoredProviderEnvironment(setup.providerEnvironment ?? {})
    const profile = defineHarnessAgentConfig(setup.profile ?? {})
    const resolvedPermissions = {
      mode: permissions.mode ?? 'default',
      allow: uniqueSorted((permissions.allow ?? []).map(normalizeToolName)),
    }
    const resolvedSettings = { ...DEFAULT_CHAT_SETTINGS, ...settings }
    return new CliConfigStore(
      'in-memory',
      {
        onboarding: { version: onboardingVersion },
        providers: { enabled: providers, environment: providerEnvironment },
        profile,
        profileBaseDir: setup.profileBaseDir,
        permissions: resolvedPermissions,
        settings: resolvedSettings,
      },
      onboardingVersion,
      providers,
      providerEnvironment,
      profile,
      resolvedPermissions,
      resolvedSettings,
      false
    )
  }

  snapshot(): CliConfigSnapshot {
    return {
      path: this._path,
      onboarding: { version: this._onboardingVersion },
      providers: { enabled: [...this._providers] },
      profile: globalThis.structuredClone(this._profile),
      ...(this._profileBaseDir ? { profileBaseDir: this._profileBaseDir } : {}),
      ...(typeof this._document.agentProject === 'string' ? { agentProject: this._document.agentProject } : {}),
      permissions: {
        mode: this._permissions.mode,
        allow: [...this._permissions.allow],
      },
      settings: globalThis.structuredClone(this._settings),
    }
  }

  needsSetup(): boolean {
    return this._onboardingVersion < SETUP_VERSION
  }

  async useAgentProject(entrypoint: string, settings: Partial<ChatSettings> = {}): Promise<void> {
    return this._enqueueWrite(async () => {
      const nextSettings = parseSettings({ ...this._settings, ...settings }, this._path)
      const document = {
        ...this._document,
        onboarding: { version: SETUP_VERSION },
        agentProject: entrypoint,
        settings: { ...(isRecord(this._document.settings) ? this._document.settings : {}), ...nextSettings },
      }
      if (this._persistent) {
        await writeConfigDocument(this._path, document)
      }
      this._document = document
      this._onboardingVersion = SETUP_VERSION
      this._settings = nextSettings
    })
  }

  providerEnvironment(): DetectedProviderEnvironment {
    const environment = detectEnvironment(
      this._environmentFiles,
      this._providerEnvironment,
      this._sessionProviderEnvironment
    )
    return Object.fromEntries(
      PROVIDER_ENVIRONMENT_KEYS.flatMap((key) => (environment[key] ? [[key, environment[key]]] : []))
    )
  }

  useEnvironmentFiles(paths: readonly string[], cwd = process.cwd()): void {
    this._environmentFiles = paths.map((path) => resolve(cwd, path))
    this.providerEnvironment()
  }

  environmentFiles(): readonly string[] {
    return [...this._environmentFiles]
  }

  configuredProviderEnvironment(): ProviderEnvironment {
    return { ...this._providerEnvironment }
  }

  setSessionProviderCredential(key: ProviderEnvironmentKey, value: string): void {
    if (!PROVIDER_CREDENTIAL_KEYS.includes(key)) {
      throw new Error(`${key} is not a provider credential`)
    }
    this._sessionProviderEnvironment = {
      ...this._sessionProviderEnvironment,
      [key]: requiredText(value, key),
    }
  }

  applyProviderEnvironment(): void {
    applyProviderEnvironmentValues(
      Object.fromEntries(
        Object.entries(
          detectEnvironment(this._environmentFiles, this._providerEnvironment, this._sessionProviderEnvironment)
        ).flatMap(([key, detected]) => (detected ? [[key, detected.value]] : []))
      )
    )
  }

  // `async` so validation failures reject the returned promise instead of throwing synchronously,
  // which the setup wizard's `.catch` could never observe (leaving it stuck in the saving state).
  async saveSetup(
    configuration: SetupConfiguration,
    options: { onboardingVersion?: number; agentProject?: string | undefined; persist?: boolean } = {}
  ): Promise<void> {
    const onboardingVersion = options.onboardingVersion ?? SETUP_VERSION
    const providers = uniqueProviders(configuration.providers)
    if (providers.length === 0) {
      throw new Error('At least one provider must be enabled.')
    }
    const profile = normalizeHarnessAgentConfig(configuration.profile)
    const profileBaseDir =
      configuration.profileBaseDir === undefined || configuration.profileBaseDir === null
        ? undefined
        : requiredText(configuration.profileBaseDir, 'profileBaseDir')
    const providerEnvironment = normalizeStoredProviderEnvironment(configuration.providerEnvironment)
    const allowedTools =
      configuration.allowedTools === undefined
        ? this._permissions.allow
        : uniqueSorted(configuration.allowedTools.map(normalizeToolName))
    return this._enqueueWrite(async () => {
      const priorOnboarding = isRecord(this._document.onboarding) ? this._document.onboarding : {}
      const priorProviders = isRecord(this._document.providers) ? this._document.providers : {}
      const priorProfile = isRecord(this._document.profile) ? this._document.profile : {}
      const priorPermissions = isRecord(this._document.permissions) ? this._document.permissions : {}
      const settings = parseSettings({ ...this._settings, ...configuration.settings }, this._path)
      const document = {
        ...this._document,
        agentProject: options.agentProject,
        onboarding: { ...priorOnboarding, version: onboardingVersion },
        providers: { ...priorProviders, enabled: [...providers], environment: providerEnvironment },
        profile: { ...priorProfile, ...globalThis.structuredClone(profile) },
        profileBaseDir: configuration.profileBaseDir === undefined ? this._profileBaseDir : profileBaseDir,
        permissions: { ...priorPermissions, mode: configuration.permissionMode, allow: [...allowedTools] },
        settings: { ...(isRecord(this._document.settings) ? this._document.settings : {}), ...settings },
      }
      if (this._persistent && options.persist !== false) {
        await writeConfigDocument(this._path, document)
      }
      this._document = document
      this._onboardingVersion = onboardingVersion
      this._providers = providers
      this._providerEnvironment = providerEnvironment
      this._profile = profile
      this._profileBaseDir = document.profileBaseDir
      this._permissions = { mode: configuration.permissionMode, allow: allowedTools }
      this._settings = settings
    })
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this._updatePermissions((permissions) => ({ ...permissions, mode }))
  }

  allowTool(toolName: string): Promise<void> {
    const normalized = normalizeToolName(toolName)
    return this._updatePermissions((permissions) => ({
      ...permissions,
      allow: uniqueSorted([...permissions.allow, normalized]),
    }))
  }

  removeAllowedTool(toolName: string): Promise<void> {
    const normalized = normalizeToolName(toolName)
    return this._updatePermissions((permissions) => ({
      ...permissions,
      allow: permissions.allow.filter((candidate) => candidate !== normalized),
    }))
  }

  setProfileModel(model: string, effort: ProfileEffort): Promise<void> {
    return this._enqueueWrite(async () => {
      const profile = normalizeHarnessAgentConfig({ ...this._profile, model, effort })
      const priorProfile = isRecord(this._document.profile) ? this._document.profile : {}
      const document = {
        ...this._document,
        profile: { ...priorProfile, model: profile.model, effort: profile.effort },
      }
      if (this._persistent) {
        await writeConfigDocument(this._path, document)
      }
      this._document = document
      this._profile = profile
    })
  }

  setSettings(settings: Partial<ChatSettings>): Promise<void> {
    const requested = globalThis.structuredClone(settings)
    return this._enqueueWrite(async () => {
      const next = parseSettings({ ...this._settings, ...requested }, this._path)
      const priorSettings = isRecord(this._document.settings) ? this._document.settings : {}
      const document = {
        ...this._document,
        settings: {
          ...priorSettings,
          ...next,
        },
      }
      if (this._persistent) {
        await writeConfigDocument(this._path, document)
      }
      this._document = document
      this._settings = next
    })
  }

  private _enqueueWrite(write: () => Promise<void>): Promise<void> {
    const operation = this._writeQueue.then(write)
    this._writeQueue = operation.catch(() => {})
    return operation
  }

  private _updatePermissions(update: (permissions: PermissionConfig) => PermissionConfig): Promise<void> {
    return this._enqueueWrite(async () => {
      const next = update(this._permissions)
      const priorPermissions = isRecord(this._document.permissions) ? this._document.permissions : {}
      const document = {
        ...this._document,
        permissions: {
          ...priorPermissions,
          mode: next.mode,
          allow: [...next.allow],
        },
      }
      if (this._persistent) {
        await writeConfigDocument(this._path, document)
      }
      this._document = document
      this._permissions = next
    })
  }
}

async function readConfigDocument(path: string): Promise<ConfigDocument> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {}
    }
    throw error
  }

  try {
    const value = JSON.parse(text) as unknown
    if (!isRecord(value)) {
      throw new Error('expected a JSON object')
    }
    return value
  } catch (error) {
    throw new Error(`Invalid CLI config at ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

function parseOnboardingVersion(value: unknown, path: string): number {
  if (value === undefined) {
    return 0
  }
  if (!isRecord(value) || !Number.isInteger(value.version) || (value.version as number) < 0) {
    throw new Error(`Invalid CLI config at ${path}: onboarding.version must be a non-negative integer`)
  }
  return value.version as number
}

function parseProviders(value: unknown, path: string): readonly ProviderId[] {
  if (value === undefined) {
    return ['bedrock']
  }
  if (!isRecord(value) || !Array.isArray(value.enabled)) {
    throw new Error(`Invalid CLI config at ${path}: providers.enabled must be an array`)
  }
  try {
    return uniqueProviders(value.enabled)
  } catch (error) {
    throw new Error(`Invalid CLI config at ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

function parseProviderEnvironment(value: unknown, path: string): ProviderEnvironment {
  if (!isRecord(value) || value.environment === undefined) {
    return {}
  }
  if (!isRecord(value.environment)) {
    throw new Error(`Invalid CLI config at ${path}: providers.environment must be an object`)
  }
  try {
    return normalizeStoredProviderEnvironment(value.environment)
  } catch (error) {
    throw new Error(`Invalid CLI config at ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

function parseProfile(value: unknown, path: string): HarnessAgentConfig {
  if (value === undefined) {
    return globalThis.structuredClone(DEFAULT_HARNESS_AGENT_CONFIG)
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid CLI config at ${path}: profile must be an object`)
  }
  try {
    return defineHarnessAgentConfig(value)
  } catch (error) {
    throw new Error(`Invalid CLI config at ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

function parsePermissions(value: unknown, path: string): PermissionConfig {
  if (value === undefined) {
    return { mode: 'default', allow: [] }
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid CLI config at ${path}: permissions must be an object`)
  }

  const mode = value.mode ?? 'default'
  if (mode !== 'default' && mode !== 'bypassPermissions') {
    throw new Error(`Invalid CLI config at ${path}: permissions.mode must be "default" or "bypassPermissions"`)
  }

  const allow = value.allow ?? []
  if (!Array.isArray(allow) || allow.some((toolName) => typeof toolName !== 'string')) {
    throw new Error(`Invalid CLI config at ${path}: permissions.allow must be an array of tool names`)
  }
  try {
    return { mode, allow: uniqueSorted(allow.map(normalizeToolName)) }
  } catch (error) {
    throw new Error(`Invalid CLI config at ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

async function writeConfigDocument(path: string, document: ConfigDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(withoutProviderCredentials(document), null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim()
  if (!normalized || normalized !== toolName || [...normalized].some(isControlCharacter)) {
    throw new Error('permissions.allow entries must be non-empty tool names without surrounding whitespace')
  }
  return normalized
}

function uniqueProviders(values: readonly unknown[]): ProviderId[] {
  if (values.some((value) => typeof value !== 'string' || !PROVIDER_IDS.includes(value as ProviderId))) {
    throw new Error(`providers.enabled contains an unsupported provider`)
  }
  return [...new Set(values as readonly ProviderId[])]
}

function normalizeStoredProviderEnvironment(value: Readonly<Record<string, unknown>>): ProviderEnvironment {
  const environment: ProviderEnvironment = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!PROVIDER_ENVIRONMENT_KEYS.includes(key as ProviderEnvironmentKey)) {
      throw new Error(`providers.environment contains unsupported key ${JSON.stringify(key)}`)
    }
    environment[key as ProviderEnvironmentKey] = requiredText(raw, `providers.environment.${key}`)
  }
  for (const key of PROVIDER_CREDENTIAL_KEYS) {
    delete environment[key]
  }
  return environment
}

function withoutProviderCredentials(document: ConfigDocument): ConfigDocument {
  if (!isRecord(document.providers) || !isRecord(document.providers.environment)) {
    return document
  }
  const environment = { ...document.providers.environment }
  let changed = false
  for (const key of PROVIDER_CREDENTIAL_KEYS) {
    if (key in environment) {
      delete environment[key]
      changed = true
    }
  }
  return changed
    ? {
        ...document,
        providers: {
          ...document.providers,
          environment,
        },
      }
    : document
}

function requiredText(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    [...value].some((character) => character !== '\n' && isControlCharacter(character))
  ) {
    throw new Error(`${field} must be text without control characters`)
  }
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${field} must not be empty`)
  }
  return normalized
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function isRecord(value: unknown): value is ConfigDocument {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
