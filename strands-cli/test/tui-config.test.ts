import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'

import { applyProviderEnvironmentValues, SETUP_VERSION, CliConfigStore } from '../src/tui/config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  applyProviderEnvironmentValues({})
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('CliConfigStore', () => {
  it.each(['aurora', 'moonlight', 'magma'])('loads the retired %s theme as Classic', async (frogTheme) => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(path, JSON.stringify({ settings: { frogTheme, animations: false } }))

    const config = await CliConfigStore.load(path)

    expect(config.snapshot().settings).toMatchObject({ frogTheme: 'green', animations: false })
  })

  it('uses safe defaults when the user config does not exist', async () => {
    const path = join(await temporaryDirectory(), 'config', 'config.json')

    const config = await CliConfigStore.load(path)

    expect(config.snapshot()).toEqual({
      path,
      onboarding: { version: 0 },
      providers: { enabled: ['bedrock'] },
      profile: DEFAULT_HARNESS_AGENT_CONFIG,
      permissions: { mode: 'default', allow: [] },
      models: { pinned: [] },
      settings: {
        transcriptSpacing: 'comfortable',
        animations: true,
        showReasoning: true,
        toolOutput: 'compact',
        frogTheme: 'green',
        colorMode: 'auto',
        customTheme: { base: 'green', light: {}, dark: {} },
        mcpDiscovery: false,
        skillDiscovery: false,
        agentMessaging: true,
        setupOnLaunch: true,
        telemetry: true,
      },
    })
    expect(config.needsSetup()).toBe(true)
  })

  it('persists permission mode and tool grants while preserving unrelated settings', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(
      path,
      JSON.stringify({
        theme: 'custom',
        permissions: { mode: 'default', allow: ['write'], futureSetting: true },
      })
    )
    const config = await CliConfigStore.load(path)

    await Promise.all([config.allowTool('bash'), config.allowTool('edit')])
    await config.removeAllowedTool('write')
    await config.setPermissionMode('bypassPermissions')

    expect(config.snapshot().permissions).toEqual({
      mode: 'bypassPermissions',
      allow: ['bash', 'edit'],
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'custom',
      permissions: {
        mode: 'bypassPermissions',
        allow: ['bash', 'edit'],
        futureSetting: true,
      },
    })
  })

  it('rejects malformed permission settings with the config path', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(path, JSON.stringify({ permissions: { mode: 'always', allow: 'bash' } }))

    await expect(CliConfigStore.load(path)).rejects.toThrow(
      `Invalid CLI config at ${path}: permissions.mode must be "default" or "bypassPermissions"`
    )
  })

  it('persists pinned models while preserving unrelated model settings', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(
      path,
      JSON.stringify({
        theme: 'custom',
        models: { pinned: ['bedrock/model-b'], futureSetting: true },
      })
    )
    const config = await CliConfigStore.load(path)

    await config.setModelPinned('bedrock/model-a', true)
    await config.setModelPinned('bedrock/model-b', false)

    expect(config.snapshot().models).toEqual({ pinned: ['bedrock/model-a'] })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'custom',
      models: {
        pinned: ['bedrock/model-a'],
        futureSetting: true,
      },
    })
  })

  it('persists presentation settings while preserving unrelated settings', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(
      path,
      JSON.stringify({
        theme: 'custom',
        settings: { animations: false, futureSetting: true },
      })
    )
    const config = await CliConfigStore.load(path)

    const settings = {
      ...config.snapshot().settings,
      transcriptSpacing: 'compact',
      toolOutput: 'full',
    }
    await config.setSettings({ transcriptSpacing: 'compact', toolOutput: 'full' })

    expect(config.snapshot().settings).toEqual(settings)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'custom',
      settings: { ...settings, futureSetting: true },
    })
  })

  it('persists the selected model and effort while preserving the rest of the profile', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(
      path,
      JSON.stringify({
        theme: 'custom',
        profile: { name: 'Custom Strands harness', model: 'bedrock/anthropic.claude-old', effort: 'medium' },
      })
    )
    const config = await CliConfigStore.load(path)

    await config.setProfileModel('anthropic/claude-opus-4-8', 'high')

    expect(config.snapshot().profile).toMatchObject({
      name: 'Custom Strands harness',
      model: 'anthropic/claude-opus-4-8',
      effort: 'high',
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'custom',
      profile: { name: 'Custom Strands harness', model: 'anthropic/claude-opus-4-8', effort: 'high' },
    })
  })

  it('rejects non-boolean discovery settings', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(path, JSON.stringify({ settings: { mcpDiscovery: 'yes' } }))

    await expect(CliConfigStore.load(path)).rejects.toThrow(
      `Invalid CLI config at ${path}: settings.mcpDiscovery must be a boolean`
    )
  })

  it('persists setup atomically while preserving unrelated settings', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(path, JSON.stringify({ theme: 'custom', profile: { futureSetting: true } }))
    const config = await CliConfigStore.load(path)
    const profile = {
      ...DEFAULT_HARNESS_AGENT_CONFIG,
      name: 'Reviewer',
      instructions: 'Review changes carefully.',
      model: 'openai/gpt-5.6-sol',
      builtinTools: ['read', 'web_search'] as const,
      skills: false,
      memory: false,
    }

    await config.saveSetup({
      providers: ['openai', 'anthropic'],
      profile,
      settings: { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false },
      permissionMode: 'bypassPermissions',
      allowedTools: ['shell', 'edit', 'shell'],
      providerEnvironment: {
        AWS_ACCESS_KEY_ID: 'credential-access-key',
        AWS_SECRET_ACCESS_KEY: 'credential-secret-key',
        AWS_SESSION_TOKEN: 'credential-session-token',
        AWS_BEARER_TOKEN_BEDROCK: 'credential-bedrock-token',
        ANTHROPIC_API_KEY: 'credential-anthropic-key',
        OPENAI_API_KEY: 'credential-openai-key',
        GEMINI_API_KEY: 'credential-gemini-key',
        LITELLM_API_KEY: 'credential-litellm-key',
        LITELLM_BASE_URL: 'http://localhost:4000',
      },
    })

    expect(config.needsSetup()).toBe(false)
    expect(config.snapshot()).toMatchObject({
      onboarding: { version: SETUP_VERSION },
      providers: { enabled: ['openai', 'anthropic'] },
      profile,
      permissions: { mode: 'bypassPermissions', allow: ['edit', 'shell'] },
      settings: { mcpDiscovery: false, skillDiscovery: false, agentMessaging: false },
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      theme: 'custom',
      providers: { environment: { LITELLM_BASE_URL: 'http://localhost:4000' } },
      profile: { futureSetting: true, name: 'Reviewer', model: 'openai/gpt-5.6-sol' },
    })
    expect(await readFile(path, 'utf8')).not.toContain('credential-')
    expect((await CliConfigStore.load(path)).snapshot().settings).toMatchObject({
      mcpDiscovery: false,
      skillDiscovery: false,
      agentMessaging: false,
      animations: true,
    })
    expect(config.configuredProviderEnvironment()).toEqual({ LITELLM_BASE_URL: 'http://localhost:4000' })
  })

  it('rejects invalid setup input through the promise instead of throwing synchronously', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(path, '{}')
    const config = await CliConfigStore.load(path)

    await expect(
      config.saveSetup({
        providers: [],
        profile: DEFAULT_HARNESS_AGENT_CONFIG,
        permissionMode: 'bypassPermissions',
        providerEnvironment: {},
      })
    ).rejects.toThrow('At least one provider must be enabled.')
  })

  it('reloads the imported project root and preserves it through manual profile edits', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'config.json')
    const config = await CliConfigStore.load(path)
    const setup = {
      providers: ['bedrock'] as const,
      profile: DEFAULT_HARNESS_AGENT_CONFIG,
      permissionMode: 'default' as const,
      providerEnvironment: {},
    }
    await config.saveSetup({ ...setup, profileBaseDir: directory })

    const reloaded = await CliConfigStore.load(path)
    expect(reloaded.snapshot().profileBaseDir).toBe(directory)
    await reloaded.saveSetup({ ...setup, profile: { ...setup.profile, instructions: 'Review carefully.' } })
    await reloaded.setProfileModel('bedrock/updated-model', 'low')

    const edited = await CliConfigStore.load(path)
    expect(edited.snapshot()).toMatchObject({
      profileBaseDir: directory,
      profile: { instructions: 'Review carefully.', model: 'bedrock/updated-model', effort: 'low' },
    })
    expect(edited.snapshot().profile).not.toHaveProperty('profileBaseDir')
  })

  it('detects project provider credentials after reload without persisting them', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'config.json')
    const config = await CliConfigStore.load(path)
    await config.saveSetup({
      providers: ['openai', 'anthropic'],
      profile: DEFAULT_HARNESS_AGENT_CONFIG,
      profileBaseDir: directory,
      permissionMode: 'default',
      providerEnvironment: {},
    })
    await writeFile(join(directory, '.env'), 'OPENAI_API_KEY=project-key\nANTHROPIC_API_KEY=project-key')
    await writeFile(join(directory, '.env.local'), 'ANTHROPIC_API_KEY=local-key')
    vi.stubEnv('OPENAI_API_KEY', 'process-key')
    vi.stubEnv('ANTHROPIC_API_KEY', undefined)

    const reloaded = await CliConfigStore.load(path)
    reloaded.useEnvironmentFiles([join(directory, '.env'), join(directory, '.env.local')])
    expect(reloaded.providerEnvironment()).toMatchObject({
      OPENAI_API_KEY: { value: 'process-key', source: 'process' },
      ANTHROPIC_API_KEY: { value: 'local-key', source: '.env.local' },
    })
    reloaded.applyProviderEnvironment()

    expect(process.env.OPENAI_API_KEY).toBe('process-key')
    expect(process.env.ANTHROPIC_API_KEY).toBe('local-key')
    expect(await readFile(path, 'utf8')).not.toMatch(/project-key|local-key|process-key/u)
  })

  it('clears an imported project root when setup explicitly supplies null', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'config.json')
    const config = await CliConfigStore.load(path)
    const setup = {
      providers: ['bedrock'] as const,
      profile: DEFAULT_HARNESS_AGENT_CONFIG,
      permissionMode: 'default' as const,
      providerEnvironment: {},
    }
    await config.saveSetup({ ...setup, profileBaseDir: directory })
    await config.saveSetup({ ...setup, profileBaseDir: null })

    expect(config.snapshot()).not.toHaveProperty('profileBaseDir')
    expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('profileBaseDir')
    const reloaded = await CliConfigStore.load(path)
    expect(reloaded.snapshot()).not.toHaveProperty('profileBaseDir')
    await reloaded.saveSetup(setup)
    expect((await CliConfigStore.load(path)).snapshot()).not.toHaveProperty('profileBaseDir')
  })

  it('removes credentials already stored in the CLI config', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    await writeFile(
      path,
      JSON.stringify({
        providers: {
          enabled: ['openai'],
          environment: {
            OPENAI_API_KEY: 'legacy-key',
            AWS_SESSION_TOKEN: 'legacy-token',
            AWS_PROFILE: 'development',
          },
        },
      })
    )

    const config = await CliConfigStore.load(path)

    expect(config.configuredProviderEnvironment()).toEqual({ AWS_PROFILE: 'development' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      providers: {
        environment: { AWS_PROFILE: 'development' },
      },
    })
    expect(await readFile(path, 'utf8')).not.toMatch(/legacy-(?:key|token)/u)
  })

  it('detects allowlisted provider settings without executing or expanding dotenv content', async () => {
    const directory = await temporaryDirectory()
    await writeFile(
      join(directory, '.env'),
      ['OLLAMA_HOST=http://dotenv:11434', 'OLLAMA_MODEL=${UNEXPANDED_MODEL}', 'UNRELATED_SECRET=ignored'].join('\n')
    )
    await writeFile(
      join(directory, '.env.local'),
      ['OLLAMA_HOST=http://local:11434', 'LITELLM_BASE_URL=http://local:4000'].join('\n')
    )
    vi.stubEnv('GEMINI_API_KEY', 'process-key')
    const config = CliConfigStore.memory({}, {}, {}, { providerEnvironment: { LITELLM_MODEL: 'stored-model' } })
    config.useEnvironmentFiles([join(directory, '.env'), join(directory, '.env.local')])

    expect(config.providerEnvironment()).toMatchObject({
      GEMINI_API_KEY: { value: 'process-key', source: 'process' },
      OLLAMA_HOST: { value: 'http://local:11434', source: '.env.local' },
      OLLAMA_MODEL: { value: '${UNEXPANDED_MODEL}', source: '.env' },
      LITELLM_BASE_URL: { value: 'http://local:4000', source: '.env.local' },
      LITELLM_MODEL: { value: 'stored-model', source: 'config' },
    })
    expect(config.providerEnvironment()).not.toHaveProperty('UNRELATED_SECRET')
  })

  it('does not expose or apply unconfigured provider values', () => {
    for (const key of ['LITELLM_BASE_URL', 'OPENAI_API_KEY', 'OLLAMA_HOST', 'GEMINI_API_KEY']) {
      vi.stubEnv(key, undefined)
    }
    const config = CliConfigStore.memory()
    expect(config.providerEnvironment()).not.toHaveProperty('LITELLM_BASE_URL')
    expect(config.providerEnvironment()).not.toHaveProperty('OPENAI_API_KEY')
    config.applyProviderEnvironment()
    expect(process.env.OLLAMA_HOST).toBeUndefined()
    expect(process.env.GEMINI_API_KEY).toBeUndefined()
  })

  it('applies a credential entered for this session without persisting it', async () => {
    const path = join(await temporaryDirectory(), 'config.json')
    vi.stubEnv('OPENAI_API_KEY', undefined)
    const config = await CliConfigStore.load(path)

    config.setSessionProviderCredential('OPENAI_API_KEY', 'session-key')
    expect(config.providerEnvironment().OPENAI_API_KEY).toEqual({ value: 'session-key', source: 'session' })
    config.applyProviderEnvironment()

    expect(process.env.OPENAI_API_KEY).toBe('session-key')
    await config.saveSetup({
      providers: ['openai'],
      profile: { ...DEFAULT_HARNESS_AGENT_CONFIG, model: 'openai/gpt-5.6-sol' },
      permissionMode: 'default',
      providerEnvironment: {},
    })
    expect(await readFile(path, 'utf8')).not.toContain('session-key')
  })

  it('refreshes selected env files without overwriting shell values or keeping deleted values', async () => {
    const path = join(await temporaryDirectory(), 'provider.env')
    vi.stubEnv('OPENAI_API_KEY', undefined)
    vi.stubEnv('ANTHROPIC_API_KEY', 'shell-key')
    await writeFile(path, 'OPENAI_API_KEY=first\nANTHROPIC_API_KEY=file-key')
    const config = CliConfigStore.memory()
    config.useEnvironmentFiles([path])
    config.applyProviderEnvironment()
    expect(process.env.OPENAI_API_KEY).toBe('first')
    await writeFile(path, 'OPENAI_API_KEY=second')
    expect(config.providerEnvironment().OPENAI_API_KEY).toEqual({ value: 'second', source: 'env-file' })
    config.applyProviderEnvironment()
    expect(process.env.OPENAI_API_KEY).toBe('second')
    expect(process.env.ANTHROPIC_API_KEY).toBe('shell-key')
    await writeFile(path, '')
    config.applyProviderEnvironment()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  it('resolves selected AWS config files before application and refreshes both file selectors', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'provider.env')
    const firstConfig = join(directory, 'first-config')
    const secondConfig = join(directory, 'second-config')
    const firstCredentials = join(directory, 'first-credentials')
    const secondCredentials = join(directory, 'second-credentials')
    await writeFile(firstConfig, '[profile review]\nregion=us-west-2\n')
    await writeFile(secondConfig, '[profile review]\nregion=eu-west-1\n')
    await writeFile(firstCredentials, '')
    await writeFile(secondCredentials, '')
    for (const key of [
      'AWS_CONFIG_FILE',
      'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_PROFILE',
      'AWS_REGION',
      'AWS_DEFAULT_REGION',
    ]) {
      vi.stubEnv(key, undefined)
    }
    const env = (config: string, credentials: string): string =>
      `AWS_CONFIG_FILE=${config}\nAWS_SHARED_CREDENTIALS_FILE=${credentials}\nAWS_PROFILE=review\n`
    await writeFile(path, env(firstConfig, firstCredentials))
    const config = CliConfigStore.memory()
    config.useEnvironmentFiles([path])
    expect(config.providerEnvironment().AWS_REGION?.value).toBe('us-west-2')
    expect(process.env.AWS_CONFIG_FILE).toBeUndefined()
    config.applyProviderEnvironment()
    await writeFile(path, env(secondConfig, secondCredentials))
    expect(config.providerEnvironment()).toMatchObject({
      AWS_CONFIG_FILE: { value: secondConfig, source: 'env-file' },
      AWS_SHARED_CREDENTIALS_FILE: { value: secondCredentials, source: 'env-file' },
      AWS_REGION: { value: 'eu-west-1', source: 'aws-profile' },
    })
    expect(process.env.AWS_CONFIG_FILE).toBe(firstConfig)
    config.applyProviderEnvironment()
    expect(process.env.AWS_CONFIG_FILE).toBe(secondConfig)
    expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toBe(secondCredentials)
    expect(process.env.AWS_REGION).toBe('eu-west-1')
    vi.stubEnv('AWS_CONFIG_FILE', firstConfig)
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', firstCredentials)
    expect(config.providerEnvironment()).toMatchObject({
      AWS_CONFIG_FILE: { value: firstConfig, source: 'process' },
      AWS_SHARED_CREDENTIALS_FILE: { value: firstCredentials, source: 'process' },
      AWS_REGION: { value: 'us-west-2', source: 'aws-profile' },
    })
    vi.stubEnv('AWS_DEFAULT_REGION', 'ap-northeast-1')
    expect(config.providerEnvironment().AWS_REGION).toBeUndefined()
  })

  it('loads arbitrary literal variable names without inheriting object properties', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'custom.env')
    for (const key of ['constructor', '__proto__']) vi.stubEnv(key, undefined)
    await writeFile(path, 'constructor=ctor-value\n__proto__=proto-value')
    const config = CliConfigStore.memory()
    config.useEnvironmentFiles([path])
    config.applyProviderEnvironment()
    expect(process.env.constructor).toBe('ctor-value')
    expect(process.env.__proto__).toBe('proto-value')
    await writeFile(path, '')
    config.applyProviderEnvironment()
    expect(Object.hasOwn(process.env, 'constructor')).toBe(false)
    expect(Object.hasOwn(process.env, '__proto__')).toBe(false)
    expect(() => config.useEnvironmentFiles([join(directory, 'missing')])).toThrow('Cannot load environment file')
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'strands-config-'))
  temporaryDirectories.push(directory)
  return directory
}
