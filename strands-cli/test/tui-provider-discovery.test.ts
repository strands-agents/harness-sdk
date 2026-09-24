import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STSClient } from '@aws-sdk/client-sts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BedrockClient } from '@aws-sdk/client-bedrock'
import { applyProviderEnvironmentValues, CliConfigStore } from '../src/tui/config.js'
import { discoverAwsCredentials, discoverLiteLlm, discoverProviderModels } from '../src/tui/provider/discovery.js'

afterEach(() => {
  applyProviderEnvironmentValues({})
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('AWS credential refresh', () => {
  // https://github.com/strands-agents/harness-sdk/issues/4481
  // Model discovery must use the same default region as credential validation.
  it('defaults Bedrock model discovery to us-east-1 when no region is configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-aws-default-region-'))
    try {
      for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE']) {
        vi.stubEnv(key, undefined)
      }
      vi.stubEnv('AWS_CONFIG_FILE', join(directory, 'config'))
      vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(directory, 'credentials'))
      const regions: string[] = []
      vi.spyOn(BedrockClient.prototype, 'send').mockImplementation(async function (this: BedrockClient) {
        regions.push(await this.config.region())
        return { modelSummaries: [], inferenceProfileSummaries: [] }
      })

      const environment = CliConfigStore.memory().providerEnvironment()
      await expect(discoverProviderModels('bedrock', environment)).resolves.toMatchObject({ available: true })
      expect(regions).not.toHaveLength(0)
      expect(new Set(regions)).toEqual(new Set(['us-east-1']))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rereads changed profile credentials and updates the shared cache used by later clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-aws-refresh-'))
    const clients: STSClient[] = []
    try {
      vi.stubEnv('AWS_CONFIG_FILE', join(directory, 'config'))
      vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(directory, 'credentials'))
      vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
      vi.stubEnv('AWS_ACCESS_KEY_ID', undefined)
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined)
      vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', undefined)
      await writeFile(join(directory, 'config'), '')
      const credentials = (id: string): string =>
        `[review]\naws_access_key_id=${id}\naws_secret_access_key=fake-secret\n`
      await writeFile(join(directory, 'credentials'), credentials('OLD_FAKE_ID'))
      const initial = new STSClient({ region: 'us-east-1', profile: 'review' })
      clients.push(initial)
      expect((await initial.config.credentials()).accessKeyId).toBe('OLD_FAKE_ID')
      await writeFile(join(directory, 'credentials'), credentials('NEW_FAKE_ID'))
      expect((await initial.config.credentials({ forceRefresh: true })).accessKeyId).toBe('OLD_FAKE_ID')

      const seen: string[] = []
      vi.spyOn(STSClient.prototype, 'send').mockImplementation(async function (this: STSClient) {
        seen.push((await this.config.credentials()).accessKeyId)
        return {}
      })
      const environment = CliConfigStore.memory().providerEnvironment()
      environment.AWS_PROFILE = { value: 'review', source: 'process' }
      expect(await discoverAwsCredentials(environment)).toBe('valid')
      expect(seen).toEqual(['NEW_FAKE_ID'])
      const subsequent = new STSClient({ region: 'us-east-1', profile: 'review' })
      clients.push(subsequent)
      expect((await subsequent.config.credentials()).accessKeyId).toBe('NEW_FAKE_ID')
    } finally {
      for (const client of clients) client.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('uses selected AWS files for credential checks and both catalogs before applying process values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-aws-files-'))
    try {
      for (const key of [
        'AWS_CONFIG_FILE',
        'AWS_SHARED_CREDENTIALS_FILE',
        'AWS_PROFILE',
        'AWS_REGION',
        'AWS_DEFAULT_REGION',
        'AWS_BEARER_TOKEN_BEDROCK',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
      ]) {
        vi.stubEnv(key, undefined)
      }
      vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
      const envFile = join(directory, 'provider.env')
      const configFile = join(directory, 'config')
      const credentialsFile = join(directory, 'credentials')
      await writeFile(configFile, '[profile review]\nregion=eu-west-1\n')
      await writeFile(
        credentialsFile,
        '[review]\naws_access_key_id=SELECTED_FAKE_ID\naws_secret_access_key=fake-secret\n'
      )
      await writeFile(
        envFile,
        `AWS_CONFIG_FILE=${configFile}\nAWS_SHARED_CREDENTIALS_FILE=${credentialsFile}\nAWS_PROFILE=review`
      )
      const config = CliConfigStore.memory()
      config.useEnvironmentFiles([envFile])
      const environment = config.providerEnvironment()
      const identities: string[] = []
      vi.spyOn(STSClient.prototype, 'send').mockImplementation(async function (this: STSClient) {
        identities.push((await this.config.credentials()).accessKeyId)
        return {}
      })
      vi.spyOn(BedrockClient.prototype, 'send').mockImplementation(async function (this: BedrockClient) {
        identities.push((await this.config.credentials()).accessKeyId)
        expect(await this.config.region()).toBe('eu-west-1')
        return { modelSummaries: [], inferenceProfileSummaries: [] }
      })
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [] })))
      expect(await discoverAwsCredentials(environment)).toBe('valid')
      expect((await discoverProviderModels('bedrock', environment)).available).toBe(true)
      expect((await discoverProviderModels('bedrock-mantle', environment)).available).toBe(true)
      expect(identities.length).toBeGreaterThan(1)
      expect(identities.every((identity) => identity === 'SELECTED_FAKE_ID')).toBe(true)
      expect(fetch.mock.calls[0]?.[0]).toBe('https://bedrock-mantle.eu-west-1.api.aws/v1/models')
      expect(process.env.AWS_CONFIG_FILE).toBeUndefined()
      expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('LiteLLM proxy discovery', () => {
  it('detects models from the default local proxy without configuration', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new globalThis.Response(JSON.stringify({ data: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }] })))

    await expect(discoverLiteLlm({})).resolves.toEqual({
      reachable: true,
      authenticationRequired: false,
      models: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
      status: 200,
    })
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4000/v1/models')
  })

  it.each([401, 403])('requests a key when the proxy returns %s', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response(null, { status }))

    await expect(discoverLiteLlm({})).resolves.toEqual({
      reachable: true,
      authenticationRequired: true,
      models: [],
      status,
    })
  })

  it('uses configured remote proxy credentials when provided', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new globalThis.Response(JSON.stringify({ data: [{ id: 'anthropic/claude-sonnet', name: 'Sonnet' }] }))
      )

    await discoverLiteLlm({
      LITELLM_BASE_URL: { value: 'https://proxy.example/v1/', source: 'process' },
      LITELLM_API_KEY: { value: 'proxy-key', source: 'process' },
    })

    expect(fetch.mock.calls[0]?.[0]).toBe('https://proxy.example/v1/models')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer proxy-key' },
    })
  })

  it('reports an unavailable proxy without treating the URL as missing configuration', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'))

    await expect(discoverLiteLlm({})).resolves.toEqual({
      reachable: false,
      authenticationRequired: false,
      models: [],
    })
  })
})

describe('provider model discovery errors', () => {
  it('retains the HTTP failure reason without exposing credential values', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new globalThis.Response('', { status: 401 }))

    await expect(
      discoverProviderModels('openai', {
        OPENAI_API_KEY: { value: 'secret-test-key', source: 'session' },
      })
    ).resolves.toEqual({
      models: [],
      available: false,
      error: 'API key was rejected (HTTP 401)',
      credentialRejected: true,
    })
  })
})
