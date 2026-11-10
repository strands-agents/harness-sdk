import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime'
import { BedrockModel } from '../bedrock.js'
import { Message, TextBlock } from '../../types/messages.js'

describe('BedrockModel browser transport cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const stream of [true, false]) {
    it(`aborts the default ${stream ? 'streaming' : 'non-streaming'} fetch transport`, async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const request = input as Request
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')),
            { once: true }
          )
        })
      })
      vi.stubGlobal('fetch', fetchMock)

      const model = new BedrockModel({
        region: 'us-east-1',
        modelId: 'test-model',
        stream,
        clientConfig: {
          credentials: {
            accessKeyId: 'test-access-key',
            secretAccessKey: 'test-secret-key',
          },
        },
      })
      const controller = new AbortController()
      const output = model.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })], {
        cancelSignal: controller.signal,
      })
      const iterator = output[Symbol.asyncIterator]()

      const result = iterator.next()
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
      controller.abort()

      await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    })
  }

  it('preserves a caller-provided request handler', () => {
    const requestHandler = {
      metadata: { handlerProtocol: 'custom' },
      handle: vi.fn(),
      updateHttpClientConfig: vi.fn(),
      httpHandlerConfigs: vi.fn(() => ({})),
    }

    const model = new BedrockModel({
      region: 'us-east-1',
      modelId: 'test-model',
      clientConfig: {
        requestHandler: requestHandler as NonNullable<BedrockRuntimeClientConfig['requestHandler']>,
      },
    })

    expect(model['_client'].config.requestHandler).toBe(requestHandler)
  })
})
