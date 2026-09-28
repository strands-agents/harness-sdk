import type {
  Agent,
  AgentResult,
  AgentStreamEvent,
  ContentBlock,
  JSONValue,
  ToolResultContent,
  Usage,
} from '@strands-agents/sdk'

import {
  type ChatContextUsage,
  type ChatEvent,
  type ChatMediaContent,
  type ChatRunResult,
  type ChatS3Location,
  type ChatToolResultContent,
  type TokenUsage,
} from './types.js'
import { sanitizeTerminalText, sanitizeTerminalValue } from '../terminal/sanitize.js'
import { latestResultModelUsage, normalizeUsage, type NormalizedUsage } from '../../usage.js'
import { contextWindowLimit } from '../model/context.js'

interface ProjectAgentEventOptions {
  alwaysBackgroundTools?: ReadonlySet<string>
}

export function projectAgentEvent(event: AgentStreamEvent, options: ProjectAgentEventOptions = {}): ChatEvent[] {
  if (event.type === 'modelStreamUpdateEvent') {
    const inner = event.event
    if (inner.type !== 'modelContentBlockDeltaEvent') {
      return []
    }
    if (inner.delta.type === 'reasoningContentDelta' && inner.delta.text) {
      return [{ type: 'reasoningDelta', text: sanitizeTerminalText(inner.delta.text) }]
    }
    if (inner.delta.type === 'textDelta' && inner.delta.text) {
      return [{ type: 'textDelta', text: sanitizeTerminalText(inner.delta.text) }]
    }
    return []
  }

  const toolUse =
    event.type === 'beforeToolCallEvent'
      ? event.toolUse
      : event.type === 'contentBlockEvent' && event.contentBlock.type === 'toolUseBlock'
        ? event.contentBlock
        : undefined
  if (toolUse) {
    return [
      {
        type: 'toolStart',
        toolUseId: sanitizeTerminalText(toolUse.toolUseId),
        name: sanitizeTerminalText(toolUse.name),
        input: sanitizeTerminalValue(toolUse.input),
        ...(isBackgroundToolCall(toolUse.name, toolUse.input, options) ? { background: true } : {}),
      },
    ]
  }

  if (event.type === 'contentBlockEvent') {
    const content = projectMediaContent(event.contentBlock)
    return content ? [{ type: 'media', content }] : []
  }

  if (event.type === 'toolResultEvent') {
    return [
      {
        type: 'toolResult',
        toolUseId: sanitizeTerminalText(event.result.toolUseId),
        status: event.result.status,
        content: event.result.content.map(projectToolResultContent),
        ...(event.result.error ? { error: sanitizeTerminalText(event.result.error.message) } : {}),
      },
    ]
  }

  return []
}

function isBackgroundToolCall(name: string, input: JSONValue, options: ProjectAgentEventOptions): boolean {
  if (options.alwaysBackgroundTools?.has(name)) {
    return true
  }
  return input !== null && typeof input === 'object' && !Array.isArray(input) && input._background_execution === true
}

export function projectAgentResult(
  agent: Agent,
  result: AgentResult,
  latestModelUsage?: Usage,
  runUsage?: NormalizedUsage
): ChatRunResult {
  const usage = projectUsage(agent, result, runUsage)
  const context = projectContext(agent, result, usage, latestModelUsage)
  const finalContent = projectFinalContent(result)
  return {
    stopReason: sanitizeTerminalText(result.stopReason),
    ...(usage ? { usage } : {}),
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...finalContent,
  }
}

function projectFinalContent(result: AgentResult): Pick<ChatRunResult, 'finalText' | 'finalReasoning'> {
  if (result.lastMessage?.role !== 'assistant') {
    return {}
  }
  const text = result.lastMessage.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])).join('')
  const reasoning = result.lastMessage.content
    .flatMap((block) => (block.type === 'reasoningBlock' && block.text ? [block.text] : []))
    .join('')
  return {
    ...(text ? { finalText: sanitizeTerminalText(text) } : {}),
    ...(reasoning ? { finalReasoning: sanitizeTerminalText(reasoning) } : {}),
  }
}

function projectUsage(agent: Agent, result: AgentResult, runUsage?: NormalizedUsage): TokenUsage | undefined {
  if (runUsage?.incomplete) {
    return undefined
  }
  const usage = result.metrics?.latestAgentInvocation?.usage ?? result.metrics?.accumulatedUsage
  const normalized = runUsage ?? (usage ? normalizeUsage(agent.model, usage) : undefined)
  if (!normalized) {
    return undefined
  }
  return {
    totalTokens: normalized.totalTokens,
    cacheReadInputTokens: normalized.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: normalized.cacheWriteInputTokens ?? 0,
    ...(normalized.inputTokens !== undefined ? { inputTokens: normalized.inputTokens } : {}),
    ...(normalized.outputTokens !== undefined ? { outputTokens: normalized.outputTokens } : {}),
  }
}

function projectContext(
  agent: Agent,
  result: AgentResult,
  usage: TokenUsage | undefined,
  latestModelUsage: Usage | undefined
): ChatContextUsage {
  const contextWindow = contextWindowLimit(agent.model)
  const finalModelUsage = latestModelUsage ?? latestResultModelUsage(result)
  const normalizedLatestUsage = finalModelUsage === undefined ? undefined : normalizeUsage(agent.model, finalModelUsage)
  const currentTokens = finalModelUsage === undefined ? result.contextSize : normalizedLatestUsage?.inputTokens
  const projectedTokens =
    finalModelUsage === undefined ? result.projectedContextSize : normalizedLatestUsage?.totalTokens
  return {
    ...(currentTokens !== undefined ? { currentTokens } : {}),
    ...(projectedTokens !== undefined ? { projectedTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(usage
      ? {
          totalTokens: usage.totalTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        }
      : {}),
  }
}

export function projectToolResultContent(block: ToolResultContent): ChatToolResultContent {
  switch (block.type) {
    case 'textBlock':
      return { type: 'text', text: sanitizeTerminalText(block.text) }
    case 'jsonBlock':
      return { type: 'json', value: sanitizeTerminalValue(block.json) }
    default:
      return projectMediaContent(block)
  }
}

type MediaBlock = Extract<ContentBlock, { type: 'imageBlock' | 'videoBlock' | 'documentBlock' }>

export function projectMediaContent(block: MediaBlock): ChatMediaContent
export function projectMediaContent(block: ContentBlock): ChatMediaContent | undefined
export function projectMediaContent(block: ContentBlock): ChatMediaContent | undefined {
  switch (block.type) {
    case 'imageBlock':
      return {
        type: 'image',
        format: block.format,
        source: projectImageSource(block.source),
      }
    case 'videoBlock':
      return {
        type: 'video',
        format: block.format,
        source: projectVideoSource(block.source),
      }
    case 'documentBlock':
      return {
        type: 'document',
        name: sanitizeTerminalText(block.name),
        format: block.format,
        source: projectDocumentSource(block.source),
        ...(block.citations ? { citations: { ...block.citations } } : {}),
        ...(block.context !== undefined ? { context: sanitizeTerminalText(block.context) } : {}),
      }
    default:
      return undefined
  }
}

function projectImageSource(
  source: Extract<ToolResultContent, { type: 'imageBlock' }>['source']
): Extract<ChatMediaContent, { type: 'image' }>['source'] {
  switch (source.type) {
    case 'imageSourceBytes':
      return { type: 'bytes', bytes: new Uint8Array(source.bytes) }
    case 'imageSourceS3Location':
      return { type: 's3', location: projectS3Location(source.location) }
    case 'imageSourceUrl':
      return { type: 'url', url: sanitizeTerminalText(source.url) }
  }
}

function projectVideoSource(
  source: Extract<ToolResultContent, { type: 'videoBlock' }>['source']
): Extract<ChatMediaContent, { type: 'video' }>['source'] {
  switch (source.type) {
    case 'videoSourceBytes':
      return { type: 'bytes', bytes: new Uint8Array(source.bytes) }
    case 'videoSourceS3Location':
      return { type: 's3', location: projectS3Location(source.location) }
  }
}

function projectDocumentSource(
  source: Extract<ToolResultContent, { type: 'documentBlock' }>['source']
): Extract<ChatMediaContent, { type: 'document' }>['source'] {
  switch (source.type) {
    case 'documentSourceBytes':
      return { type: 'bytes', bytes: new Uint8Array(source.bytes) }
    case 'documentSourceText':
      return { type: 'text', text: sanitizeTerminalText(source.text) }
    case 'documentSourceContentBlock':
      return { type: 'content', content: source.content.map((block) => sanitizeTerminalText(block.text)) }
    case 'documentSourceS3Location':
      return { type: 's3', location: projectS3Location(source.location) }
  }
}

export function projectS3Location(location: { uri: string; bucketOwner?: string }): ChatS3Location {
  return {
    type: 's3',
    uri: sanitizeTerminalText(location.uri),
    ...(location.bucketOwner !== undefined ? { bucketOwner: sanitizeTerminalText(location.bucketOwner) } : {}),
  }
}
