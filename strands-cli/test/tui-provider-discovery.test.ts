import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STSClient } from '@aws-sdk/client-sts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock'
import { applyProviderEnvironmentValues, CliConfigStore } from '../src/tui/config.js'
import { discoverAwsCredentials, discoverLiteLlm, discoverProviderModels } from '../src/tui/provider/discovery.js'

afterEach(() => {
  applyProviderEnvironmentValues({})
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('AWS credential refresh', () => {
  it('uses us-east-1 for credential checks and Bedrock discovery when no region is configured', async () => {
    vi.spyOn(STSClient.prototype, 'send').mockImplementation(async function (this: STSClient) {
      expect(await this.config.region()).toBe('us-east-1')
      return {}
    })
    vi.spyOn(BedrockClient.prototype, 'send').mockImplementation(async function (this: BedrockClient) {
      expect(await this.config.region()).toBe('us-east-1')
      return { modelSummaries: [], inferenceProfileSummaries: [] }
    })

    await expect(discoverAwsCredentials({})).resolves.toBe('valid')
    await expect(discoverProviderModels('bedrock', {})).resolves.toMatchObject({
      models: [],
      available: true,
    })
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

describe('Bedrock model capability filtering', () => {
  const runnableModelIds = [
    'amazon.nova-lite-v1:0',
    'anthropic.claude-current-v1:0',
    'google.gemma-3-27b-it',
    'mistral.devstral-2-123b',
    'openai.gpt-oss-120b-1:0',
    'qwen.qwen3-32b-v1:0',
    'us.anthropic.claude-current-v1:0',
  ]

  it('lists only models that support chat with streaming tool use', async () => {
    vi.spyOn(BedrockClient.prototype, 'send').mockImplementation(async (command) => {
      if (command instanceof ListInferenceProfilesCommand) {
        return {
          inferenceProfileSummaries: [
            inferenceProfile('us.anthropic.claude-current-v1:0', 'anthropic.claude-current-v1:0'),
            inferenceProfile('us.meta.llama3-8b-instruct-v1:0', 'meta.llama3-8b-instruct-v1:0'),
          ],
        }
      }
      if (command instanceof ListFoundationModelsCommand) {
        return {
          modelSummaries: [
            bedrockFoundationModel('anthropic.claude-current-v1:0'),
            bedrockFoundationModel('amazon.nova-lite-v1:0'),
            bedrockFoundationModel('openai.gpt-oss-120b-1:0'),
            bedrockFoundationModel('qwen.qwen3-32b-v1:0'),
            bedrockFoundationModel('mistral.devstral-2-123b'),
            bedrockFoundationModel('google.gemma-3-27b-it'),
            bedrockFoundationModel('meta.llama3-8b-instruct-v1:0'),
            bedrockFoundationModel('meta.llama4-scout-17b-instruct-v1:0'),
            bedrockFoundationModel('mistral.mistral-7b-instruct-v0:2'),
            bedrockFoundationModel('mistral.mistral-large-2402-v1:0'),
            bedrockFoundationModel('mistral.mixtral-8x7b-instruct-v0:1'),
            bedrockFoundationModel('deepseek.r1-v1:0'),
            bedrockFoundationModel('writer.palmyra-vision-7b'),
            bedrockFoundationModel('amazon.titan-text-premier-v1:0'),
            bedrockFoundationModel('cohere.command-text-v14'),
            bedrockFoundationModel('anthropic.claude-v2:1'),
            bedrockFoundationModel('anthropic.claude-instant-v1'),
            bedrockFoundationModel('amazon.nova-2-sonic-v1:0'),
            bedrockFoundationModel('amazon.nova-2-5-sonic'),
            bedrockFoundationModel('twelvelabs.pegasus-1-5-v1:0'),
          ],
        }
      }
      return {}
    })

    const discovery = await discoverProviderModels('bedrock', {})

    expect(discovery.available).toBe(true)
    expect(discovery.models.map((model) => model.id).sort()).toEqual(runnableModelIds)
  })
})

describe('Bedrock Mantle model capability filtering', () => {
  const responsesApiModelIds = [
    'google.gemma-4-31b',
    'openai.gpt-5.4',
    'openai.gpt-5.4-2026-03-05',
    'openai.gpt-5.6-sol',
    'openai.gpt-6-astra',
    'openai.gpt-6.1-sol',
    'openai.gpt-oss-120b',
    'openai.gpt-oss-20b',
    'xai.grok-4.3',
  ]

  it('lists only models that accept the Responses API', async () => {
    const listedModelIds = [
      ...responsesApiModelIds,
      'anthropic.claude-haiku-4-5',
      'deepseek.v3.2',
      'google.gemma-3-27b-it',
      'minimax.minimax-m2',
      'mistral.mistral-large-3-675b-instruct',
      'openai.gpt-oss-safeguard-20b',
      'qwen.qwen3-32b',
      'writer.palmyra-vision-7b',
      'zai.glm-5',
    ]
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new globalThis.Response(JSON.stringify({ data: listedModelIds.map((id) => ({ id })) })))

    const discovery = await discoverProviderModels('bedrock-mantle', {
      AWS_REGION: { value: 'us-east-1', source: 'process' },
      AWS_BEARER_TOKEN_BEDROCK: { value: 'test-token', source: 'process' },
    })

    expect(fetch.mock.calls[0]?.[0]).toBe('https://bedrock-mantle.us-east-1.api.aws/v1/models')
    expect(discovery.available).toBe(true)
    expect(discovery.models.map((model) => model.id).sort()).toEqual(responsesApiModelIds)
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

function bedrockFoundationModel(modelId: string): {
  modelId: string
  modelName: string
  modelLifecycle: { status: 'ACTIVE' }
  outputModalities: ['TEXT']
  responseStreamingSupported: true
  inferenceTypesSupported: ['ON_DEMAND']
} {
  return {
    modelId,
    modelName: modelId,
    modelLifecycle: { status: 'ACTIVE' },
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['ON_DEMAND'],
  }
}

function inferenceProfile(
  inferenceProfileId: string,
  modelId: string
): {
  inferenceProfileId: string
  inferenceProfileName: string
  status: 'ACTIVE'
  models: { modelArn: string }[]
} {
  return {
    inferenceProfileId,
    inferenceProfileName: inferenceProfileId,
    status: 'ACTIVE',
    models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}` }],
  }
}

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
