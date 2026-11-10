import type { Message } from '@strands-agents/sdk'

import { readPeerMessageMetadata } from '../messaging.js'
import { visibleDesktopPrompt } from '../session/desktop-profile.js'
import { limitShellOutputChunk, SHELL_OUTPUT_LIMIT_NOTICE } from '../terminal/shell-output.js'
import { errorMessage, sanitizeTerminalText, sanitizeTerminalValue } from '../terminal/sanitize.js'
import { projectMediaContent, projectS3Location, projectToolResultContent } from './sdk-projector.js'
import type {
  ChatDocumentSource,
  ChatEntry,
  ChatEvent,
  ChatImageSource,
  ChatMediaContent,
  ChatRunResult,
  ChatToolResultContent,
  ChatTurn,
  ChatVideoSource,
  TokenUsage,
} from './types.js'

type MutableTextEntry = Extract<ChatEntry, { type: 'reasoning' | 'assistant' }>

interface MutableToolEntry extends Omit<Extract<ChatEntry, { type: 'tool' }>, 'result'> {
  result?: ChatToolResultContent[]
  streamedOutputBytes?: number
  streamedOutputLimited?: boolean
}

type MutableChatEntry = Exclude<ChatEntry, { type: 'tool' }> | MutableToolEntry

interface MutableChatTurn extends Omit<ChatTurn, 'entries'> {
  entries: MutableChatEntry[]
  nextEntry: number
}

export class TurnProjector {
  private readonly _turn: MutableChatTurn
  private readonly _startedAt = Date.now()

  constructor(
    id: string,
    prompt: string,
    agentName = 'Strands harness',
    source?: ChatTurn['source'],
    peer?: ChatTurn['peer']
  ) {
    this._turn = {
      id,
      prompt: sanitizeTerminalText(prompt),
      agentName: sanitizeTerminalText(agentName),
      ...(source ? { source } : {}),
      ...(peer ? { peer: { ...peer } } : {}),
      entries: [],
      status: 'running',
      nextEntry: 1,
    }
  }

  handle(event: ChatEvent): void {
    switch (event.type) {
      case 'reasoningDelta':
        appendText(this._turn, 'reasoning', event.text)
        break
      case 'textDelta':
        appendText(this._turn, 'assistant', event.text)
        break
      case 'media':
        this._turn.entries.push({
          id: this._entryId(),
          type: 'media',
          content: ownMediaContent(event.content),
        })
        break
      case 'toolStart':
        this._startTool(event)
        break
      case 'toolOutputDelta':
        this._appendToolOutput(event)
        break
      case 'toolResult':
        this._finishTool(event)
        break
      case 'tasks':
      case 'context':
      case 'permission':
        break
    }
  }

  markCancelled(): void {
    this._finishTiming()
    this._turn.status = 'cancelled'
    this._settleRunningTools('cancelled')
  }

  setUsage(usage: TokenUsage): void {
    this._turn.usage = { ...usage }
  }

  finish(result: ChatRunResult): void {
    this._finishTiming()
    if (this._turn.status === 'cancelled') {
      this._turn.stopReason = 'cancelled'
      if (result.usage) {
        this._turn.usage = { ...result.usage }
      }
      return
    }
    if (result.finalReasoning !== undefined) {
      this._reconcileFinalText('reasoning', result.finalReasoning)
    }
    if (result.finalText !== undefined) {
      this._reconcileFinalText('assistant', result.finalText)
    }
    this._turn.stopReason = sanitizeTerminalText(result.stopReason)
    this._turn.status = result.stopReason === 'cancelled' ? 'cancelled' : 'complete'
    this._settleRunningTools(
      result.stopReason === 'cancelled' ? 'cancelled' : 'error',
      result.stopReason === 'cancelled' ? undefined : 'Tool did not return a result before the turn ended.'
    )
    if (result.usage) {
      this._turn.usage = { ...result.usage }
    }
  }

  fail(error: unknown): void {
    this._finishTiming()
    if (this._turn.status === 'cancelled') {
      this._settleRunningTools('cancelled')
      return
    }
    this._turn.status = 'error'
    this._turn.error = errorMessage(error)
    this._settleRunningTools('error', this._turn.error)
  }

  snapshot(): ChatTurn {
    return {
      id: this._turn.id,
      prompt: this._turn.prompt,
      agentName: this._turn.agentName,
      ...(this._turn.source ? { source: this._turn.source } : {}),
      ...(this._turn.peer ? { peer: { ...this._turn.peer } } : {}),
      entries: this._turn.entries.map(cloneChatEntry),
      status: this._turn.status,
      ...(this._turn.durationMs !== undefined ? { durationMs: this._turn.durationMs } : {}),
      ...(this._turn.usage ? { usage: { ...this._turn.usage } } : {}),
      ...(this._turn.stopReason ? { stopReason: this._turn.stopReason } : {}),
      ...(this._turn.error ? { error: this._turn.error } : {}),
    }
  }

  private _finishTiming(): void {
    this._turn.durationMs ??= Math.max(0, Date.now() - this._startedAt)
  }

  private _reconcileFinalText(type: MutableTextEntry['type'], text: string): void {
    const clean = sanitizeTerminalText(text)
    let lastTool = -1
    for (let index = this._turn.entries.length - 1; index >= 0; index--) {
      if (this._turn.entries[index]?.type === 'tool') {
        lastTool = index
        break
      }
    }
    const candidates = this._turn.entries
      .slice(lastTool + 1)
      .filter((entry): entry is MutableTextEntry => entry.type === type)

    if (candidates.length === 1) {
      candidates[0]!.text = clean
    } else if (candidates.length === 0 && clean) {
      this._turn.entries.push({ id: this._entryId(), type, text: clean })
    }
  }

  private _startTool(event: Extract<ChatEvent, { type: 'toolStart' }>): void {
    const toolUseId = sanitizeTerminalText(event.toolUseId)
    const existing = this._findTool(toolUseId)
    if (existing) {
      existing.name = sanitizeTerminalText(event.name)
      existing.input = sanitizeTerminalValue(event.input)
      existing.status = 'running'
      if (event.background === true) {
        existing.background = true
      }
      delete existing.result
      delete existing.error
      delete existing.streamedOutputBytes
      delete existing.streamedOutputLimited
      return
    }

    this._turn.entries.push({
      id: this._entryId(),
      type: 'tool',
      toolUseId,
      name: sanitizeTerminalText(event.name),
      input: sanitizeTerminalValue(event.input),
      status: 'running',
      ...(event.background === true ? { background: true } : {}),
    })
  }

  private _appendToolOutput(event: Extract<ChatEvent, { type: 'toolOutputDelta' }>): void {
    const text = sanitizeTerminalText(event.text)
    if (!text) {
      return
    }
    const reportsOutputLimit = text.endsWith(SHELL_OUTPUT_LIMIT_NOTICE)
    const output = reportsOutputLimit ? text.slice(0, -SHELL_OUTPUT_LIMIT_NOTICE.length) : text
    const toolUseId = sanitizeTerminalText(event.toolUseId)
    const tool = this._findTool(toolUseId) ?? this._missingTool(toolUseId, 'shell')
    if (tool.streamedOutputLimited) {
      return
    }
    const limited = limitShellOutputChunk(output, tool.streamedOutputBytes ?? 0)
    tool.streamedOutputBytes = (tool.streamedOutputBytes ?? 0) + limited.bytes
    tool.streamedOutputLimited = limited.truncated || reportsOutputLimit
    const visible = tool.streamedOutputLimited ? `${limited.text}${SHELL_OUTPUT_LIMIT_NOTICE}` : limited.text
    const previous = tool.result?.at(-1)
    if (previous?.type === 'text') {
      previous.text += visible
      return
    }
    tool.result ??= []
    tool.result.push({ type: 'text', text: visible })
  }

  private _finishTool(event: Extract<ChatEvent, { type: 'toolResult' }>): void {
    const toolUseId = sanitizeTerminalText(event.toolUseId)
    const tool = this._findTool(toolUseId) ?? this._missingTool(toolUseId, 'tool')

    tool.status = event.status
    if (event.content.length > 0) {
      tool.result = event.content.map(ownToolResultContent)
    }
    if (event.error) {
      tool.error = sanitizeTerminalText(event.error)
    }
  }

  private _missingTool(toolUseId: string, name: string): MutableToolEntry {
    const tool: MutableToolEntry = {
      id: this._entryId(),
      type: 'tool',
      toolUseId,
      name,
      input: {},
      status: 'running',
    }
    this._turn.entries.push(tool)
    return tool
  }

  private _findTool(toolUseId: string): MutableToolEntry | undefined {
    return this._turn.entries.find(
      (entry): entry is MutableToolEntry => entry.type === 'tool' && entry.toolUseId === toolUseId
    )
  }

  private _settleRunningTools(status: 'error' | 'cancelled', error?: string): void {
    for (const entry of this._turn.entries) {
      if (entry.type !== 'tool' || entry.status !== 'running') {
        continue
      }
      entry.status = status
      if (error) {
        entry.error = error
      }
    }
  }

  private _entryId(): string {
    return `${this._turn.id}:${this._turn.nextEntry++}`
  }
}

export function projectMessages(messages: readonly Message[], agentName = 'Strands harness'): ChatTurn[] {
  const turns: ChatTurn[] = []
  let current:
    | (Pick<ChatTurn, 'id' | 'prompt' | 'source' | 'peer' | 'usage'> & {
        entries: ChatEntry[]
        nextEntry: number
        tools: Map<string, Extract<ChatEntry, { type: 'tool' }>>
      })
    | undefined

  const ensureTurn = (prompt = 'Restored conversation'): NonNullable<typeof current> => {
    if (!current) {
      current = {
        id: `restored-${turns.length + 1}`,
        prompt,
        entries: [],
        nextEntry: 1,
        tools: new Map(),
      }
    }
    return current
  }
  const finish = (): void => {
    if (!current) {
      return
    }
    turns.push({
      id: current.id,
      prompt: current.prompt,
      agentName: sanitizeTerminalText(agentName),
      ...(current.source ? { source: current.source } : {}),
      ...(current.peer ? { peer: { ...current.peer } } : {}),
      entries: current.entries,
      status: 'complete',
      ...(current.usage ? { usage: current.usage } : {}),
    })
    current = undefined
  }
  for (const message of messages) {
    if (message.role === 'user') {
      const peerMessage = readPeerMessageMetadata(message.metadata?.custom)
      const restoredText = message.content
        .filter((block) => block.type === 'textBlock')
        .map((block) => sanitizeTerminalText(block.text))
        .join('\n')
        .trim()
      const prompt =
        (peerMessage ? sanitizeTerminalText(peerMessage.body).trim() : undefined) ?? visibleDesktopPrompt(restoredText)
      if (prompt) {
        finish()
        const turn = ensureTurn(prompt)
        if (peerMessage) {
          turn.source = 'peer'
          turn.peer = {
            id: sanitizeTerminalText(peerMessage.from.id),
            name: sanitizeTerminalText(peerMessage.from.name),
          }
        }
      }
      const turn = current
      if (!turn) {
        continue
      }
      for (const block of message.content) {
        if (block.type !== 'toolResultBlock') {
          continue
        }
        const toolUseId = sanitizeTerminalText(block.toolUseId)
        let tool = turn.tools.get(toolUseId)
        if (!tool) {
          tool = {
            id: `${turn.id}:${turn.nextEntry++}`,
            type: 'tool',
            toolUseId,
            name: 'tool',
            input: {},
            status: block.status,
          }
          turn.entries.push(tool)
          turn.tools.set(toolUseId, tool)
        }
        tool.status = block.status
        tool.result = block.content.map(projectToolResultContent)
      }
      continue
    }

    const turn = ensureTurn()
    for (const block of message.content) {
      if (block.type === 'reasoningBlock' && block.text) {
        appendText(turn, 'reasoning', block.text)
      } else if (block.type === 'textBlock') {
        appendText(turn, 'assistant', block.text)
      } else if (block.type === 'toolUseBlock') {
        const toolUseId = sanitizeTerminalText(block.toolUseId)
        const tool: Extract<ChatEntry, { type: 'tool' }> = {
          id: `${turn.id}:${turn.nextEntry++}`,
          type: 'tool',
          toolUseId,
          name: sanitizeTerminalText(block.name),
          input: sanitizeTerminalValue(block.input),
          status: 'running',
        }
        turn.entries.push(tool)
        turn.tools.set(toolUseId, tool)
      } else {
        const media = projectMediaContent(block)
        if (media) {
          turn.entries.push({ id: `${turn.id}:${turn.nextEntry++}`, type: 'media', content: media })
        }
      }
    }
    const usage = message.metadata?.usage
    if (usage) {
      turn.usage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
      }
    }
  }
  finish()
  return turns
}

function appendText(
  turn: { id: string; entries: ChatEntry[]; nextEntry: number },
  type: MutableTextEntry['type'],
  text: string
): void {
  const clean = sanitizeTerminalText(text)
  if (!clean) {
    return
  }
  const previous = turn.entries.at(-1)
  if (previous?.type === type) {
    previous.text += clean
  } else {
    turn.entries.push({ id: `${turn.id}:${turn.nextEntry++}`, type, text: clean })
  }
}

function cloneChatEntry(entry: MutableChatEntry): ChatEntry {
  switch (entry.type) {
    case 'reasoning':
    case 'assistant':
      return { ...entry }
    case 'media':
      return { id: entry.id, type: 'media', content: cloneMediaContent(entry.content) }
    case 'tool':
      return {
        id: entry.id,
        type: 'tool',
        toolUseId: sanitizeTerminalText(entry.toolUseId),
        name: entry.name,
        input: sanitizeTerminalValue(entry.input),
        status: entry.status,
        ...(entry.background === true ? { background: true } : {}),
        ...(entry.result ? { result: entry.result.map(cloneToolResultContent) } : {}),
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      }
  }
}

function cloneToolResultContent(content: ChatToolResultContent): ChatToolResultContent {
  switch (content.type) {
    case 'text':
      return { type: 'text', text: sanitizeTerminalText(content.text) }
    case 'json':
      return { type: 'json', value: sanitizeTerminalValue(content.value) }
    case 'image':
    case 'video':
    case 'document':
      return cloneMediaContent(content)
  }
}

function ownToolResultContent(content: ChatToolResultContent): ChatToolResultContent {
  switch (content.type) {
    case 'image':
    case 'video':
    case 'document':
      return ownMediaContent(content)
    default:
      return cloneToolResultContent(content)
  }
}

function cloneMediaContent(content: ChatMediaContent): ChatMediaContent {
  switch (content.type) {
    case 'image':
      return { type: 'image', format: content.format, source: cloneImageSource(content.source) }
    case 'video':
      return { type: 'video', format: content.format, source: cloneBinarySource(content.source) }
    case 'document':
      return {
        type: 'document',
        name: sanitizeTerminalText(content.name),
        format: content.format,
        source: cloneDocumentSource(content.source),
        ...(content.citations ? { citations: { ...content.citations } } : {}),
        ...(content.context !== undefined ? { context: sanitizeTerminalText(content.context) } : {}),
      }
  }
}

function ownMediaContent(content: ChatMediaContent): ChatMediaContent {
  const cloned = cloneMediaContent(content)
  if (cloned.source.type === 'bytes') {
    return { ...cloned, source: { type: 'bytes', bytes: new Uint8Array(cloned.source.bytes) } }
  }
  return cloned
}

function cloneImageSource(source: ChatImageSource): ChatImageSource {
  if (source.type === 'url') {
    return { type: 'url', url: sanitizeTerminalText(source.url) }
  }
  return cloneBinarySource(source)
}

function cloneBinarySource(source: ChatVideoSource): ChatVideoSource {
  switch (source.type) {
    case 'bytes':
      return { type: 'bytes', bytes: source.bytes }
    case 's3':
      return { type: 's3', location: projectS3Location(source.location) }
  }
}

function cloneDocumentSource(source: ChatDocumentSource): ChatDocumentSource {
  switch (source.type) {
    case 'text':
      return { type: 'text', text: sanitizeTerminalText(source.text) }
    case 'content':
      return { type: 'content', content: source.content.map(sanitizeTerminalText) }
    default:
      return cloneBinarySource(source)
  }
}
