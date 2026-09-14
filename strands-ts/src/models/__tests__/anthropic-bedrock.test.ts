import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { isNode } from '../../__fixtures__/environment.js'
import { AnthropicModel } from '../anthropic.js'
import { Message, TextBlock } from '../../types/messages.js'

vi.mock('@anthropic-ai/sdk', () => {
  const mockConstructor = vi.fn(function () {
    return { messages: { stream: vi.fn(), countTokens: vi.fn() } }
  })
  return { default: mockConstructor }
})

const countTokensMock = vi.fn()
const mantleConstructorMock = vi.fn((_options: Record<string, unknown>) => ({
  messages: { stream: vi.fn(), countTokens: countTokensMock },
}))
vi.mock('@anthropic-ai/bedrock-sdk', () => ({
  AnthropicBedrockMantle: function (this: unknown, options: Record<string, unknown>) {
    return mantleConstructorMock(options)
  },
}))

vi.mock('../../logging/warn-once.js', () => ({
  warnOnce: vi.fn(),
}))

const TEST_MODEL_ID = 'anthropic.claude-sonnet-5'
const MESSAGES: Message[] = [new Message({ role: 'user', content: [new TextBlock('hello')] })]

/** Builds a Mantle-routed model; the client itself is only created on first request. */
function mantleModel(options: Record<string, unknown> = {}): AnthropicModel {
  return new AnthropicModel({
    modelId: TEST_MODEL_ID,
    maxTokens: 64,
    useNativeTokenCount: true,
    bedrockMantleConfig: { region: 'us-east-1' },
    ...options,
  })
}

/** Drives the lazily imported client into existence. */
async function firstRequest(model: AnthropicModel): Promise<void> {
  await model.countTokens(MESSAGES)
}

/** Options the Mantle client was last constructed with. */
function lastMantleOptions(): Record<string, unknown> {
  expect(mantleConstructorMock).toHaveBeenCalled()
  return mantleConstructorMock.mock.calls.at(-1)![0]
}

describe('AnthropicModel bedrockMantleConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    countTokensMock.mockResolvedValue({ input_tokens: 7 })
    if (isNode) {
      // The Mantle pathway must not read the direct-API key, and region resolution must
      // not inherit the runner's environment.
      vi.stubEnv('ANTHROPIC_API_KEY', '')
      vi.stubEnv('AWS_REGION', '')
      vi.stubEnv('AWS_DEFAULT_REGION', '')
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (isNode) {
      vi.unstubAllEnvs()
    }
  })

  describe('client wiring', () => {
    it('builds the Mantle client rather than the direct Anthropic client', async () => {
      await firstRequest(mantleModel())

      expect(lastMantleOptions()).toEqual({ awsRegion: 'us-east-1' })
      expect(Anthropic).not.toHaveBeenCalled()
    })

    it('builds the direct Anthropic client when the config is absent', () => {
      new AnthropicModel({ modelId: 'claude-sonnet-4-6', maxTokens: 64, apiKey: 'sk-ant-test' })

      expect(Anthropic).toHaveBeenCalled()
      expect(mantleConstructorMock).not.toHaveBeenCalled()
    })

    it('defers building the client until the first request', () => {
      mantleModel()

      expect(mantleConstructorMock).not.toHaveBeenCalled()
    })

    it('reuses a single client across requests', async () => {
      const model = mantleModel()

      await firstRequest(model)
      await firstRequest(model)

      expect(mantleConstructorMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('model defaults', () => {
    it('defaults to a model the Mantle catalog serves', () => {
      // Mantle does not carry Sonnet 4.6, so the direct-API default would 404 there.
      const model = new AnthropicModel({ maxTokens: 64, bedrockMantleConfig: { region: 'us-east-1' } })

      expect(model.getConfig().modelId).toBe('anthropic.claude-sonnet-5')
    })

    it('leaves the direct-API default alone', () => {
      const model = new AnthropicModel({ maxTokens: 64, apiKey: 'sk-ant-test' })

      expect(model.getConfig().modelId).toBe('claude-sonnet-4-6')
    })
  })

  describe('option mapping', () => {
    it('forwards profile and apiKey', async () => {
      await firstRequest(mantleModel({ bedrockMantleConfig: { region: 'us-east-1', profile: 'p1', apiKey: 'k1' } }))

      expect(lastMantleOptions()).toEqual({ awsRegion: 'us-east-1', awsProfile: 'p1', apiKey: 'k1' })
    })

    it('merges clientConfig transport options', async () => {
      await firstRequest(mantleModel({ clientConfig: { timeout: 42, defaultHeaders: { 'X-Trace-Id': 'abc' } } }))

      expect(lastMantleOptions()).toEqual({
        awsRegion: 'us-east-1',
        timeout: 42,
        defaultHeaders: { 'X-Trace-Id': 'abc' },
      })
    })
  })

  describe('validation', () => {
    // The message names the offending option, so it is asserted here rather than only the
    // prefix: the check and the message must not be able to disagree about what conflicted.
    it.each([
      ['a pre-built client', { client: {} as Anthropic }, 'client'],
      ['a top-level apiKey', { apiKey: 'sk-ant-test' }, 'apiKey'],
      ['clientConfig.apiKey', { clientConfig: { apiKey: 'sk-ant-test' } }, 'clientConfig.apiKey'],
    ])('rejects %s', (_label, options, named) => {
      expect(() => mantleModel(options)).toThrow(`bedrockMantleConfig cannot be combined with ${named};`)
    })

    it('rejects a malformed region before it reaches the endpoint URL', () => {
      expect(() => mantleModel({ bedrockMantleConfig: { region: 'x@attacker.com:443/#' } })).toThrow(
        'invalid AWS region'
      )
    })
  })

  if (isNode) {
    describe('region resolution', () => {
      it('resolves the region from AWS_REGION', async () => {
        vi.stubEnv('AWS_REGION', 'eu-west-1')

        await firstRequest(mantleModel({ bedrockMantleConfig: {} }))

        expect(lastMantleOptions()).toEqual({ awsRegion: 'eu-west-1' })
      })

      it('resolves the region from AWS_DEFAULT_REGION', async () => {
        vi.stubEnv('AWS_DEFAULT_REGION', 'ap-northeast-1')

        await firstRequest(mantleModel({ bedrockMantleConfig: {} }))

        expect(lastMantleOptions()).toEqual({ awsRegion: 'ap-northeast-1' })
      })

      it('rejects a malformed region resolved from the environment', () => {
        vi.stubEnv('AWS_REGION', 'x@attacker.com:443/#')

        expect(() => mantleModel({ bedrockMantleConfig: {} })).toThrow('invalid AWS region')
      })

      it('throws when no region resolves', () => {
        expect(() => mantleModel({ bedrockMantleConfig: {} })).toThrow('could not resolve an AWS region')
      })
    })
  }
})
