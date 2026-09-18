import { describe, it, expect, vi } from 'vitest'
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamResult } from '@ai-sdk/provider'
import { BedrockModel } from '../bedrock.js'
import { AnthropicModel } from '../anthropic.js'
import { VercelModel } from '../vercel.js'
import { Message, TextBlock } from '../../types/messages.js'
import type { StreamOptions } from '../model.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import Anthropic from '@anthropic-ai/sdk'
import { ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime'

vi.mock('@aws-sdk/client-bedrock-runtime', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('@aws-sdk/client-bedrock-runtime')>()
  const ConverseStreamCommand = vi.fn()

  const mockSend = vi.fn(async () => ({
    stream: (async function* (): AsyncGenerator<unknown> {
      yield { messageStart: { role: 'assistant' } }
      yield { contentBlockDelta: { delta: { text: 'ok' } } }
      yield { contentBlockStop: {} }
      yield { messageStop: { stopReason: 'end_turn' } }
    })(),
  }))

  return {
    ...originalModule,
    BedrockRuntimeClient: vi.fn(function () {
      return {
        send: mockSend,
        middlewareStack: { add: vi.fn() },
        config: {
          region: vi.fn(async () => 'us-east-1'),
          useFipsEndpoint: vi.fn(async () => false),
        },
      }
    }),
    ConverseStreamCommand,
  }
})

/**
 * One `cacheConfig` object, handed unchanged to both providers, means the same thing on each.
 *
 * Compares how many cache points each section gets and which TTL they carry, rather than either
 * provider's own wire format, since those differ by design.
 */
describe('cacheConfig portability across providers', () => {
  const toolSpecs = [{ name: 'calculator', description: 'Calculate', inputSchema: { type: 'object' as const } }]
  const messages = [new Message({ role: 'user', content: [new TextBlock('durable prefix')] })]

  /** Cache points per section, normalized to `ttl ?? null` so the two wire formats are comparable. */
  const bedrockSections = async (cacheConfig: object): Promise<Record<string, (string | null)[]>> => {
    const provider = new BedrockModel({ modelId: 'global.anthropic.claude-sonnet-4-6', cacheConfig })
    await collectIterator(provider.stream(messages, { toolSpecs } as StreamOptions))

    const request = vi.mocked(ConverseStreamCommand).mock.lastCall?.[0] as any
    const tools = (request?.toolConfig?.tools ?? []).filter((entry: any) => entry.cachePoint)
    const messagePoints: any[] = []
    for (const message of request?.messages ?? []) {
      for (const block of message.content ?? []) if (block.cachePoint) messagePoints.push(block.cachePoint)
    }
    return {
      tools: tools.map((entry: any) => entry.cachePoint.ttl ?? null),
      messages: messagePoints.map((point) => point.ttl ?? null),
    }
  }

  const anthropicSections = async (cacheConfig: object): Promise<Record<string, (string | null)[]>> => {
    const captured: { request: any } = { request: null }
    const client = {
      messages: {
        stream: vi.fn((request) => {
          captured.request = request
          return (async function* () {})()
        }),
      },
    } as unknown as Anthropic
    const provider = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6', cacheConfig })
    await collectIterator(provider.stream(messages, { toolSpecs } as StreamOptions))

    const messagePoints: any[] = []
    for (const message of captured.request?.messages ?? []) {
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) if (block.cache_control) messagePoints.push(block.cache_control)
    }
    // Under the default auto strategy the conversation is cached by the top-level automatic
    // cache_control rather than a block-level point; both mean the messages section is on.
    if (captured.request?.cache_control) messagePoints.push(captured.request.cache_control)
    return {
      tools: (captured.request?.tools ?? [])
        .filter((entry: any) => entry.cache_control)
        .map((entry: any) => entry.cache_control.ttl ?? null),
      messages: messagePoints.map((point) => point.ttl ?? null),
    }
  }

  const vercelAnthropicSections = async (cacheConfig: object): Promise<Record<string, (string | null)[]>> => {
    const captured: { callOptions: LanguageModelV3CallOptions | null } = { callOptions: null }
    const provider = {
      specificationVersion: 'v3',
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-4-6',
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream: vi.fn(async (callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> => {
        captured.callOptions = callOptions
        return { stream: new ReadableStream({ start: (controller) => controller.close() }) }
      }),
    } as unknown as LanguageModelV3
    const model = new VercelModel({ provider, cacheConfig })
    await collectIterator(model.stream(messages, { toolSpecs } as StreamOptions))

    const cacheControl = (options: any): any => options?.anthropic?.cacheControl
    const tools = (captured.callOptions?.tools ?? [])
      .filter((tool) => tool.type === 'function')
      .filter((tool) => cacheControl(tool.providerOptions))
    // The breakpoint lands on a content part, not the message, so it can sit ahead of per-call blocks.
    const messageParts = (captured.callOptions?.prompt ?? [])
      .flatMap((message) => (message.role === 'user' ? message.content : []))
      .filter((part) => cacheControl(part.providerOptions))
    return {
      tools: tools.map((tool) => cacheControl((tool as { providerOptions?: unknown }).providerOptions).ttl ?? null),
      messages: messageParts.map((part) => cacheControl(part.providerOptions).ttl ?? null),
    }
  }

  it.each([
    ['both sections by default', {}, { tools: [null], messages: [null] }],
    ['a shared ttl on both sections', { ttl: '1h' }, { tools: ['1h'], messages: ['1h'] }],
    ['tool definitions only', { ttl: '1h', messagesTTL: false }, { tools: ['1h'], messages: [] }],
    ['conversation only', { ttl: '1h', toolsTTL: false }, { tools: [], messages: ['1h'] }],
    ['a per-section ttl override', { ttl: '1h', messagesTTL: '5m' }, { tools: ['1h'], messages: ['5m'] }],
    ['an empty ttl treated as unset', { ttl: '' }, { tools: [null], messages: [null] }],
    ['every section disabled', { toolsTTL: false, messagesTTL: false }, { tools: [], messages: [] }],
  ])('agrees on %s', async (_label, cacheConfig, expected) => {
    // The same object reaches every provider, as it would when switching provider.
    const bedrock = await bedrockSections(cacheConfig)
    const anthropic = await anthropicSections(cacheConfig)
    const vercelAnthropic = await vercelAnthropicSections(cacheConfig)

    expect(bedrock).toStrictEqual(expected)
    expect(anthropic).toStrictEqual(expected)
    expect(vercelAnthropic).toStrictEqual(expected)
  })
})
