import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import OpenAI from 'openai'
import { isNode } from '../../../__fixtures__/environment.js'
import { OpenAIModel } from '../index.js'

vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>()
  const mockConstructor = vi.fn(function (this: unknown) {
    return {}
  })
  return {
    ...actual,
    default: mockConstructor,
  }
})

const getTokenProviderMock = vi.fn()
vi.mock('@aws/bedrock-token-generator', () => ({
  getTokenProvider: (...args: unknown[]) => getTokenProviderMock(...args),
}))

const TEST_MODEL_ID = 'openai.gpt-oss-120b'
const TEST_TOKEN = 'bedrock-api-key-deadbeef&Version=1'

function lastApiKeySetter(): () => Promise<string> {
  const calls = (OpenAI as unknown as { mock: { calls: unknown[][] } }).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  const options = calls[calls.length - 1]![0] as { apiKey: () => Promise<string> }
  expect(typeof options.apiKey).toBe('function')
  return options.apiKey
}

describe('OpenAIModel bedrockMantleConfig', () => {
  let provideTokenMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    if (isNode) {
      // Mantle pathway shouldn't look at OPENAI_API_KEY — guard against
      // accidental env leakage by clearing it for the suite.
      vi.stubEnv('OPENAI_API_KEY', '')
      vi.stubEnv('AWS_REGION', '')
      vi.stubEnv('AWS_DEFAULT_REGION', '')
    }
    provideTokenMock = vi.fn().mockResolvedValue(TEST_TOKEN)
    getTokenProviderMock.mockReturnValue(provideTokenMock)
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (isNode) {
      vi.unstubAllEnvs()
    }
  })

  describe('constructor wiring', () => {
    it('sets baseURL and installs async apiKey setter that mints a bearer token', async () => {
      new OpenAIModel({
        modelId: TEST_MODEL_ID,
        bedrockMantleConfig: { region: 'us-east-1' },
      })

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
          apiKey: expect.any(Function),
        })
      )

      const apiKey = await lastApiKeySetter()()
      expect(apiKey).toBe(TEST_TOKEN)
      expect(getTokenProviderMock).toHaveBeenCalledWith({ region: 'us-east-1' })
    })

    it('forwards optional credentials and expiresInSeconds to getTokenProvider', async () => {
      const credentials = vi.fn()
      new OpenAIModel({
        modelId: TEST_MODEL_ID,
        bedrockMantleConfig: {
          region: 'us-west-2',
          credentials,
          expiresInSeconds: 900,
        },
      })

      await lastApiKeySetter()()

      expect(getTokenProviderMock).toHaveBeenCalledWith({
        region: 'us-west-2',
        credentials,
        expiresInSeconds: 900,
      })
    })

    it('mints a fresh token on every apiKey setter call', async () => {
      new OpenAIModel({
        modelId: TEST_MODEL_ID,
        bedrockMantleConfig: { region: 'us-east-1' },
      })

      const apiKey = lastApiKeySetter()
      await apiKey()
      await apiKey()
      await apiKey()

      // The token provider is created once and reused, but it is invoked per call.
      expect(getTokenProviderMock).toHaveBeenCalledTimes(1)
      expect(provideTokenMock).toHaveBeenCalledTimes(3)
    })

    it('merges with other clientConfig fields while overriding baseURL and apiKey', () => {
      const http = vi.fn()
      new OpenAIModel({
        modelId: TEST_MODEL_ID,
        clientConfig: {
          timeout: 42,
          fetch: http,
          defaultHeaders: { 'X-Trace-Id': 'abc' },
        },
        bedrockMantleConfig: { region: 'us-east-1' },
      })

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1',
          apiKey: expect.any(Function),
          timeout: 42,
          fetch: http,
          defaultHeaders: { 'X-Trace-Id': 'abc' },
        })
      )
    })

    it('does not check OPENAI_API_KEY when bedrockMantleConfig is set', () => {
      // env vars are cleared in beforeEach — this would normally throw, but the
      // Mantle pathway has its own auth and must bypass the check.
      expect(
        () => new OpenAIModel({ modelId: TEST_MODEL_ID, bedrockMantleConfig: { region: 'us-east-1' } })
      ).not.toThrow()
    })

    it('mints a bearer token regardless of api mode', async () => {
      new OpenAIModel({
        api: 'chat',
        modelId: TEST_MODEL_ID,
        bedrockMantleConfig: { region: 'us-east-1' },
      })
      const apiKey = await lastApiKeySetter()()
      expect(apiKey).toBe(TEST_TOKEN)
    })
  })

  // The Mantle base path is a property of the individual model, not of its vendor
  // prefix or the API surface. Expectations here mirror a live probe of the
  // `us-east-1` catalog (see the `mantle-routing` integ test).
  describe('base path resolution by model family', () => {
    const baseURLFor = (options: ConstructorParameters<typeof OpenAIModel>[0]): string => {
      new OpenAIModel(options)
      const calls = (OpenAI as unknown as { mock: { calls: unknown[][] } }).mock.calls
      return (calls[calls.length - 1]![0] as { baseURL: string }).baseURL
    }

    it('uses /openai/v1 for gpt-5.* on the responses api', () => {
      expect(baseURLFor({ modelId: 'openai.gpt-5.6-luna', bedrockMantleConfig: { region: 'us-west-2' } })).toBe(
        'https://bedrock-mantle.us-west-2.api.aws/openai/v1'
      )
    })

    it('uses /openai/v1 for gpt-5.* on the chat api', () => {
      expect(
        baseURLFor({ api: 'chat', modelId: 'openai.gpt-5.6-luna', bedrockMantleConfig: { region: 'us-west-2' } })
      ).toBe('https://bedrock-mantle.us-west-2.api.aws/openai/v1')
    })

    it('uses /v1 for gpt-oss-* on the responses api', () => {
      expect(baseURLFor({ modelId: 'openai.gpt-oss-120b', bedrockMantleConfig: { region: 'us-west-2' } })).toBe(
        'https://bedrock-mantle.us-west-2.api.aws/v1'
      )
    })

    it('uses /v1 for gpt-oss-* on the chat api', () => {
      expect(
        baseURLFor({ api: 'chat', modelId: 'openai.gpt-oss-120b', bedrockMantleConfig: { region: 'us-west-2' } })
      ).toBe('https://bedrock-mantle.us-west-2.api.aws/v1')
    })

    it('matches only Bedrock-style ids: openai.gpt-5.* → /openai/v1, bare gpt-5.* → /v1', () => {
      expect(baseURLFor({ modelId: 'gpt-5.4', bedrockMantleConfig: { region: 'us-west-2' } })).toBe(
        'https://bedrock-mantle.us-west-2.api.aws/v1'
      )
    })

    // Regression for #3654: Mantle rejects the wrong base path with HTTP 400
    // `validation_error`. The affected ids use /openai/v1; controls below pin /v1.
    it.each([
      ['xai.grok-4.3', '/openai/v1'],
      ['google.gemma-4-31b', '/openai/v1'],
      ['google.gemma-4-26b-a4b', '/openai/v1'],
      ['google.gemma-4-e2b', '/openai/v1'],
      ['openai.gpt-5.6-terra', '/openai/v1'],
      // Gemma 3 is served from /v1 while Gemma 4 is not, so `google.` cannot be a prefix.
      ['google.gemma-3-27b-it', '/v1'],
      ['google.gemma-3-4b-it', '/v1'],
      ['openai.gpt-oss-120b', '/v1'],
      ['openai.gpt-oss-safeguard-20b', '/v1'],
      ['qwen.qwen3-32b', '/v1'],
      ['deepseek.v3.2', '/v1'],
      ['mistral.ministral-3-8b-instruct', '/v1'],
      ['zai.glm-5', '/v1'],
      ['moonshotai.kimi-k2.5', '/v1'],
      ['minimax.minimax-m2', '/v1'],
      ['nvidia.nemotron-nano-9b-v2', '/v1'],
      ['writer.palmyra-vision-7b', '/v1'],
    ])('routes %s to %s on both api surfaces', (modelId, expected) => {
      const url = `https://bedrock-mantle.us-west-2.api.aws${expected}`
      expect(baseURLFor({ modelId, bedrockMantleConfig: { region: 'us-west-2' } })).toBe(url)
      expect(baseURLFor({ api: 'chat', modelId, bedrockMantleConfig: { region: 'us-west-2' } })).toBe(url)
    })

    // Ids beyond the verified catalog: a known line routes by prefix, a new line falls to /v1.
    it.each([
      // Point releases within a verified line, beyond the verified catalog.
      ['xai.grok-4.9', '/openai/v1'],
      ['openai.gpt-5.9-unreleased', '/openai/v1'],
      // New lines the prefixes deliberately do not cover.
      ['xai.grok-5', '/v1'],
      ['xai.grok-5-preview', '/v1'],
    ])('resolves unverified %s to %s', (modelId, expected) => {
      expect(baseURLFor({ modelId, bedrockMantleConfig: { region: 'us-west-2' } })).toBe(
        `https://bedrock-mantle.us-west-2.api.aws${expected}`
      )
    })

    // #3667: a `modelId` swap across the base-path boundary rebuilds the Mantle
    // client against the new base URL. The negative controls below pin the two
    // ways that must NOT happen: within one base path, and off the Mantle path.
    const clientCallCount = (): number => (OpenAI as unknown as { mock: { calls: unknown[][] } }).mock.calls.length
    const lastClientArgs = (): { baseURL: string; apiKey: unknown } =>
      (OpenAI as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0] as {
        baseURL: string
        apiKey: unknown
      }

    it('reroutes the Mantle base URL when updateConfig moves modelId across base paths', () => {
      const model = new OpenAIModel({
        modelId: 'openai.gpt-oss-120b',
        bedrockMantleConfig: { region: 'us-west-2' },
      })
      expect(lastClientArgs().baseURL).toBe('https://bedrock-mantle.us-west-2.api.aws/v1')
      const before = clientCallCount()

      model.updateConfig({ modelId: 'xai.grok-4.3' })

      expect(model.getConfig().modelId).toBe('xai.grok-4.3')
      expect(clientCallCount()).toBe(before + 1)
      expect(lastClientArgs().baseURL).toBe('https://bedrock-mantle.us-west-2.api.aws/openai/v1')
    })

    // The memoized token provider lives in the setter's closure, so the rebuilt
    // client must be handed the *same* setter rather than a fresh one.
    it('reuses the construction-time api key setter when rerouting', () => {
      const model = new OpenAIModel({
        modelId: 'openai.gpt-oss-120b',
        bedrockMantleConfig: { region: 'us-west-2' },
      })
      const originalApiKey = lastClientArgs().apiKey

      model.updateConfig({ modelId: 'xai.grok-4.3' })

      expect(lastClientArgs().apiKey).toBe(originalApiKey)
    })

    it('keeps the existing client when the new modelId stays on the same base path', () => {
      const model = new OpenAIModel({
        modelId: 'openai.gpt-oss-120b',
        bedrockMantleConfig: { region: 'us-west-2' },
      })
      const before = clientCallCount()

      model.updateConfig({ modelId: 'qwen.qwen3-32b' })

      expect(model.getConfig().modelId).toBe('qwen.qwen3-32b')
      expect(clientCallCount()).toBe(before)
      expect(lastClientArgs().baseURL).toBe('https://bedrock-mantle.us-west-2.api.aws/v1')
    })

    it('keeps the existing client when updateConfig leaves modelId alone', () => {
      const model = new OpenAIModel({
        modelId: 'openai.gpt-oss-120b',
        bedrockMantleConfig: { region: 'us-west-2' },
      })
      const before = clientCallCount()

      model.updateConfig({ params: { temperature: 0.5 } })

      expect(clientCallCount()).toBe(before)
    })

    it('does not touch the client when bedrockMantleConfig is not used', () => {
      const model = new OpenAIModel({ modelId: 'gpt-5.4', client: {} as OpenAI })
      const before = clientCallCount()

      model.updateConfig({ modelId: 'openai.gpt-oss-120b' })

      expect(clientCallCount()).toBe(before)
    })
  })

  describe('validation', () => {
    it('throws when bedrockMantleConfig is combined with a pre-built client', () => {
      const client = {} as OpenAI
      expect(
        () =>
          new OpenAIModel({
            modelId: TEST_MODEL_ID,
            client,
            bedrockMantleConfig: { region: 'us-east-1' },
          })
      ).toThrow(/bedrockMantleConfig.*pre-built/)
    })

    it('throws when clientConfig.baseURL is set alongside bedrockMantleConfig', () => {
      expect(
        () =>
          new OpenAIModel({
            modelId: TEST_MODEL_ID,
            clientConfig: { baseURL: 'https://example.invalid' },
            bedrockMantleConfig: { region: 'us-east-1' },
          })
      ).toThrow(/baseURL/)
    })

    it('throws when clientConfig.apiKey is set alongside bedrockMantleConfig', () => {
      expect(
        () =>
          new OpenAIModel({
            modelId: TEST_MODEL_ID,
            clientConfig: { apiKey: 'sk-nope' },
            bedrockMantleConfig: { region: 'us-east-1' },
          })
      ).toThrow(/apiKey/)
    })

    it('throws when top-level apiKey is set alongside bedrockMantleConfig', () => {
      expect(
        () =>
          new OpenAIModel({
            modelId: TEST_MODEL_ID,
            apiKey: 'sk-nope',
            bedrockMantleConfig: { region: 'us-east-1' },
          })
      ).toThrow(/apiKey/)
    })
  })

  describe('region resolution', () => {
    it('throws when no region is available from config or env', () => {
      expect(() => new OpenAIModel({ modelId: TEST_MODEL_ID, bedrockMantleConfig: {} })).toThrow(
        /could not resolve an AWS region/
      )
    })

    if (isNode) {
      it('falls back to AWS_REGION env var', async () => {
        vi.stubEnv('AWS_REGION', 'eu-west-1')
        new OpenAIModel({ modelId: TEST_MODEL_ID, bedrockMantleConfig: {} })
        await lastApiKeySetter()()
        expect(OpenAI).toHaveBeenCalledWith(
          expect.objectContaining({ baseURL: 'https://bedrock-mantle.eu-west-1.api.aws/v1' })
        )
        expect(getTokenProviderMock).toHaveBeenCalledWith({ region: 'eu-west-1' })
      })

      it('falls back to AWS_DEFAULT_REGION when AWS_REGION is unset', async () => {
        vi.stubEnv('AWS_DEFAULT_REGION', 'ap-southeast-2')
        new OpenAIModel({ modelId: TEST_MODEL_ID, bedrockMantleConfig: {} })
        await lastApiKeySetter()()
        expect(getTokenProviderMock).toHaveBeenCalledWith({ region: 'ap-southeast-2' })
      })

      it('prefers explicit region over env vars', async () => {
        vi.stubEnv('AWS_REGION', 'eu-west-1')
        new OpenAIModel({ modelId: TEST_MODEL_ID, bedrockMantleConfig: { region: 'us-east-1' } })
        await lastApiKeySetter()()
        expect(getTokenProviderMock).toHaveBeenCalledWith({ region: 'us-east-1' })
      })
    }

    it.each(['x@attacker.com/', 'us-east-1\n', 'us-east-1/', 'US-EAST-1', 'useast1', 'us-east-١', 'us-éast-1'])(
      'rejects a malformed region %j before building the endpoint URL',
      (region) => {
        expect(() => new OpenAIModel({ modelId: TEST_MODEL_ID, bedrockMantleConfig: { region } })).toThrow(
          /invalid AWS region/
        )
        // Validation must precede token minting so no bearer token is ever sent toward the host.
        expect(getTokenProviderMock).not.toHaveBeenCalled()
      }
    )

    it.each(['us-east-1', 'ap-southeast-1', 'us-gov-east-1'])('accepts the well-formed region %j', (region) => {
      expect(() => new OpenAIModel({ modelId: TEST_MODEL_ID, bedrockMantleConfig: { region } })).not.toThrow()
    })

    if (isNode) {
      it('rejects a malformed region supplied via AWS_REGION', () => {
        vi.stubEnv('AWS_REGION', 'x@attacker.com/')
        expect(() => new OpenAIModel({ modelId: TEST_MODEL_ID, bedrockMantleConfig: {} })).toThrow(/invalid AWS region/)
      })
    }
  })

  describe('token minting errors', () => {
    it('wraps token provider failures with actionable context', async () => {
      provideTokenMock.mockRejectedValueOnce(new Error('no credentials in chain'))
      new OpenAIModel({ modelId: TEST_MODEL_ID, bedrockMantleConfig: { region: 'us-east-1' } })
      await expect(lastApiKeySetter()()).rejects.toThrow(/us-east-1/)
    })
  })
})
