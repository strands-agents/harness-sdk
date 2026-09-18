import { toMimeType } from '../../mime.js'
import { encodeBase64 } from '../../types/media.js'
import type { DocumentBlock, ImageBlock, VideoBlock } from '../../types/media.js'
import type { ContentBlock, Message, SystemPrompt, ToolResultBlock } from '../../types/messages.js'
import type { ToolChoice, ToolSpec } from '../../tools/types.js'
import type { StreamOptions } from '../model.js'
import type { LiteLLMModelOptions } from '../litellm.js'

const THOUGHT_SIGNATURE_SEPARATOR = '__thought__'

interface LiteLLMRequest {
  model: string
  messages: LiteLLMMessage[]
  stream: boolean
  stream_options?: unknown
  [key: string]: unknown
}

interface LiteLLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: unknown
  tool_call_id?: string
  tool_calls?: LiteLLMToolCall[]
}

interface LiteLLMToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Formats an SDK invocation as a LiteLLM Chat Completions request.
 *
 * @internal
 * @param config - Current model configuration.
 * @param messages - Conversation messages to send.
 * @param options - Invocation-specific system prompt and tool settings.
 * @returns The LiteLLM gateway request body.
 */
export function formatLiteLLMRequest(
  config: LiteLLMModelOptions,
  messages: Message[],
  options?: StreamOptions
): LiteLLMRequest {
  const { stream: legacyStream, stream_options: legacyStreamOptions, ...params } = config.params ?? {}
  const stream = config.stream ?? (typeof legacyStream === 'boolean' ? legacyStream : true)
  const request: LiteLLMRequest = {
    ...params,
    model: config.modelId,
    messages: [...formatSystemPrompt(options?.systemPrompt), ...formatMessages(messages)],
    stream,
  }

  if (stream) request.stream_options = legacyStreamOptions ?? { include_usage: true }
  if (config.temperature !== undefined) request.temperature = config.temperature
  if (config.maxTokens !== undefined) request.max_tokens = config.maxTokens
  if (config.topP !== undefined) request.top_p = config.topP
  if (config.frequencyPenalty !== undefined) request.frequency_penalty = config.frequencyPenalty
  if (config.presencePenalty !== undefined) request.presence_penalty = config.presencePenalty

  request.tools = formatTools(options?.toolSpecs) ?? []
  const toolChoice = formatToolChoice(options?.toolChoice)
  if (toolChoice) request.tool_choice = toolChoice

  return request
}

function formatSystemPrompt(systemPrompt: SystemPrompt | undefined): LiteLLMMessage[] {
  if (typeof systemPrompt === 'string') {
    return systemPrompt.trim().length > 0 ? [{ role: 'system', content: [{ type: 'text', text: systemPrompt }] }] : []
  }
  if (!systemPrompt || systemPrompt.length === 0) return []

  const content: Array<Record<string, unknown>> = []
  for (const block of systemPrompt) {
    if (block.type === 'textBlock') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'cachePointBlock' && content.length > 0) {
      content[content.length - 1]!.cache_control = {
        type: 'ephemeral',
        ...(block.ttl !== undefined && { ttl: block.ttl }),
      }
    }
  }
  return content.length > 0 ? [{ role: 'system', content }] : []
}

function formatMessages(messages: Message[]): LiteLLMMessage[] {
  return messages.flatMap((message) =>
    message.role === 'assistant' ? formatAssistantMessage(message.content) : formatUserMessage(message.content)
  )
}

function formatAssistantMessage(contentBlocks: ContentBlock[]): LiteLLMMessage[] {
  const content: unknown[] = []
  const toolCalls: LiteLLMToolCall[] = []

  for (const block of contentBlocks) {
    if (block.type === 'textBlock') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'reasoningBlock') {
      content.push({
        type: 'thinking',
        ...(block.text !== undefined && { thinking: block.text }),
        ...(block.signature !== undefined && { signature: block.signature }),
      })
    } else if (block.type === 'toolUseBlock') {
      const signatureSuffix = block.reasoningSignature
        ? `${THOUGHT_SIGNATURE_SEPARATOR}${block.reasoningSignature}`
        : ''
      const encodedId = block.toolUseId.includes(THOUGHT_SIGNATURE_SEPARATOR)
        ? block.toolUseId
        : `${block.toolUseId}${signatureSuffix}`
      toolCalls.push({
        id: encodedId,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      })
    }
  }

  if (content.length === 0 && toolCalls.length === 0) return []
  return [
    {
      role: 'assistant',
      ...(content.length > 0 && { content }),
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    },
  ]
}

function formatUserMessage(contentBlocks: ContentBlock[]): LiteLLMMessage[] {
  const regularContent: unknown[] = []
  const toolResults: ToolResultBlock[] = []

  for (const block of contentBlocks) {
    if (block.type === 'toolResultBlock') {
      toolResults.push(block)
    } else {
      const formatted = formatUserContent(block)
      if (formatted !== undefined) regularContent.push(formatted)
    }
  }

  const result: LiteLLMMessage[] = []
  if (regularContent.length > 0) result.push({ role: 'user', content: regularContent })
  for (const toolResult of toolResults) result.push(...formatToolResult(toolResult))
  return result
}

function formatUserContent(block: ContentBlock): unknown | undefined {
  switch (block.type) {
    case 'textBlock':
      return { type: 'text', text: block.text }
    case 'imageBlock':
      return formatImage(block)
    case 'videoBlock':
      return formatVideo(block)
    case 'documentBlock':
      return formatDocument(block)
    default:
      return undefined
  }
}

function formatImage(block: ImageBlock): unknown | undefined {
  let url: string
  if (block.source.type === 'imageSourceBytes') {
    const mimeType = toMimeType(block.format) ?? `image/${block.format}`
    url = `data:${mimeType};base64,${encodeBase64(block.source.bytes)}`
  } else if (block.source.type === 'imageSourceUrl') {
    url = block.source.url
  } else {
    url = block.source.location.uri
  }
  return { type: 'image_url', image_url: { detail: 'auto', url } }
}

function formatVideo(block: VideoBlock): unknown {
  const url =
    block.source.type === 'videoSourceBytes'
      ? `data:${toMimeType(block.format) ?? `video/${block.format}`};base64,${encodeBase64(block.source.bytes)}`
      : block.source.location.uri
  return { type: 'video_url', video_url: { detail: 'auto', url } }
}

function formatDocument(block: DocumentBlock): unknown {
  if (block.source.type === 'documentSourceText') return { type: 'text', text: block.source.text }
  if (block.source.type === 'documentSourceContentBlock') {
    return { type: 'text', text: block.source.content.map((content) => content.text).join('\n') }
  }
  if (block.source.type === 'documentSourceS3Location') {
    return { type: 'file', file: { file_data: block.source.location.uri, filename: block.name } }
  }
  const mimeType = toMimeType(block.format) ?? `application/${block.format}`
  return {
    type: 'file',
    file: {
      file_data: `data:${mimeType};base64,${encodeBase64(block.source.bytes)}`,
      filename: block.name,
    },
  }
}

function formatToolResult(toolResult: ToolResultBlock): LiteLLMMessage[] {
  const text: string[] = []
  const media: unknown[] = []
  for (const block of toolResult.content) {
    if (block.type === 'textBlock') text.push(block.text)
    else if (block.type === 'jsonBlock') text.push(JSON.stringify(block.json))
    else {
      const formatted = formatUserContent(block)
      if (formatted !== undefined) media.push(formatted)
    }
  }

  const statusPrefix = toolResult.status === 'error' ? '[ERROR] ' : ''
  const toolContent = `${statusPrefix}${text.join('\n')}`
  const messages: LiteLLMMessage[] = [
    {
      role: 'tool',
      tool_call_id: toolResult.toolUseId,
      content: toolContent || 'Tool successfully returned media.',
    },
  ]
  if (media.length > 0) messages.push({ role: 'user', content: media })
  return messages
}

function formatTools(toolSpecs: ToolSpec[] | undefined): unknown[] | undefined {
  if (!toolSpecs || toolSpecs.length === 0) return undefined
  return toolSpecs.map((toolSpec) => ({
    type: 'function',
    function: {
      name: toolSpec.name,
      description: toolSpec.description,
      parameters: toolSpec.inputSchema ?? { type: 'object', properties: {} },
    },
  }))
}

function formatToolChoice(toolChoice: ToolChoice | undefined): unknown | undefined {
  if (!toolChoice || 'auto' in toolChoice) return toolChoice ? 'auto' : undefined
  if ('any' in toolChoice) return 'required'
  return { type: 'function', function: { name: toolChoice.tool.name } }
}
