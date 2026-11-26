import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type Agent,
  configureLogging as configureSdkLogging,
  type ContentBlockData,
  type Logger,
  type Message,
  type Model,
  type StreamOptions,
  type ToolSpec,
  type Usage,
} from '@strands-agents/sdk'

import { configureLogging } from '../../src/logging.js'

/** What a provider sees of a message: role and content, without tracking ids or usage metadata. */
export interface WireMessage {
  role: string
  content: ContentBlockData[]
}

export interface ModelCall {
  /** Index of the model object, in `attach` order. */
  model: number
  modelId: string | undefined
  systemPrompt: unknown
  toolSpecs: ToolSpec[] | undefined
  /** A summary or memory-extraction request rather than a request of the agent loop. */
  auxiliary: boolean
  messages: WireMessage[]
  /** Trailing blocks of the last message that injectors added for this request only. */
  dynamicTrailingBlocks: number
  usage?: Usage
  stopReason?: string
  error?: string
  /** A failed attempt the SDK repeated: the next call on the same model sent the same request and did not fail. */
  retried?: boolean
}

export interface LogRecord {
  level: 'warn' | 'error'
  message: string
}

const copy = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

export const wire = (messages: readonly Message[]): WireMessage[] =>
  messages.map(({ role, content }) => copy({ role, content })) as unknown as WireMessage[]

const request = ({ modelId, systemPrompt, toolSpecs, messages, dynamicTrailingBlocks }: ModelCall): string =>
  JSON.stringify([modelId, systemPrompt, toolSpecs, messages, dynamicTrailingBlocks])

export class Recording {
  readonly calls: ModelCall[] = []
  readonly logs: LogRecord[] = []
  private _models = 0

  constructor() {
    const sink =
      (level: LogRecord['level']) =>
      (...args: unknown[]) => {
        this.logs.push({ level, message: args.map(String).join(' ') })
      }
    const logger: Logger = { debug: () => {}, info: () => {}, warn: sink('warn'), error: sink('error') }
    configureSdkLogging(logger)
    configureLogging(logger)
  }

  /** Records every `stream` call on `model` by wrapping the method on the instance. */
  attach(model: Model): void {
    const index = this._models++
    const stream = model.stream.bind(model)
    const summarize = model.summarize.bind(model)
    const calls = this.calls
    let previous: ModelCall | undefined
    let summarizing = false
    model.summarize = async (...args) => {
      summarizing = true
      try {
        return await summarize(...args)
      } finally {
        summarizing = false
      }
    }
    model.stream = async function* (messages: Message[], options?: StreamOptions) {
      const call: ModelCall = {
        model: index,
        modelId: model.modelId,
        systemPrompt: copy(options?.systemPrompt),
        toolSpecs: copy(options?.toolSpecs),
        // The agent loop always sends tool specs; a memory-extraction request sends none.
        auxiliary: summarizing || options?.toolSpecs === undefined,
        messages: wire(messages),
        dynamicTrailingBlocks: options?.dynamicTrailingBlocks ?? 0,
      }
      calls.push(call)
      // The SDK re-sends a throttled request as is, so a failed attempt followed by its twin was retried.
      if (previous?.error !== undefined && request(previous) === request(call)) {
        previous.retried = true
      }
      previous = call
      try {
        for await (const event of stream(messages, options)) {
          if (event.type === 'modelMetadataEvent' && event.usage) {
            call.usage = copy(event.usage)
          }
          if (event.type === 'modelMessageStopEvent') {
            call.stopReason = event.stopReason
          }
          yield event
        }
      } catch (error) {
        call.error = String(error)
        throw error
      }
    }
  }

  /** The agent loop's requests: every call except the auxiliary ones and the attempts the SDK retried. */
  get loopCalls(): ModelCall[] {
    return this.calls.filter((call) => !call.auxiliary && !call.retried)
  }

  dump(path: string): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ calls: this.calls, logs: this.logs }, null, 2))
  }
}

export function record(agent: Agent): Recording {
  const recording = new Recording()
  recording.attach(agent.model)
  return recording
}

export interface Expectations {
  /** Tool names whose results may carry error status. */
  allowedToolErrors?: string[]
  /** Exactly how many requests do not extend the previous request on the same model (a compaction). */
  prefixBreaks?: number
  /** Exactly how many requests carry no tool specs (compaction summaries, memory extraction). */
  auxiliaryCalls?: number
}

const toolUses = (message: WireMessage | undefined): Array<{ toolUseId: string; name: string }> =>
  (message?.content ?? []).flatMap((block) => ('toolUse' in block ? [block.toolUse] : []))

const toolResults = (message: WireMessage | undefined): Array<{ toolUseId: string; status: string }> =>
  (message?.content ?? []).flatMap((block) => ('toolResult' in block ? [block.toolResult] : []))

/** Tool uses without exactly one result in the next message, and results without their tool use. */
function pairingViolations(where: string, messages: WireMessage[]): string[] {
  const violations: string[] = []
  for (const [index, message] of messages.entries()) {
    const uses = message.role === 'assistant' ? toolUses(message) : []
    const results = messages[index + 1]?.role === 'user' ? toolResults(messages[index + 1]) : []
    for (const use of uses) {
      const count = results.filter((result) => result.toolUseId === use.toolUseId).length
      if (count !== 1) {
        violations.push(`${where}: toolUse ${use.name} (${use.toolUseId}) has ${count} results in the next message`)
      }
    }
    for (const result of toolResults(messages[index + 1])) {
      if (!uses.some((use) => use.toolUseId === result.toolUseId)) {
        violations.push(`${where}: toolResult ${result.toolUseId} has no toolUse in the previous message`)
      }
    }
  }
  if (toolResults(messages[0]).length > 0) {
    violations.push(`${where}: the first message carries a toolResult`)
  }
  return violations
}

/** The tool uses, as `name (id)`, whose result has error status. */
function failedTools(messages: WireMessage[], allowedToolErrors: string[]): string[] {
  const failed = new Set(
    messages
      .flatMap((message) => toolResults(message).filter((result) => result.status === 'error'))
      .map((result) => result.toolUseId)
  )
  return messages
    .flatMap(toolUses)
    .filter((use) => failed.has(use.toolUseId) && !allowedToolErrors.includes(use.name))
    .map((use) => `${use.name} (${use.toolUseId})`)
}

/** The part of a request a provider can cache: everything before the per-request injected blocks. */
export function stablePrefix(call: ModelCall): WireMessage[] {
  const last = call.messages.at(-1)
  if (last === undefined || call.dynamicTrailingBlocks === 0) {
    return call.messages
  }
  return [...call.messages.slice(0, -1), { ...last, content: last.content.slice(0, -call.dynamicTrailingBlocks) }]
}

/** Indexes of the requests whose stable prefix does not extend the previous request on the same model object. */
export function prefixBreaks(recording: Recording): number[] {
  const breaks: number[] = []
  const previous = new Map<number, WireMessage[]>()
  for (const call of recording.loopCalls) {
    const earlier = previous.get(call.model)
    const later = stablePrefix(call)
    if (earlier !== undefined && JSON.stringify(later.slice(0, earlier.length)) !== JSON.stringify(earlier)) {
      breaks.push(recording.calls.indexOf(call))
    }
    previous.set(call.model, later)
  }
  return breaks
}

/** Throws one error listing every violated invariant. */
export function checkInvariants(
  recording: Recording,
  agent: Agent,
  { allowedToolErrors = [], prefixBreaks: expectedBreaks = 0, auxiliaryCalls = 0 }: Expectations = {}
): void {
  const { calls, loopCalls } = recording
  const violations = pairingViolations('agent.messages', wire(agent.messages))
  const failed = new Set(failedTools(wire(agent.messages), allowedToolErrors))
  const previous = new Map<number, ModelCall>()
  if (loopCalls.length === 0) {
    violations.push('no agent-loop request was recorded, so nothing was checked')
  }

  for (const [index, call] of loopCalls.entries()) {
    const where = `request ${calls.indexOf(call)}`
    violations.push(...pairingViolations(where, call.messages))
    failedTools(call.messages, allowedToolErrors).forEach((tool) => failed.add(tool))

    // A request is the last of its turn unless the next one answers its tool uses.
    const continued = toolResults(loopCalls[index + 1]?.messages.at(-1)).length > 0
    if (!continued && call.stopReason !== 'endTurn') {
      violations.push(`${where}: the turn stopped with ${call.stopReason}, not endTurn`)
    }

    const earlier = previous.get(call.model)
    previous.set(call.model, call)
    if (earlier && JSON.stringify(call.systemPrompt) !== JSON.stringify(earlier.systemPrompt)) {
      violations.push(`${where}: the system prompt changed on model ${call.modelId}`)
    }
    if (earlier && JSON.stringify(call.toolSpecs) !== JSON.stringify(earlier.toolSpecs)) {
      violations.push(`${where}: the tool specs changed on model ${call.modelId}`)
    }
  }

  violations.push(...[...failed].map((tool) => `tool ${tool} failed`))
  for (const [index, call] of calls.entries()) {
    if (call.error !== undefined && !call.retried) {
      violations.push(`request ${index}: the stream raised ${call.error}`)
    }
  }
  for (const log of recording.logs) {
    if (log.level === 'error') {
      violations.push(`error log: ${log.message}`)
    }
  }

  const auxiliary = calls.flatMap((call, index) => (call.auxiliary && !call.retried ? [index] : []))
  if (auxiliary.length !== auxiliaryCalls) {
    violations.push(
      `expected ${auxiliaryCalls} auxiliary request(s) (summary, memory extraction), ` +
        `requests ${auxiliary.join(', ') || 'none'} were`
    )
  }

  const breaks = prefixBreaks(recording)
  if (breaks.length !== expectedBreaks) {
    violations.push(
      `expected ${expectedBreaks} request(s) that rewrite earlier messages (a provider prompt-cache miss), ` +
        `got ${breaks.length}: requests ${breaks.join(', ') || 'none'}`
    )
  }

  if (violations.length > 0) {
    throw new Error(`${violations.length} invariant violation(s):\n- ${violations.join('\n- ')}`)
  }
}
