/**
 * Writes the TS-produced wire fixtures that strands-rs round-trips byte for byte.
 *
 * Run from the repo root: `npx tsx strands-rs/conformance/generate.ts`.
 *
 * Each fixture file is `{ source, cases: [{ name, json }] }`, where `json` is the exact
 * `JSON.stringify` output of the TS value. Clocks, UUIDs and random bytes are fixed before
 * strands-ts is imported, so two runs write identical files.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const FIXTURES = join(HERE, 'fixtures')

const MODEL_INFO = join(REPO, 'strands-ts', 'src', 'models', 'model-info.json')
if (!existsSync(MODEL_INFO)) {
  copyFileSync(join(REPO, 'shared', 'model-info.json'), MODEL_INFO)
}

// --- Determinism -------------------------------------------------------------------------------

const FIXED_NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const RealDate = Date

class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) {
      super(FIXED_NOW)
    } else {
      super(...(args as [string]))
    }
  }

  static override now(): number {
    return FIXED_NOW
  }
}

globalThis.Date = FixedDate as DateConstructor
globalThis.performance.now = (): number => 0

let uuidCounter = 0
function nextUuid(): `${string}-${string}-${string}-${string}-${string}` {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`
}

let rngState = 0x2545f491
function nextByte(): number {
  rngState ^= rngState << 13
  rngState ^= rngState >>> 17
  rngState ^= rngState << 5
  return (rngState >>> 0) & 0xff
}

function fillRandom<T extends ArrayBufferView | null>(array: T): T {
  if (array === null) return array
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
  for (let i = 0; i < bytes.length; i++) bytes[i] = nextByte()
  return array
}

Object.defineProperty(globalThis.crypto, 'randomUUID', { value: nextUuid, configurable: true, writable: true })
Object.defineProperty(globalThis.crypto, 'getRandomValues', { value: fillRandom, configurable: true, writable: true })

// --- strands-ts imports (after the patches above) -----------------------------------------------

const messagesTs = await import('../../strands-ts/src/types/messages.js')
const citationsTs = await import('../../strands-ts/src/types/citations.js')
const mediaTs = await import('../../strands-ts/src/types/media.js')
const interruptTypesTs = await import('../../strands-ts/src/types/interrupt.js')
const streamingTs = await import('../../strands-ts/src/models/streaming.js')
const eventsTs = await import('../../strands-ts/src/hooks/events.js')
const toolTs = await import('../../strands-ts/src/tools/tool.js')
const { FunctionTool } = await import('../../strands-ts/src/tools/function-tool.js')
const { Agent } = await import('../../strands-ts/src/agent/agent.js')
const { MockMessageModel } = await import('../../strands-ts/src/__fixtures__/mock-message-model.js')
const { InMemoryStorage } = await import('../../strands-ts/src/storage/in-memory-storage.js')
const { LocalFileStorage } = await import('../../strands-ts/src/storage/local-file-storage.js')
const { namespace } = await import('../../strands-ts/src/storage/storage.js')
const { SessionManager } = await import('../../strands-ts/src/session/session-manager.js')
const { SnapshotStorageAdapter } = await import('../../strands-ts/src/session/snapshot-storage-adapter.js')
const { Stash } = await import('../../strands-ts/src/context-manager/stash.js')
const { ContextManager } = await import('../../strands-ts/src/context-manager/context-manager.js')
const { Interrupt, InterruptState } = await import('../../strands-ts/src/interrupt.js')
const { takeSnapshot: takeMultiAgentSnapshot } = await import('../../strands-ts/src/multiagent/snapshot.js')
const otel = await import('@opentelemetry/api')

const {
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  JsonBlock,
  ReasoningBlock,
  CachePointBlock,
  GuardContentBlock,
  InjectedBlock,
  SummaryBlock,
  UnknownBlock,
} = messagesTs
const { CitationsBlock } = citationsTs
const { AudioBlock, ImageBlock, VideoBlock, DocumentBlock } = mediaTs
const { IMAGE_FORMATS } = await import('../../strands-ts/src/mime.js')
const { InterruptResponseContent } = interruptTypesTs

type AgentInstance = InstanceType<typeof Agent>
/** `input`, when present, is the JSON TS read; `json` is what TS wrote back. */
type Case = { name: string; json: string; input?: string }

// --- Fixture helpers ----------------------------------------------------------------------------

function jsonCase(name: string, value: unknown): Case {
  return { name, json: JSON.stringify(value) }
}

function normalizedCase(name: string, input: unknown, parse: (data: never) => unknown): Case {
  return { name, json: JSON.stringify(parse(input as never)), input: JSON.stringify(input) }
}

/** Like `normalizedCase`, with the input kept as written, so its key order survives. */
function rawInputCase(name: string, input: string, parse: (data: never) => unknown): Case {
  return { name, json: JSON.stringify(parse(JSON.parse(input) as never)), input }
}

function writeArea(area: string, source: string, cases: Case[]): void {
  const names = new Set<string>()
  for (const entry of cases) {
    if (names.has(entry.name)) throw new Error(`duplicate case name ${area}/${entry.name}`)
    names.add(entry.name)
  }
  mkdirSync(FIXTURES, { recursive: true })
  writeFileSync(join(FIXTURES, `${area}.json`), `${JSON.stringify({ source, cases }, null, 2)}\n`)
}

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

const BYTES = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255])
const S3 = { uri: 's3://bucket/key.bin' }
const S3_OWNED = { uri: 's3://bucket/owned.bin', bucketOwner: '123456789012' }

// --- Area 1: messages ---------------------------------------------------------------------------

function citationsBlock(): InstanceType<typeof CitationsBlock> {
  return new CitationsBlock({
    citations: [
      {
        location: { type: 'documentChar', documentIndex: 0, start: 1, end: 12 },
        source: 'doc-0',
        sourceContent: [{ text: 'source text' }],
        title: 'Char doc',
      },
      {
        location: { type: 'documentPage', documentIndex: 1, start: 2, end: 3 },
        source: 'doc-1',
        sourceContent: [{ text: 'page text' }],
        title: 'Page doc',
      },
      {
        location: { type: 'documentChunk', documentIndex: 2, start: 0, end: 4 },
        source: 'doc-2',
        sourceContent: [],
        title: 'Chunk doc',
      },
      {
        location: { type: 'searchResult', searchResultIndex: 3, start: 5, end: 9 },
        source: 'search-3',
        sourceContent: [{ text: 'search text' }],
        title: 'Search result',
      },
      {
        location: { type: 'web', url: 'https://example.com/page', domain: 'example.com' },
        source: 'web-4',
        sourceContent: [{ text: 'web text' }],
        title: 'Web page',
      },
      {
        location: { type: 'web', url: 'https://example.org/' },
        source: 'web-5',
        sourceContent: [],
        title: 'Web page without domain',
      },
    ],
    content: [{ text: 'generated text' }, { text: 'more generated text' }],
  })
}

function blockCases(): [string, { toJSON(): unknown }][] {
  return [
    ['text_block', new TextBlock('Hello, "world"\n\ttab é ☃ \u0001')],
    ['text_block_empty', new TextBlock('')],
    [
      'tool_use_block',
      new ToolUseBlock({
        name: 'get_weather',
        toolUseId: 'tooluse-1',
        input: { city: 'Seattle', days: 3, ratio: 0.25, negative: -7, flag: true, none: null, list: [1, 'two', [3]] },
      }),
    ],
    [
      'tool_use_block_reasoning_signature',
      new ToolUseBlock({ name: 'search', toolUseId: 'tooluse-2', input: {}, reasoningSignature: 'sig-abc' }),
    ],
    [
      'tool_result_block_text',
      new ToolResultBlock({ toolUseId: 'tooluse-1', status: 'success', content: [new TextBlock('Sunny, 22C')] }),
    ],
    [
      'tool_result_block_json',
      new ToolResultBlock({
        toolUseId: 'tooluse-1',
        status: 'success',
        content: [new JsonBlock({ json: { temperature: 22, unit: 'C', tags: ['a', 'b'], nested: { ok: true } } })],
      }),
    ],
    [
      'tool_result_block_json_scalar',
      new ToolResultBlock({ toolUseId: 'tooluse-1', status: 'success', content: [new JsonBlock({ json: 42 })] }),
    ],
    [
      'tool_result_block_image',
      new ToolResultBlock({
        toolUseId: 'tooluse-3',
        status: 'success',
        content: [new ImageBlock({ format: 'png', source: { bytes: BYTES } })],
      }),
    ],
    [
      'tool_result_block_video',
      new ToolResultBlock({
        toolUseId: 'tooluse-3',
        status: 'success',
        content: [new VideoBlock({ format: 'mp4', source: { location: S3 } })],
      }),
    ],
    [
      'tool_result_block_document',
      new ToolResultBlock({
        toolUseId: 'tooluse-4',
        status: 'success',
        content: [new DocumentBlock({ name: 'report', format: 'txt', source: { text: 'report body' } })],
      }),
    ],
    [
      'tool_result_block_error',
      new ToolResultBlock({
        toolUseId: 'tooluse-5',
        status: 'error',
        content: [new TextBlock('Error: boom')],
        error: new Error('boom'),
      }),
    ],
    [
      'tool_result_block_mixed',
      new ToolResultBlock({
        toolUseId: 'tooluse-6',
        status: 'success',
        content: [
          new TextBlock('summary'),
          new JsonBlock({ json: [1, 2, 3] }),
          new ImageBlock({ format: 'jpeg', source: { url: 'https://example.com/a.jpg' } }),
        ],
      }),
    ],
    ['tool_result_block_empty', new ToolResultBlock({ toolUseId: 'tooluse-7', status: 'success', content: [] })],
    ['reasoning_block_text_signature', new ReasoningBlock({ text: 'Let me think.', signature: 'sig-123' })],
    ['reasoning_block_text_only', new ReasoningBlock({ text: 'Only text.' })],
    ['reasoning_block_redacted_content', new ReasoningBlock({ redactedContent: BYTES })],
    ['cache_point_block', new CachePointBlock({ cacheType: 'default' })],
    ['cache_point_block_ttl', new CachePointBlock({ cacheType: 'default', ttl: '1h' })],
    [
      'guard_content_block_text',
      new GuardContentBlock({ text: { qualifiers: ['grounding_source', 'query', 'guard_content'], text: 'check me' } }),
    ],
    ['guard_content_block_image', new GuardContentBlock({ image: { format: 'png', source: { bytes: BYTES } } })],
    ['audio_block_bytes', new AudioBlock({ format: 'mp3', source: { bytes: BYTES } })],
    ['audio_block_s3', new AudioBlock({ format: 'x-aac', source: { location: S3_OWNED } })],
    ['image_block_bytes', new ImageBlock({ format: 'png', source: { bytes: BYTES } })],
    ['image_block_s3', new ImageBlock({ format: 'webp', source: { location: S3 } })],
    ['image_block_s3_bucket_owner', new ImageBlock({ format: 'gif', source: { location: S3_OWNED } })],
    ['image_block_url', new ImageBlock({ format: 'jpg', source: { url: 'https://example.com/image.jpg' } })],
    ['video_block_bytes', new VideoBlock({ format: '3gp', source: { bytes: BYTES } })],
    ['video_block_s3', new VideoBlock({ format: 'mkv', source: { location: S3_OWNED } })],
    [
      'document_block_bytes',
      new DocumentBlock({
        name: 'paper',
        format: 'pdf',
        source: { bytes: BYTES },
        citations: { enabled: true },
        context: 'quarterly figures',
      }),
    ],
    ['document_block_text', new DocumentBlock({ name: 'notes', format: 'md', source: { text: '# Notes' } })],
    [
      'document_block_content',
      new DocumentBlock({
        name: 'structured',
        format: 'txt',
        source: { content: [{ text: 'part one' }, { text: 'part two' }] },
        citations: { enabled: false },
      }),
    ],
    ['document_block_s3', new DocumentBlock({ name: 'sheet', format: 'xlsx', source: { location: S3 } })],
    ['citations_block', citationsBlock()],
    ['injected_block', new InjectedBlock({ text: 'cwd: /repo', source: 'env' })],
    ['summary_block', new SummaryBlock({ text: 'Earlier, the user asked about weather.' })],
    [
      'summary_block_provider_signature',
      new SummaryBlock({ provider: 'anthropic', signature: 'sum-sig', text: 'Server-side summary.' }),
    ],
    ['unknown_block', new UnknownBlock({ futureBlock: { kind: 'hologram', depth: 3, layers: [{ z: 1 }, { z: 2 }] } })],
  ]
}

function messageCases(): Case[] {
  const cases = blockCases().map(([name, block]) => jsonCase(name, block))

  cases.push(jsonCase('message_user_text', new Message({ role: 'user', content: [new TextBlock('Hi there')] })))
  cases.push(
    jsonCase(
      'message_assistant_tool_use',
      new Message({
        role: 'assistant',
        content: [
          new TextBlock('Checking.'),
          new ToolUseBlock({ name: 'get_weather', toolUseId: 'tooluse-1', input: { city: 'Seattle' } }),
        ],
        trackingId: 'caller-supplied-id',
      })
    )
  )
  cases.push(
    jsonCase(
      'message_assistant_metadata',
      new Message({
        role: 'assistant',
        content: [new TextBlock('Done.')],
        metadata: {
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
            cacheReadInputTokens: 100,
            cacheWriteInputTokens: 20,
          },
          metrics: { latencyMs: 812, timeToFirstByteMs: 95 },
          custom: { compressed: true, origin: { strategy: 'summarize', count: 4 } },
        },
      })
    )
  )
  cases.push(
    jsonCase(
      'message_metadata_usage_only',
      new Message({
        role: 'assistant',
        content: [],
        metadata: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      })
    )
  )
  cases.push(
    jsonCase(
      'message_all_blocks',
      new Message({ role: 'user', content: blockCases().map(([, block]) => block) as never })
    )
  )
  cases.push(
    jsonCase(
      'message_from_json_unknown_blocks',
      Message.fromJSON({
        role: 'user',
        content: [
          { text: 'known' },
          { futureBlock: { a: 1 } } as never,
          {
            toolResult: {
              toolUseId: 'tooluse-8',
              status: 'success',
              content: [{ text: 'ok' }, { futureContent: { b: [true, null] } } as never],
            },
          },
        ],
        trackingId: 'restored-id',
      })
    )
  )
  cases.push(...edgeMessageCases())
  return cases
}

const AUDIO_FORMATS = [
  'mp3',
  'opus',
  'wav',
  'aac',
  'flac',
  'mp4',
  'ogg',
  'mkv',
  'mka',
  'x-aac',
  'm4a',
  'mpeg',
  'mpga',
  'pcm',
  'webm',
] as const
const VIDEO_FORMATS = ['mkv', 'mov', 'mp4', 'webm', 'flv', 'mpeg', 'mpg', 'wmv', '3gp'] as const
const DOCUMENT_FORMATS = ['pdf', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'html', 'txt', 'md', 'json', 'xml'] as const

function edgeMessageCases(): Case[] {
  const fromData = messagesTs.contentBlockFromData
  const mediaFormats = new Message({
    role: 'user',
    content: [
      ...AUDIO_FORMATS.map((format) => new AudioBlock({ format, source: { bytes: BYTES } })),
      ...IMAGE_FORMATS.map((format) => new ImageBlock({ format, source: { bytes: BYTES } })),
      ...VIDEO_FORMATS.map((format) => new VideoBlock({ format, source: { bytes: BYTES } })),
      ...DOCUMENT_FORMATS.map((format) => new DocumentBlock({ name: format, format, source: { bytes: BYTES } })),
    ],
    trackingId: 'media-formats',
  })
  return [
    jsonCase('message_media_formats', mediaFormats),
    jsonCase(
      'tool_use_block_number_forms',
      new ToolUseBlock({
        name: 'numbers',
        toolUseId: 'tooluse-numbers',
        input: {
          small: 0.000001,
          tiny: 1e-7,
          big: 1e21,
          maxSafe: 2 ** 53,
          beyondSafe: 2 ** 64,
          sum: 0.1 + 0.2,
          huge: 1.5e300,
          negative: -2.5,
        },
      })
    ),
    jsonCase('text_block_lone_surrogate', new TextBlock('broken \ud83d pair')),
    normalizedCase('reasoning_block_unpadded_base64', { reasoning: { redactedContent: 'AQI' } }, fromData),
    normalizedCase('reasoning_block_url_safe_base64', { reasoning: { redactedContent: '-_8' } }, fromData),
    normalizedCase(
      'image_block_whitespace_base64',
      { image: { format: 'png', source: { bytes: 'AQ ID\nBA==' } } },
      fromData
    ),
    rawInputCase(
      'tool_use_block_integer_like_keys',
      '{"toolUse":{"name":"keys","toolUseId":"tooluse-keys","input":{"10":"ten","2":"two","beta":"b","1":"one","alpha":"a"}}}',
      fromData
    ),
    normalizedCase(
      'summary_block_null_signature',
      { summary: { provider: 'anthropic', signature: null, text: 'summary' } },
      fromData
    ),
  ]
}

// --- Area 2: model stream events ----------------------------------------------------------------

function modelStreamEventCases(): Case[] {
  const {
    ModelMessageStartEvent,
    ModelContentBlockStartEvent,
    ModelContentBlockDeltaEvent,
    ModelContentBlockStopEvent,
    ModelMessageStopEvent,
    ModelMetadataEvent,
    ModelRedactionEvent,
  } = streamingTs
  const citations = citationsBlock()
  const events: [string, unknown][] = [
    ['message_start_user', new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'user' })],
    ['message_start_assistant', new ModelMessageStartEvent({ type: 'modelMessageStartEvent', role: 'assistant' })],
    ['content_block_start_empty', new ModelContentBlockStartEvent({ type: 'modelContentBlockStartEvent' })],
    [
      'content_block_start_tool_use',
      new ModelContentBlockStartEvent({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'get_weather', toolUseId: 'tooluse-1' },
      }),
    ],
    [
      'content_block_start_tool_use_reasoning_signature',
      new ModelContentBlockStartEvent({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'search', toolUseId: 'tooluse-2', reasoningSignature: 'sig' },
      }),
    ],
    [
      'content_block_delta_text',
      new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'Hel' },
      }),
    ],
    [
      'content_block_delta_tool_use_input',
      new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{"city":"Sea' },
      }),
    ],
    [
      'content_block_delta_reasoning_text',
      new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'thinking' },
      }),
    ],
    [
      'content_block_delta_reasoning_signature',
      new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', signature: 'sig-xyz' },
      }),
    ],
    [
      'content_block_delta_citations',
      new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'citationsDelta', citations: citations.citations, content: citations.content },
      }),
    ],
    ['content_block_stop', new ModelContentBlockStopEvent({ type: 'modelContentBlockStopEvent' })],
    ['message_stop_end_turn', new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })],
    [
      'message_stop_additional_fields',
      new ModelMessageStopEvent({
        type: 'modelMessageStopEvent',
        stopReason: 'toolUse',
        additionalModelResponseFields: { thinking: { budget: 1024 }, extra: [1, 'x'] },
      }),
    ],
    [
      'message_stop_unknown_reason',
      new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason: 'providerSpecificReason' }),
    ],
    ['metadata_empty', new ModelMetadataEvent({ type: 'modelMetadataEvent' })],
    [
      'message_stop_additional_fields_null',
      new ModelMessageStopEvent({
        type: 'modelMessageStopEvent',
        stopReason: 'endTurn',
        additionalModelResponseFields: null,
      }),
    ],
    ['metadata_trace_null', new ModelMetadataEvent({ type: 'modelMetadataEvent', trace: null })],
    [
      'content_block_delta_reasoning_redacted_content',
      new ModelContentBlockDeltaEvent({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', redactedContent: new Uint8Array([1, 2, 3]) },
      }),
    ],
    [
      'metadata_full',
      new ModelMetadataEvent({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadInputTokens: 2, cacheWriteInputTokens: 3 },
        metrics: { latencyMs: 250, timeToFirstByteMs: 40 },
        trace: { guardrail: { action: 'NONE' } },
      }),
    ],
    [
      'redaction_input',
      new ModelRedactionEvent({ type: 'modelRedactionEvent', inputRedaction: { replaceContent: '[redacted input]' } }),
    ],
    [
      'redaction_output',
      new ModelRedactionEvent({
        type: 'modelRedactionEvent',
        outputRedaction: { redactedContent: 'secret', replaceContent: '[redacted output]' },
      }),
    ],
    [
      'redaction_output_replace_only',
      new ModelRedactionEvent({ type: 'modelRedactionEvent', outputRedaction: { replaceContent: '[redacted]' } }),
    ],
  ]
  for (const stopReason of STOP_REASONS) {
    events.push([
      `message_stop_${snakeCase(stopReason)}`,
      new ModelMessageStopEvent({ type: 'modelMessageStopEvent', stopReason }),
    ])
  }
  return events.map(([name, value]) => jsonCase(name, value))
}

const STOP_REASONS = [
  'cancelled',
  'checkpoint',
  'contentFiltered',
  'guardrailIntervened',
  'interrupt',
  'maxTokens',
  'limitOutputTokens',
  'limitStructuredOutputAttempts',
  'limitTotalTokens',
  'limitTurns',
  'pauseTurn',
  'refusal',
  'stopSequence',
  'toolUse',
  'modelContextWindowExceeded',
] as const

// --- Shared agent setup -------------------------------------------------------------------------

function weatherTool(): InstanceType<typeof FunctionTool> {
  return new FunctionTool({
    name: 'get_weather',
    description: 'Get the weather for a city',
    inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    callback: async function* (input: unknown) {
      yield { progress: 'looking up' }
      return { city: (input as { city: string }).city, forecast: 'sunny', high: 22 }
    },
  })
}

function scriptedModel(): InstanceType<typeof MockMessageModel> {
  return new MockMessageModel()
    .addTurn(
      [
        { type: 'textBlock', text: 'Let me check.' },
        { type: 'toolUseBlock', name: 'get_weather', toolUseId: 'tooluse-weather-1', input: { city: 'Seattle' } },
      ],
      { usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } }
    )
    .addTurn(
      { type: 'textBlock', text: 'It is sunny in Seattle.' },
      {
        usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
      }
    )
}

function conformanceAgent(extra: Record<string, unknown> = {}): AgentInstance {
  return new Agent({
    model: scriptedModel(),
    tools: [weatherTool()],
    printer: false,
    name: 'conformance_agent',
    id: 'conformance-agent',
    systemPrompt: 'You are a weather assistant.',
    appState: { units: 'metric', visits: 1 },
    ...extra,
  } as never)
}

const HOOK_EVENT_CLASSES = [
  eventsTs.InitializedEvent,
  eventsTs.BeforeInvocationEvent,
  eventsTs.AfterInvocationEvent,
  eventsTs.MessageAddedEvent,
  eventsTs.BeforeToolCallEvent,
  eventsTs.AfterToolCallEvent,
  eventsTs.BeforeModelCallEvent,
  eventsTs.AfterModelCallEvent,
  eventsTs.ModelStreamUpdateEvent,
  eventsTs.ContentBlockEvent,
  eventsTs.ModelMessageEvent,
  eventsTs.ToolResultEvent,
  eventsTs.ToolStreamUpdateEvent,
  eventsTs.AgentResultEvent,
  eventsTs.InterruptEvent,
  eventsTs.BeforeToolsEvent,
  eventsTs.AfterToolsEvent,
] as const

function interruptingTool(): InstanceType<typeof FunctionTool> {
  return new FunctionTool({
    name: 'delete_files',
    description: 'Delete files after confirmation',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    callback: (input: unknown, context) => {
      const answer = context.interrupt({
        name: 'confirm_delete',
        reason: { message: 'Delete these files?', path: (input as { path: string }).path },
      })
      return { deleted: answer === 'yes' }
    },
  })
}

function interruptModel(): InstanceType<typeof MockMessageModel> {
  return new MockMessageModel()
    .addTurn([
      { type: 'toolUseBlock', name: 'get_weather', toolUseId: 'tooluse-weather-2', input: { city: 'Paris' } },
      { type: 'toolUseBlock', name: 'delete_files', toolUseId: 'tooluse-delete-1', input: { path: '/tmp/x' } },
    ])
    .addTurn({ type: 'textBlock', text: 'Deleted.' })
}

function interruptAgent(extra: Record<string, unknown> = {}): AgentInstance {
  return new Agent({
    model: interruptModel(),
    tools: [weatherTool(), interruptingTool()],
    printer: false,
    name: 'interrupt_agent',
    id: 'interrupt-agent',
    ...extra,
  } as never)
}

// --- Area 3: agent stream events ----------------------------------------------------------------

type StreamEventShape = {
  type: string
  event?: { type?: string; delta?: { type: string }; start?: { type: string } }
}

function streamEventKey(event: StreamEventShape): string {
  const parts = [event.type, event.event?.type, event.event?.delta?.type ?? event.event?.start?.type]
  return parts
    .filter((part): part is string => part !== undefined)
    .map(snakeCase)
    .join('_')
}

async function collectStream(agent: AgentInstance, args: unknown, seen: Map<string, string>): Promise<void> {
  for await (const event of agent.stream(args as never)) {
    const key = streamEventKey(event as never)
    if (!seen.has(key)) seen.set(key, JSON.stringify(event))
  }
}

async function agentStreamEventCases(): Promise<Case[]> {
  const seen = new Map<string, string>()
  await collectStream(conformanceAgent(), 'What is the weather in Seattle?', seen)
  await collectStream(interruptAgent(), 'Clean up /tmp/x', seen)

  const agent = conformanceAgent()
  const toolUse = { name: 'get_weather', toolUseId: 'tooluse-err', input: { city: 'Nowhere' } }
  const errorResult = new ToolResultBlock({
    toolUseId: 'tooluse-err',
    status: 'error',
    content: [new TextBlock('Error: city not found')],
  })
  const direct: [string, unknown][] = [
    [
      'after_tool_call_event_error',
      new eventsTs.AfterToolCallEvent({
        agent,
        toolUse,
        tool: undefined,
        result: errorResult,
        invocationState: {},
        error: new Error('city not found'),
      }),
    ],
    [
      'after_model_call_event_error',
      new eventsTs.AfterModelCallEvent({
        agent,
        model: agent.model,
        invocationState: {},
        attemptCount: 2,
        error: new Error('model unavailable'),
      }),
    ],
    [
      'after_model_call_event_redaction',
      new eventsTs.AfterModelCallEvent({
        agent,
        model: agent.model,
        invocationState: {},
        attemptCount: 1,
        stopData: {
          message: new Message({ role: 'assistant', content: [new TextBlock('[redacted]')] }),
          stopReason: 'guardrailIntervened',
          redaction: { userMessage: '[user input redacted]' },
        },
      }),
    ],
    [
      'before_model_call_event_projected_input_tokens',
      new eventsTs.BeforeModelCallEvent({ agent, model: agent.model, invocationState: {}, projectedInputTokens: 1234 }),
    ],
    [
      'tool_stream_update_event_no_data',
      new eventsTs.ToolStreamUpdateEvent({ agent, event: new toolTs.ToolStreamEvent({}), invocationState: {} }),
    ],
  ]

  const cases = [...seen.entries()].map(([name, json]) => ({ name, json }))
  return [...cases, ...direct.map(([name, value]) => jsonCase(name, value))]
}

// --- Area 4: hook events ------------------------------------------------------------------------

async function hookEventCases(): Promise<Case[]> {
  const seen = new Map<string, string>()
  const record = (agent: AgentInstance): void => {
    for (const eventClass of HOOK_EVENT_CLASSES) {
      agent.addHook(eventClass as never, (event: { type: string }) => {
        const key = snakeCase(event.type)
        if (!seen.has(key)) seen.set(key, JSON.stringify(event))
      })
    }
  }
  const agent = conformanceAgent()
  record(agent)
  await agent.invoke('What is the weather in Seattle?')

  const interrupted = interruptAgent()
  record(interrupted)
  await interrupted.invoke('Clean up /tmp/x')

  const missing = HOOK_EVENT_CLASSES.map((eventClass) => snakeCase(eventClass.name)).filter((key) => !seen.has(key))
  if (missing.length > 0) throw new Error(`hook events not observed: ${missing.join(', ')}`)
  return HOOK_EVENT_CLASSES.map((eventClass) => {
    const name = snakeCase(eventClass.name)
    return { name, json: seen.get(name)! }
  })
}

// --- Area 5: snapshots --------------------------------------------------------------------------

async function snapshotCases(): Promise<Case[]> {
  const agent = conformanceAgent()
  await agent.invoke('What is the weather in Seattle?')

  const blockPromptAgent = conformanceAgent({
    systemPrompt: [
      new TextBlock('You are a weather assistant.'),
      new CachePointBlock({ cacheType: 'default' }),
      new GuardContentBlock({ text: { qualifiers: ['guard_content'], text: 'Be safe.' } }),
    ],
  })
  await blockPromptAgent.invoke('What is the weather in Seattle?')

  const noPromptAgent = conformanceAgent({ systemPrompt: undefined })
  await noPromptAgent.invoke('What is the weather in Seattle?')

  return [
    jsonCase('session_preset', agent.takeSnapshot({ preset: 'session' })),
    jsonCase(
      'session_preset_app_data',
      agent.takeSnapshot({ preset: 'session', appData: { release: 'v1', counters: { saves: 2 } } })
    ),
    jsonCase('include_messages_state', agent.takeSnapshot({ include: ['messages', 'state'] })),
    jsonCase(
      'snapshot_multi_agent',
      takeMultiAgentSnapshot({ id: 'conformance-graph' } as never, undefined, { appData: { run: 1 } })
    ),
    jsonCase('session_preset_exclude_interrupts', agent.takeSnapshot({ preset: 'session', exclude: ['interrupts'] })),
    jsonCase('system_prompt_blocks', blockPromptAgent.takeSnapshot({ include: ['systemPrompt'] })),
    jsonCase('system_prompt_absent', noPromptAgent.takeSnapshot({ include: ['systemPrompt', 'modelState'] })),
  ]
}

// --- Area 6: sessions ---------------------------------------------------------------------------

async function storedText(storage: InstanceType<typeof InMemoryStorage>, key: string): Promise<string> {
  const bytes = await storage.read(key)
  if (bytes === null) throw new Error(`missing storage key ${key}`)
  return new TextDecoder().decode(bytes)
}

async function sessionCases(): Promise<Case[]> {
  const storage = new InMemoryStorage()
  const sessionManager = new SessionManager({
    storage,
    sessionId: 'conformance-session',
    snapshotTrigger: () => true,
  })
  const agent = conformanceAgent({ sessionManager })
  await agent.invoke('What is the weather in Seattle?')

  const location = { sessionId: 'conformance-session', scope: 'agent' as const, scopeId: 'conformance-agent' }
  const adapter = new SnapshotStorageAdapter(namespace(storage, 'session'))
  await adapter.saveManifest({ location, manifest: await adapter.loadManifest({ location }) })

  const keys = await storage.list('')
  const prefix = 'session/conformance-session/scopes/agent/conformance-agent/snapshots'
  const historyKey = keys.find((key) => key.startsWith(`${prefix}/immutable_history/`))
  if (historyKey === undefined) throw new Error('no immutable history entry written')

  return [
    jsonCase('storage_keys', [...keys].sort()),
    { name: 'manifest', json: await storedText(storage, `${prefix}/manifest.json`) },
    { name: 'snapshot_latest', json: await storedText(storage, `${prefix}/snapshot_latest.json`) },
    { name: 'immutable_history_entry', json: await storedText(storage, historyKey) },
  ]
}

/**
 * Writes a real session tree: a TS `SessionManager` over `LocalFileStorage` rooted at
 * `fixtures/session-tree/`, after one invocation with a tool call. Rust restores an agent from it.
 */
async function writeSessionTree(): Promise<void> {
  const root = join(FIXTURES, 'session-tree')
  rmSync(root, { recursive: true, force: true })
  const sessionManager = new SessionManager({
    storage: new LocalFileStorage(root),
    sessionId: 'conformance-session',
    snapshotTrigger: () => true,
  })
  const agent = conformanceAgent({ sessionManager })
  await agent.invoke('What is the weather in Seattle?')
}

// --- Area 7: interrupts -------------------------------------------------------------------------

async function interruptCases(): Promise<Case[]> {
  const agent = interruptAgent()
  const raised = await agent.invoke('Clean up /tmp/x')
  const interrupt = raised.interrupts![0]!
  const interruptJson = JSON.stringify(interrupt)
  const raisedJson = JSON.stringify(raised)
  const interruptedSnapshot = agent.takeSnapshot({ preset: 'session' })

  const response = new InterruptResponseContent({ interruptId: interrupt.id, response: 'yes' })
  const resumed = await agent.invoke([response] as never)
  const resumedSnapshot = agent.takeSnapshot({ include: ['interrupts'] })

  const hookAgent = conformanceAgent()
  hookAgent.addHook(eventsTs.BeforeToolCallEvent, (event) => {
    event.interrupt({ name: 'approve_tool', reason: 'Approve get_weather?' })
  })
  const hookRaised = await hookAgent.invoke('What is the weather in Seattle?')

  return [
    { name: 'interrupt_tool', json: interruptJson },
    jsonCase('interrupt_tool_answered', interrupt),
    jsonCase('interrupt_hook', hookRaised.interrupts![0]!),
    jsonCase('interrupt_minimal', new Interrupt({ id: 'interrupt-1', name: 'plain' })),
    jsonCase(
      'interrupt_response_null',
      new Interrupt({ id: 'interrupt-5', name: 'nullable', reason: null, response: null, source: 'tool' })
    ),
    jsonCase('interrupt_state_resume_responses_context', resumedInterruptState()),
    jsonCase(
      'interrupt_with_response',
      new Interrupt({ id: 'interrupt-2', name: 'answered', reason: 'Why?', response: { ok: true }, source: 'tool' })
    ),
    jsonCase(
      'interrupt_multiagent_hook',
      new Interrupt({ id: 'interrupt-3', name: 'node_gate', source: 'multiagent-hook' })
    ),
    jsonCase('interrupt_middleware', new Interrupt({ id: 'interrupt-4', name: 'mw_gate', source: 'middleware' })),
    jsonCase('interrupt_response_content', response),
    jsonCase('interrupt_state_activated', interruptedSnapshot.data.interrupts),
    jsonCase('interrupt_state_after_resume', resumedSnapshot.data.interrupts),
    jsonCase('interrupt_state_hook', hookAgent.takeSnapshot({ include: ['interrupts'] }).data.interrupts),
    jsonCase('snapshot_interrupted', interruptedSnapshot),
    { name: 'agent_result_interrupted', json: raisedJson },
    jsonCase('agent_result_resumed', resumed),
  ]
}

function resumedInterruptState(): unknown {
  const state = new InterruptState()
  state.getOrCreateInterrupt('interrupt-6', 'approve', 'Approve the plan?', undefined, 'tool')
  state.activate()
  state.context = { subAgent: { turn: 2, pending: ['a', 'b'] } }
  state.resume([new InterruptResponseContent({ interruptId: 'interrupt-6', response: { approved: true } })])
  return state.toJSON()
}

// --- Area 8: stash ------------------------------------------------------------------------------

async function stashCases(): Promise<Case[]> {
  const storage = new InMemoryStorage()
  const stash = new Stash(storage, 'conformance-session', 'conformance-agent')
  await stash.storeMessage(
    new Message({
      role: 'user',
      content: [
        new TextBlock('Here is a picture.'),
        new ImageBlock({ format: 'png', source: { bytes: BYTES } }),
        new CachePointBlock({ cacheType: 'default' }),
      ],
      trackingId: 'message-1',
    })
  )
  await stash.storeMessage(
    new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId: 'tooluse-stash-1',
          status: 'success',
          content: [new TextBlock('long tool output'), new JsonBlock({ json: { rows: [1, 2, 3] } })],
        }),
      ],
      trackingId: 'message-2',
    })
  )
  const keys = await storage.list('')
  const entries: Case[] = []
  for (const key of keys) {
    entries.push({ name: `entry_${key.split('/').pop()!.replace(/-/g, '_')}`, json: await storedText(storage, key) })
  }

  const inlineStorage = new InMemoryStorage()
  const inlineAgent = conformanceAgent({
    contextManager: new ContextManager({ stash: { retrievalTool: false } }),
    sessionManager: new SessionManager({ storage: inlineStorage, sessionId: 'stash-inline-session' }),
  })
  await inlineAgent.invoke('What is the weather in Seattle?')
  const inlineLatest = JSON.parse(
    await storedText(
      inlineStorage,
      'session/stash-inline-session/scopes/agent/conformance-agent/snapshots/snapshot_latest.json'
    )
  ) as { data: { stash: unknown } }

  const dir = mkdtempSync(join(tmpdir(), 'strands-conformance-'))
  try {
    const fileStorage = new LocalFileStorage(dir)
    const externalAgent = conformanceAgent({
      contextManager: new ContextManager({ stash: { storage: fileStorage, retrievalTool: false } }),
    })
    await externalAgent.invoke('What is the weather in Seattle?')
    const externalData = await externalStashData(externalAgent)
    return [
      jsonCase('storage_keys', keys),
      ...entries,
      jsonCase('take_snapshot', await stash.takeSnapshot()),
      jsonCase('storage_type_name_in_memory', stash.storageTypeName),
      jsonCase('storage_type_name_local_file', externalAgent.contextManager!.stash!.storageTypeName),
      jsonCase('snapshot_stash_inline', inlineLatest.data.stash),
      jsonCase('snapshot_stash_external', externalData.stash),
    ]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function externalStashData(agent: AgentInstance): Promise<Record<string, unknown>> {
  const storage = new InMemoryStorage()
  const manager = new SessionManager({ storage, sessionId: 'stash-external-session' })
  await manager.saveSnapshot({ target: agent, isLatest: true })
  const text = await storedText(
    storage,
    'session/stash-external-session/scopes/agent/conformance-agent/snapshots/snapshot_latest.json'
  )
  return (JSON.parse(text) as { data: Record<string, unknown> }).data
}

// --- Area 9: metrics and spans ------------------------------------------------------------------

type Instrument = { kind: string; name: string; description?: string; unit?: string }

function recordingMeter(instruments: Instrument[]): unknown {
  const noop = { add: (): void => undefined, record: (): void => undefined }
  const create =
    (kind: string) =>
    (name: string, options?: { description?: string; unit?: string }): typeof noop => {
      instruments.push({
        kind,
        name,
        ...(options?.description !== undefined && { description: options.description }),
        ...(options?.unit !== undefined && { unit: options.unit }),
      })
      return noop
    }
  return {
    createCounter: create('counter'),
    createHistogram: create('histogram'),
    createUpDownCounter: create('upDownCounter'),
    createGauge: create('gauge'),
    createObservableCounter: create('observableCounter'),
    createObservableGauge: create('observableGauge'),
    createObservableUpDownCounter: create('observableUpDownCounter'),
    addBatchObservableCallback: (): void => undefined,
    removeBatchObservableCallback: (): void => undefined,
  }
}

function recordingTracer(spanNames: string[]): unknown {
  return {
    startSpan: (name: string) => {
      spanNames.push(name)
      return otel.trace.wrapSpanContext(otel.INVALID_SPAN_CONTEXT)
    },
    startActiveSpan: (name: string, ...rest: unknown[]) => {
      spanNames.push(name)
      const fn = rest[rest.length - 1] as (span: unknown) => unknown
      return fn(otel.trace.wrapSpanContext(otel.INVALID_SPAN_CONTEXT))
    },
  }
}

async function metricsCases(): Promise<Case[]> {
  const instruments: Instrument[] = []
  const spanNames: string[] = []
  otel.metrics.setGlobalMeterProvider({ getMeter: () => recordingMeter(instruments) } as never)
  otel.trace.setGlobalTracerProvider({ getTracer: () => recordingTracer(spanNames) } as never)

  await conformanceAgent().invoke('What is the weather in Seattle?')

  const uniqueInstruments = [...new Map(instruments.map((entry) => [entry.name, entry])).values()]
  const uniqueSpans = [...new Set(spanNames)]
  return [
    jsonCase('metric_instruments', uniqueInstruments),
    jsonCase(
      'metric_names',
      uniqueInstruments.map((entry) => entry.name)
    ),
    jsonCase('span_names', uniqueSpans),
  ]
}

// --- Area: vended tool specs -------------------------------------------------------------------

const vendedTools = await import('../../strands-ts/src/vended-tools/index.js')
const multiagentSpec = await import('../../strands-ts/src/multiagent/spec.js')

function vendedToolCases(): Case[] {
  const { Choice, Fixed, Option: ChoiceOption, Preset } = multiagentSpec
  const tools: [string, { toolSpec: unknown }][] = [
    ['shell', vendedTools.makeShell()],
    ['shell_default_timeout_300', vendedTools.makeShell({ defaultTimeout: 300 })],
    ['read', vendedTools.read],
    ['read_media_off', vendedTools.makeRead({ media: false })],
    ['write', vendedTools.write],
    ['edit', vendedTools.edit],
    ['file_editor', vendedTools.fileEditor],
    ['bash', vendedTools.bash],
    ['python_repl', vendedTools.pythonRepl],
    ['notebook', vendedTools.notebook],
    ['http_request', vendedTools.httpRequest],
    ['sleep', vendedTools.sleep],
    ['sleep_max_duration_2_5', vendedTools.makeSleep({ maxDuration: 2.5 })],
    ['stop', vendedTools.stop],
    ['stop_max_message_length_100', vendedTools.makeStop({ maxMessageLength: 100 })],
    ['handoff_to_user', vendedTools.handoffToUser],
    ['web_fetch', vendedTools.webFetch],
    ['web_fetch_markdown', vendedTools.makeWebFetch({ mode: 'markdown' })],
    ['subagent', vendedTools.subagent],
    [
      'subagent_choice_axes',
      vendedTools.makeSubagent({
        presets: {
          generalist: vendedTools.GENERALIST,
          reviewer: new Preset({ instructions: 'review', tools: ['read'], model: 'small', description: 'reviews diffs' }),
        },
        instructions: new Fixed(undefined),
        tools: new Choice([new ChoiceOption('readonly', 'read', 'read files'), 'shell'], true),
        model: new Choice(['fast', 'deep']),
        context: new Choice([new ChoiceOption('none', multiagentSpec.UNSET, 'fresh'), 'all', 'no_tools']),
      }),
    ],
  ]
  return tools.map(([name, tool]) => jsonCase(name, tool.toolSpec))
}

// --- Area: harness tool specs ------------------------------------------------------------------

const harnessTools = await import('../../harness-ts/src/tools/index.js')
const harnessSubagent = await import('../../harness-ts/src/tools/subagent.js')
const harnessWebSearch = await import('../../harness-ts/src/tools/web-search.js')
const harnessTodos = await import('../../harness-ts/src/plugins/todos.js')
const harnessPrompt = await import('../../harness-ts/src/prompt.js')

function harnessToolCases(): Case[] {
  const { Choice, GENERALIST, CONTEXT_MODES, Option: ChoiceOption, Preset, makeSubagent } = harnessSubagent
  const builder = (() => undefined) as never
  const tools: [string, { toolSpec: unknown }][] = [
    ['read', harnessTools.read],
    ['read_media_off', harnessTools.makeRead({ media: false })],
    ['write', harnessTools.write],
    ['edit', harnessTools.edit],
    ['web_fetch', harnessTools.makeWebFetch({ model: {} as never })],
    ['web_search', harnessWebSearch.exaWebSearch],
    ['programmatic_tool_caller', harnessTools.programmaticToolCaller],
    ['programmatic_tool_caller_named', harnessTools.makeProgrammaticToolCaller({ name: 'run_code' })],
    ['todo_write', new harnessTodos.Todos().getTools()[0]!],
    [
      'subagent_default_harness',
      makeSubagent({
        builder,
        presets: { generalist: GENERALIST },
        inheritedTools: ['shell', 'read'],
        inheritedMcpServers: ['docs'],
        context: new Choice([...CONTEXT_MODES]),
      }),
    ],
    ['subagent_bare', makeSubagent({ builder })],
    [
      'subagent_choice_axes',
      makeSubagent({
        builder,
        presets: {
          generalist: GENERALIST,
          reviewer: new Preset({ instructions: 'review', tools: ['read'], description: 'reviews diffs' }),
        },
        instructions: new Choice([
          new ChoiceOption('poet', { value: 'You are a poet.', description: 'writes verse' }),
          'plain',
        ]),
        tools: new Choice([new ChoiceOption('readonly', { value: 'read', description: 'read files' }), 'shell'], true),
        model: new Choice(['fast', 'deep']),
        context: new Choice([new ChoiceOption('fresh', { value: 'none', description: 'start over' }), 'all']),
        name: 'delegate',
      }),
    ],
  ]
  return tools.map(([name, tool]) => jsonCase(name, tool.toolSpec))
}

// --- Main ---------------------------------------------------------------------------------------

writeArea('messages', 'strands-ts/src/types/messages.ts', messageCases())
writeArea('model_stream_events', 'strands-ts/src/models/streaming.ts', modelStreamEventCases())
writeArea('agent_stream_events', 'strands-ts/src/types/agent.ts', await agentStreamEventCases())
writeArea('hook_events', 'strands-ts/src/hooks/events.ts', await hookEventCases())
writeArea('snapshots', 'strands-ts/src/agent/snapshot.ts', await snapshotCases())
writeArea('sessions', 'strands-ts/src/session/session-manager.ts', await sessionCases())
writeArea('interrupts', 'strands-ts/src/interrupt.ts', await interruptCases())
writeArea('stash', 'strands-ts/src/context-manager/stash.ts', await stashCases())
writeArea('metrics', 'strands-ts/src/telemetry/meter.ts', await metricsCases())
writeArea('vended_tools', 'strands-ts/src/vended-tools/index.ts', vendedToolCases())
writeArea('harness_tools', 'harness-ts/src/tools/index.ts', harnessToolCases())
writeArea('harness_prompt', 'harness-ts/src/prompt.ts', [jsonCase('contract', harnessPrompt.HARNESS_CONTRACT)])
// Last, so the clock, id and random sequences of the fixtures above stay as they were.
await writeSessionTree()
