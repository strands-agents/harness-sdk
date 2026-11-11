import type { SageMakerRuntimeClient } from '@aws-sdk/client-sagemaker-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isNode } from '../../__fixtures__/environment.js'
import { ContextWindowOverflowError, ModelError, ModelThrottledError } from '../../errors.js'

const mockSend = vi.fn()
const mockSageMakerRuntimeClient = vi.fn(function (this: { send: typeof mockSend }) {
  this.send = mockSend
} as unknown as () => void)
const mockInvokeEndpointCommand = vi.fn(function (this: { input: unknown }, input: unknown) {
  this.input = input
} as unknown as () => void)

vi.mock('@aws-sdk/client-sagemaker-runtime', () => ({
  SageMakerRuntimeClient: mockSageMakerRuntimeClient,
  InvokeEndpointCommand: mockInvokeEndpointCommand,
}))

import { SageMakerDecisionModel } from '../sagemaker.js'

const ENDPOINT_NAME = 'strands-decider-2b-qwen3-5-v1-2610'

function respond(payload: unknown): void {
  mockSend.mockResolvedValue({ Body: new TextEncoder().encode(JSON.stringify(payload)) })
}

function sageMakerError(name: string, fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${name} message`), { name, ...fields })
}

function sentInput(): Record<string, unknown> {
  const [input] = mockInvokeEndpointCommand.mock.calls[0] as unknown as [{ Body: Uint8Array }]
  return { ...input, Body: JSON.parse(new TextDecoder().decode(input.Body)) as unknown }
}

async function askError(decision: SageMakerDecisionModel): Promise<unknown> {
  return decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }).then(
    () => undefined,
    (caught: unknown) => caught
  )
}

describe('SageMakerDecisionModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('ask', () => {
    it('invokes the endpoint with the System One body and maps the response', async () => {
      respond({
        model: 'strands-decider-2B-qwen3.5-v1-2610',
        answers: { urgent: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 86, output_tokens: 1 },
        latency_ms: 1013.13,
      })
      const decision = new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME })

      const result = await decision.ask('Payouts failing', {
        urgent: { question: 'Is this urgent?', choices: 'boolean' },
      })

      expect(sentInput()).toEqual({
        EndpointName: ENDPOINT_NAME,
        ContentType: 'application/json',
        Accept: 'application/json',
        Body: { state: 'Payouts failing', questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } } },
      })
      expect(result).toEqual({
        answers: { urgent: true },
        usage: { inputTokens: 86, outputTokens: 1, totalTokens: 87 },
        metadata: {
          latencyMs: expect.any(Number),
          providerName: 'sagemaker',
          modelId: 'strands-decider-2B-qwen3.5-v1-2610',
          probabilities: { urgent: { true: 0.9, false: 0.09999999999999998 } },
          confidence: { urgent: 0.8 },
        },
      })
    })

    it('creates one client, with region taking precedence over clientConfig', async () => {
      respond({ model: 'm', answers: { q: { type: 'noul', noul: 1 } } })
      const decision = new SageMakerDecisionModel({
        endpointName: ENDPOINT_NAME,
        region: 'us-east-1',
        clientConfig: { region: 'us-west-2', maxAttempts: 5, customUserAgent: 'my-app' },
      })

      await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })
      await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(mockSageMakerRuntimeClient).toHaveBeenCalledTimes(1)
      expect(mockSageMakerRuntimeClient).toHaveBeenCalledWith({
        region: 'us-east-1',
        maxAttempts: 5,
        customUserAgent: [['my-app'], ['strands-agents-ts-sdk']],
      })
    })

    it('uses a provided client as is instead of creating one', async () => {
      const send = vi.fn().mockResolvedValue({
        Body: new TextEncoder().encode(JSON.stringify({ model: 'm', answers: { q: { type: 'noul', noul: 1 } } })),
      })
      const client = { send } as unknown as SageMakerRuntimeClient
      const decision = new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME, client })

      const result = await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(result.answers).toEqual({ q: true })
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]![0].input).toMatchObject({ EndpointName: ENDPOINT_NAME })
      expect(mockSageMakerRuntimeClient).not.toHaveBeenCalled()
    })

    it('passes the cancel signal to the client', async () => {
      respond({ model: 'm', answers: { q: { type: 'noul', noul: 1 } } })
      const decision = new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME })
      const controller = new AbortController()

      await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } }, { cancelSignal: controller.signal })

      expect(mockSend.mock.calls[0]![1]).toEqual({ abortSignal: controller.signal })
    })

    it.each([
      ['ThrottlingException', {}],
      ['ModelNotReadyException', {}],
      ['ServiceUnavailable', {}],
      ['ModelError', { OriginalStatusCode: 429 }],
      ['ModelError', { OriginalStatusCode: 503 }],
      ['ModelError', { OriginalStatusCode: '429' }],
      // A proxy or load balancer throttle has no SageMaker error type, only the HTTP status.
      ['Unknown', { $metadata: { httpStatusCode: 429 } }],
      ['SyntaxError', { $metadata: { httpStatusCode: 503 } }],
    ])('maps %s %o to ModelThrottledError', async (name, fields) => {
      const cause = sageMakerError(name, fields)
      mockSend.mockRejectedValue(cause)

      const error = await askError(new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME }))

      expect(error).toBeInstanceOf(ModelThrottledError)
      expect((error as Error).cause).toBe(cause)
    })

    it.each([
      { OriginalStatusCode: 413 },
      {
        OriginalStatusCode: 422,
        OriginalMessage: '{"detail":"prompt of 9000 tokens exceeds the context window of 8192 tokens"}',
      },
      {
        OriginalStatusCode: 400,
        OriginalMessage: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
      },
      {
        OriginalStatusCode: 400,
        OriginalMessage: '{"object":"error","message":"This model\'s maximum context length is 8192 tokens."}',
      },
      { OriginalStatusCode: '413' },
      { $metadata: { httpStatusCode: 413 } },
    ])('maps a container error %o to ContextWindowOverflowError', async (fields) => {
      mockSend.mockRejectedValue(sageMakerError('ModelError', fields))

      await expect(askError(new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME }))).resolves.toBeInstanceOf(
        ContextWindowOverflowError
      )
    })

    it.each([
      [
        'ModelError',
        { OriginalStatusCode: 422, OriginalMessage: '{"detail":[{"msg":"choice requires at least 2 options"}]}' },
      ],
      // A validation error echoes the request, which may itself mention the context window.
      [
        'ModelError',
        {
          OriginalStatusCode: 422,
          OriginalMessage: '{"detail":[{"msg":"choice requires at least 2 options","input":{"context window":null}}]}',
        },
      ],
      ['ModelError', { $metadata: { httpStatusCode: 424 } }],
      ['ValidationError', {}],
      ['InternalFailure', {}],
    ])('maps %s %o to ModelError with the original cause', async (name, fields) => {
      const cause = sageMakerError(name, fields)
      mockSend.mockRejectedValue(cause)

      const error = await askError(new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME }))

      expect(error).toBeInstanceOf(ModelError)
      expect(error).not.toBeInstanceOf(ModelThrottledError)
      expect(error).not.toBeInstanceOf(ContextWindowOverflowError)
      expect((error as Error).cause).toBe(cause)
    })

    it('rejects a non-JSON response body', async () => {
      mockSend.mockResolvedValue({ Body: new TextEncoder().encode('not json') })

      const decision = new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME })

      await expect(decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })).rejects.toThrow(
        /non-JSON response/
      )
    })
  })

  describe('construction', () => {
    it('requires an endpoint name', () => {
      expect(() => new SageMakerDecisionModel({ endpointName: ' ' })).toThrow(/requires an endpointName/)
    })

    it('rejects an invalid default threshold', () => {
      expect(() => new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME, defaultMinConfidence: 1.1 })).toThrow(
        /defaultMinConfidence must be in \[0.0, 1.0\]/
      )
    })

    it.each([{ region: 'us-east-1' }, { clientConfig: { maxAttempts: 5 } }])(
      'rejects a provided client combined with %o',
      (options) => {
        const client = { send: vi.fn() } as unknown as SageMakerRuntimeClient

        expect(() => new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME, client, ...options })).toThrow(
          /Cannot specify both client and region\/clientConfig/
        )
      }
    )
  })

  // Node-only: in Vitest browser mode a mock factory that throws fails inside the mocker instead
  // of failing the import, so a missing package can't be simulated there.
  describe.skipIf(!isNode)('without @aws-sdk/client-sagemaker-runtime', () => {
    afterEach(() => {
      vi.doMock('@aws-sdk/client-sagemaker-runtime', () => ({
        SageMakerRuntimeClient: mockSageMakerRuntimeClient,
        InvokeEndpointCommand: mockInvokeEndpointCommand,
      }))
      vi.resetModules()
    })

    it('rejects with install guidance and the import failure as cause', async () => {
      vi.resetModules()
      vi.doMock('@aws-sdk/client-sagemaker-runtime', () => {
        throw new Error("Cannot find package '@aws-sdk/client-sagemaker-runtime'")
      })
      const { SageMakerDecisionModel: Uninstalled } = await import('../sagemaker.js')

      const error = await askError(new Uninstalled({ endpointName: ENDPOINT_NAME }))

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toMatch(/npm install '@aws-sdk\/client-sagemaker-runtime'/)
      expect((error as Error).cause).toBeInstanceOf(Error)
    })
  })
})
