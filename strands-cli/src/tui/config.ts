import { randomUUID } from 'node:crypto'
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import {
  DEFAULT_HARNESS_AGENT_CONFIG,
  defineHarnessAgentConfig,
  type Effort,
  type HarnessAgentConfig,
  type HarnessConfigContextManager,
} from '@strands-agents/harness'
import { normalizeHarnessAgentConfig } from '@strands-agents/harness/internal'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

import { DEFAULT_CHAT_SETTINGS, parseSettings, type ChatSettings } from './settings.js'
import { canonicalPermissionRule } from './permissions/rules.js'
import { errorMessage, isControlCharacter } from './terminal/sanitize.js'
import {
  applyProviderEnvironmentValues,
  detectEnvironment,
  PROVIDER_ENVIRONMENT_KEYS,
  PROVIDER_CREDENTIAL_KEYS,
  type DetectedProviderEnvironment,
  type ProviderEnvironment,
  type ProviderEnvironmentKey,
} from './provider/environment.js'
import { isRecord } from './values.js'
import { isMissingPathError, strandsUserPath } from './paths.js'

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
  deny: readonly string[]
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
type ConfigNullPath = (string | number)[]
const NULL_PATHS_KEY = '__strands_null_paths'

/** Resolves a path under `~/.strands/cli`, the CLI's internal state and cache directory. */
export function userDirectory(...segments: string[]): string {
  return strandsUserPath('cli', ...segments)
}

/** The user-editable CLI config file, `~/.strands/cli.toml`. */
export function userConfigPath(): string {
  return strandsUserPath('cli.toml')
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

  static async load(path = userConfigPath()): Promise<CliConfigStore> {
    const { document: loadedDocument, legacyPath } = await readConfigDocument(path)
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
    if (document !== loadedDocument || legacyPath) {
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
      deny: uniqueSorted((permissions.deny ?? []).map(normalizeToolName)),
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
        deny: [...this._permissions.deny],
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
      this._permissions = { ...this._permissions, mode: configuration.permissionMode, allow: allowedTools }
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

  denyTool(rule: string): Promise<void> {
    const normalized = normalizeToolName(rule)
    return this._updatePermissions((permissions) => ({
      ...permissions,
      deny: uniqueSorted([...permissions.deny, normalized]),
    }))
  }

  removeDeniedTool(rule: string): Promise<void> {
    const normalized = normalizeToolName(rule)
    return this._updatePermissions((permissions) => ({
      ...permissions,
      deny: permissions.deny.filter((candidate) => candidate !== normalized),
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
          deny: [...next.deny],
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

/** Imports a readable JSON config when TOML is absent, retaining the original file. */
async function readConfigDocument(path: string): Promise<{ document: ConfigDocument; legacyPath?: string }> {
  const text = await readOptionalFile(path)
  if (text !== undefined) {
    return { document: parseConfigText(path, () => restoreConfigNulls(parseToml(text))) }
  }
  if (basename(path) !== 'cli.toml') {
    return { document: {} }
  }
  const legacyPath = join(dirname(path), 'cli', 'config.json')
  const legacyText = await readOptionalFile(legacyPath)
  if (legacyText === undefined) {
    return { document: {} }
  }
  try {
    return { document: parseConfigText(legacyPath, () => JSON.parse(legacyText) as unknown), legacyPath }
  } catch {
    return { document: {} }
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined
    }
    throw error
  }
}

function parseConfigText(path: string, parse: () => unknown): ConfigDocument {
  try {
    const value = parse()
    if (!isRecord(value)) {
      throw new Error('expected a table of settings')
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
    return { mode: 'default', allow: [], deny: [] }
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid CLI config at ${path}: permissions must be an object`)
  }

  const mode = value.mode ?? 'default'
  if (mode !== 'default' && mode !== 'bypassPermissions') {
    throw new Error(`Invalid CLI config at ${path}: permissions.mode must be "default" or "bypassPermissions"`)
  }

  const rules = (field: 'allow' | 'deny'): string[] => {
    const entries = value[field] ?? []
    if (!Array.isArray(entries) || entries.some((rule) => typeof rule !== 'string')) {
      throw new Error(`Invalid CLI config at ${path}: permissions.${field} must be an array of permission rules`)
    }
    return entries as string[]
  }
  const allow = rules('allow')
  const deny = rules('deny')
  try {
    return { mode, allow: uniqueSorted(allow.map(normalizeToolName)), deny: uniqueSorted(deny.map(normalizeToolName)) }
  } catch (error) {
    throw new Error(`Invalid CLI config at ${path}: ${errorMessage(error)}`, { cause: error })
  }
}

async function writeConfigDocument(path: string, document: ConfigDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, stringifyToml(encodeConfigNulls(withoutProviderCredentials(document))), { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** TOML nulls use explicit paths; array slots keep an empty table so their indices remain stable. */
function encodeConfigNulls(document: ConfigDocument): ConfigDocument {
  if (Object.hasOwn(document, NULL_PATHS_KEY)) {
    throw new Error(`${NULL_PATHS_KEY} is reserved for CLI null-value metadata.`)
  }
  const paths: ConfigNullPath[] = []
  const encode = (value: unknown, path: ConfigNullPath): unknown => {
    if (value === null) {
      paths.push(path)
      return {}
    }
    if (Array.isArray(value)) return value.map((entry, index) => encode(entry, [...path, index]))
    if (!isRecord(value)) return value
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, entry]) => {
        const encoded = encode(entry, [...path, key])
        return entry === null || entry === undefined ? [] : [[key, encoded]]
      })
    )
  }
  const encoded = encode(document, []) as ConfigDocument
  return paths.length ? { [NULL_PATHS_KEY]: paths, ...encoded } : encoded
}

function restoreConfigNulls(document: ConfigDocument): ConfigDocument {
  if (!Object.hasOwn(document, NULL_PATHS_KEY)) return document
  const { [NULL_PATHS_KEY]: paths, ...restored } = document
  if (!Array.isArray(paths)) throw new Error(`${NULL_PATHS_KEY} must be an array of null paths.`)
  for (const path of paths) {
    if (!Array.isArray(path) || path.length === 0 || path[0] === NULL_PATHS_KEY) {
      throw new Error(`Invalid ${NULL_PATHS_KEY} path.`)
    }
    let parent: unknown = restored
    for (const [index, key] of path.entries()) {
      const array = Array.isArray(parent)
      if (
        !(Array.isArray(parent)
          ? typeof key === 'number' && Number.isSafeInteger(key) && key >= 0 && key < parent.length
          : isRecord(parent) && typeof key === 'string')
      ) {
        throw new Error(`Invalid ${NULL_PATHS_KEY} path: ${JSON.stringify(path)}.`)
      }
      const container = parent as object
      const value: unknown = Object.hasOwn(container, key) ? Reflect.get(container, key) : undefined
      if (index < path.length - 1) {
        parent = value
        continue
      }
      // A value edited directly in TOML takes precedence over its saved null metadata.
      if (value === undefined || (array && isRecord(value) && Object.keys(value).length === 0)) {
        Object.defineProperty(container, key, { value: null, enumerable: true, configurable: true, writable: true })
      }
    }
  }
  return restored
}

/** Validates a permission rule: a tool name, optionally scoped as `tool(pattern)`. */
export function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim()
  if (!normalized || normalized !== toolName || [...normalized].some(isControlCharacter)) {
    throw new Error('permission rules must be non-empty tool names or tool(pattern) without surrounding whitespace')
  }
  return canonicalPermissionRule(normalized)
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

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}
