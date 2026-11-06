import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { SageMakerDecisionModel } from '../sagemaker-decision-model.js'

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
        clientConfig: { region: 'us-west-2', maxAttempts: 5 },
      })

      await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })
      await decision.ask('state', { q: { question: 'ok?', choices: 'boolean' } })

      expect(mockSageMakerRuntimeClient).toHaveBeenCalledTimes(1)
      expect(mockSageMakerRuntimeClient).toHaveBeenCalledWith({ region: 'us-east-1', maxAttempts: 5 })
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

    it('enforces the InvokeEndpoint 6 MB body limit before sending', async () => {
      const decision = new SageMakerDecisionModel({ endpointName: ENDPOINT_NAME })

      const error = await decision
        .ask('x'.repeat(6 * 1024 * 1024), { q: { question: 'ok?', choices: 'boolean' } })
        .then(
          () => undefined,
          (caught: unknown) => caught
        )

      expect(error).toBeInstanceOf(ContextWindowOverflowError)
      expect(mockSend).not.toHaveBeenCalled()
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
  })
})
