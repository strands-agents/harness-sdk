import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSend, MockBedrockRuntimeClient, MockInvokeModelCommand } = vi.hoisted(() => {
  const mockSend = vi.fn()
  return {
    mockSend,
    MockBedrockRuntimeClient: vi.fn(function (this: { send: typeof mockSend }) {
      this.send = mockSend
    } as unknown as () => void),
    MockInvokeModelCommand: vi.fn(),
  }
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: MockBedrockRuntimeClient,
  InvokeModelCommand: MockInvokeModelCommand,
}))

import { BedrockEmbedder } from '../bedrock.js'
import { Embedder } from '../../search/embedder.js'
import { StorageError } from '../../../errors.js'

describe('BedrockEmbedder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is an Embedder', () => {
    expect(new BedrockEmbedder()).toBeInstanceOf(Embedder)
  })

  it('calls Bedrock with the default Titan model', async () => {
    const embedding = [0.1, 0.2, 0.3]
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding })) })

    const embedder = new BedrockEmbedder()
    const result = await embedder.embed('hello world')

    expect(result).toEqual(embedding)
    expect(MockInvokeModelCommand).toHaveBeenCalledWith({
      modelId: 'amazon.titan-embed-text-v2:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText: 'hello world' }),
    })
  })

  it('uses a custom model ID', async () => {
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [1] })) })

    const embedder = new BedrockEmbedder({ modelId: 'amazon.titan-embed-text-v1' })
    await embedder.embed('test')

    expect(MockInvokeModelCommand).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'amazon.titan-embed-text-v1' })
    )
  })

  it('sends a configured output dimension', async () => {
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [1] })) })

    const embedder = new BedrockEmbedder({ dimensions: 256 })
    await embedder.embed('test')

    expect(MockInvokeModelCommand).toHaveBeenCalledWith(
      expect.objectContaining({ body: JSON.stringify({ inputText: 'test', dimensions: 256 }) })
    )
  })

  it('passes any model ID through to Bedrock unchecked', async () => {
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [1] })) })

    const embedder = new BedrockEmbedder({ modelId: 'amazon.titan-embed-text-v3:0' })
    await embedder.embed('test')

    expect(MockInvokeModelCommand).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'amazon.titan-embed-text-v3:0' })
    )
  })

  it.each([
    ['a non-Titan response', { embeddings: [[0.1]] }],
    ['an error payload', { message: 'Malformed input request' }],
  ])('throws StorageError on %s', async (_label, body) => {
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify(body)) })

    const embedder = new BedrockEmbedder()

    await expect(embedder.embed('test')).rejects.toThrow(StorageError)
  })

  it('passes region to the client', async () => {
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [1] })) })

    const embedder = new BedrockEmbedder({ region: 'eu-west-1' })
    await embedder.embed('test')

    expect(MockBedrockRuntimeClient).toHaveBeenCalledWith({ region: 'eu-west-1' })
  })

  it('uses a pre-configured client', async () => {
    const customClient = { send: vi.fn() } as any
    customClient.send.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ embedding: [0.5] })),
    })

    const embedder = new BedrockEmbedder({ bedrockClient: customClient })
    const result = await embedder.embed('test')

    expect(result).toEqual([0.5])
    expect(customClient.send).toHaveBeenCalled()
    expect(MockBedrockRuntimeClient).not.toHaveBeenCalled()
  })

  it('throws when both bedrockClient and region are provided', () => {
    const customClient = { send: vi.fn() } as never
    expect(() => new BedrockEmbedder({ bedrockClient: customClient, region: 'eu-west-1' })).toThrow(StorageError)
  })

  it('reuses the client across calls', async () => {
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [1] })) })

    const embedder = new BedrockEmbedder()
    await embedder.embed('first')
    await embedder.embed('second')

    expect(MockBedrockRuntimeClient).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledTimes(2)
  })
})
