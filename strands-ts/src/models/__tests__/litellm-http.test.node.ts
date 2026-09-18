import { Buffer } from 'node:buffer'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { Message, TextBlock } from '../../types/messages.js'
import { LiteLLMModel } from '../litellm.js'

describe('LiteLLMModel HTTP gateway', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())))
  })

  it('sends and consumes a real OpenAI-compatible SSE exchange', async () => {
    let requestPath: string | undefined
    let authorization: string | undefined
    let requestBody: unknown
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      requestPath = request.url
      authorization = request.headers.authorization
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":"gateway ok"},"index":0}]}\n\n')
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n')
        response.write('data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const model = new LiteLLMModel({
      modelId: 'gateway-alias',
      baseURL: `http://127.0.0.1:${address.port}`,
      apiKey: 'sk-local-test',
    })

    const events = await collectIterator(
      model.stream([new Message({ role: 'user', content: [new TextBlock('hello gateway')] })])
    )

    expect(requestPath).toBe('/chat/completions')
    expect(authorization).toBe('Bearer sk-local-test')
    expect(requestBody).toEqual({
      model: 'gateway-alias',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello gateway' }] }],
      stream: true,
      stream_options: { include_usage: true },
      tools: [],
    })
    expect(events).toEqual([
      { type: 'modelMessageStartEvent', role: 'assistant' },
      { type: 'modelContentBlockStartEvent' },
      { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'gateway ok' } },
      { type: 'modelContentBlockStopEvent' },
      { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
      { type: 'modelMetadataEvent', usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 } },
    ])
  })
})
