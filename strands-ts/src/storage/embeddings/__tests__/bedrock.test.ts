import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSend = vi.fn()
const MockBedrockRuntimeClient = vi.fn(function (this: { send: typeof mockSend }) {
  this.send = mockSend
} as unknown as () => void)
const MockInvokeModelCommand = vi.fn()

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: MockBedrockRuntimeClient,
  InvokeModelCommand: MockInvokeModelCommand,
}))

import { bedrockEmbedder } from '../bedrock.js'

describe('bedrockEmbedder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns a function', () => {
    const embedder = bedrockEmbedder()
    expect(typeof embedder).toBe('function')
  })

  it('calls Bedrock with the default Titan model', async () => {
    const embedding = [0.1, 0.2, 0.3]
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding })) })

    const embedder = bedrockEmbedder()
    const result = await embedder('hello world')

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

    const embedder = bedrockEmbedder({ modelId: 'cohere.embed-english-v3' })
    await embedder('test')

    expect(MockInvokeModelCommand).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'cohere.embed-english-v3' }))
  })

  it('passes region to the client', async () => {
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [1] })) })

    const embedder = bedrockEmbedder({ region: 'eu-west-1' })
    await embedder('test')

    expect(MockBedrockRuntimeClient).toHaveBeenCalledWith({ region: 'eu-west-1' })
  })

  it('uses a pre-configured client', async () => {
    const customClient = { send: vi.fn() } as any
    customClient.send.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ embedding: [0.5] })),
    })

    const embedder = bedrockEmbedder({ bedrockClient: customClient })
    const result = await embedder('test')

    expect(result).toEqual([0.5])
    expect(customClient.send).toHaveBeenCalled()
    expect(MockBedrockRuntimeClient).not.toHaveBeenCalled()
  })

  it('reuses the client across calls', async () => {
    mockSend.mockResolvedValue({ body: new TextEncoder().encode(JSON.stringify({ embedding: [1] })) })

    const embedder = bedrockEmbedder()
    await embedder('first')
    await embedder('second')

    expect(MockBedrockRuntimeClient).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledTimes(2)
  })
})
