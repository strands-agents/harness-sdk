/**
 * Builds the OpenAI Chat Completions payload a SageMaker endpoint receives.
 *
 * Kept separate from the OpenAI provider's adapter so this provider does not load the optional
 * `openai` package.
 *
 * @internal
 */

import type { ContentBlock, Message, SystemPrompt, ToolResultBlock } from '../../types/messages.js'
import type { ImageBlock } from '../../types/media.js'
import type { StreamOptions } from '../model.js'
import type { ToolChoice, ToolSpec } from '../../tools/types.js'
import { logger } from '../../logging/logger.js'
import { formatImageDataUrl } from '../openai/formatting.js'
import type { SageMakerModelConfig } from './types.js'

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** A message in the payload. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | ContentPart[]
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/**
 * Builds the JSON payload for one request.
 *
 * @internal
 */
export function buildPayload(
  config: SageMakerModelConfig,
  messages: Message[],
  options?: StreamOptions
): Record<string, unknown> {
  const chatMessages = [...formatSystemPrompt(options?.systemPrompt), ...formatMessages(messages, config)]
  const stream = config.stream !== false
  const payload: Record<string, unknown> = { ...config.additionalPayloadArgs, messages: chatMessages, stream }
  // Without this, vLLM and TGI report no usage on a streamed response.
  if (stream && payload.stream_options === undefined) payload.stream_options = { include_usage: true }

  setIfDefined(payload, 'max_tokens', config.maxTokens)
  setIfDefined(payload, 'temperature', config.temperature)
  setIfDefined(payload, 'top_p', config.topP)
  setIfDefined(payload, 'top_k', config.topK)
  setIfDefined(payload, 'stop', config.stop)

  const toolSpecs = options?.toolSpecs ?? []
  if (toolSpecs.length > 0) {
    payload.tools = toolSpecs.map(formatToolSpec)
    payload.tool_choice = formatToolChoice(options?.toolChoice)
  }
  // A null in additionalPayloadArgs omits the field.
  for (const key of Object.keys(payload)) {
    if (payload[key] === null) delete payload[key]
  }
  return payload
}

function setIfDefined(payload: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) payload[key] = value
}

function formatToolSpec(spec: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: spec.name, description: spec.description, parameters: spec.inputSchema },
  }
}

function formatToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice || 'auto' in choice) return 'auto'
  if ('any' in choice) return 'required'
  return { type: 'function', function: { name: choice.tool.name } }
}

function formatSystemPrompt(systemPrompt: SystemPrompt | undefined): ChatMessage[] {
  if (systemPrompt === undefined) return []
  const text =
    typeof systemPrompt === 'string'
      ? systemPrompt
      : systemPrompt.map((block) => (block.type === 'textBlock' ? block.text : '')).join('')
  return text.trim().length > 0 ? [{ role: 'system', content: text }] : []
}

function formatMessages(messages: Message[], config: SageMakerModelConfig): ChatMessage[] {
  return messages.flatMap((message) =>
    message.role === 'user' ? formatUserMessage(message.content, config) : formatAssistantMessage(message.content)
  )
}

/**
 * Tool results go first, as their own messages, so they stay next to the assistant turn that called
 * the tools. The rest of the turn follows as one user message.
 */
function formatUserMessage(content: ContentBlock[], config: SageMakerModelConfig): ChatMessage[] {
  const toolMessages = content
    .filter((block): block is ToolResultBlock => block.type === 'toolResultBlock')
    .map((block) => formatToolResult(block, config.toolResultsAsUserMessages === true))
  const parts = content.flatMap(formatUserContentPart)
  return parts.length > 0 ? [...toolMessages, { role: 'user', content: parts }] : toolMessages
}

function formatUserContentPart(block: ContentBlock): ContentPart[] {
  switch (block.type) {
    case 'textBlock':
      return [{ type: 'text', text: block.text }]
    case 'imageBlock': {
      const url = formatImageDataUrl(block as ImageBlock)
      return url ? [{ type: 'image_url', image_url: { url } }] : []
    }
    case 'toolResultBlock':
    case 'cachePointBlock':
    case 'unknownBlock':
      return []
    default:
      logger.warn(`block_type=<${block.type}> | unsupported content type in sagemaker user message | skipping`)
      return []
  }
}

function formatToolResult(block: ToolResultBlock, asUserMessage: boolean): ChatMessage {
  const text = block.content
    .map((part) => {
      if (part.type === 'textBlock') return part.text
      if (part.type === 'jsonBlock') return JSON.stringify(part.json)
      logger.warn(`block_type=<${part.type}> | unsupported content type in sagemaker tool result | skipping`)
      return ''
    })
    .filter((part) => part.length > 0)
    .join(' ')
  const content = block.status === 'error' ? `[ERROR] ${text}` : text
  if (asUserMessage) {
    return { role: 'user', content: `Tool call ID '${block.toolUseId}' returned: ${content}` }
  }
  return { role: 'tool', tool_call_id: block.toolUseId, content }
}

/**
 * Reasoning from earlier turns is dropped: OpenAI-compatible containers do not take it back, and
 * replaying it as text would make the model read its own reasoning as an answer.
 */
function formatAssistantMessage(content: ContentBlock[]): ChatMessage[] {
  const text = content.map((block) => (block.type === 'textBlock' ? block.text : '')).join('')
  const toolCalls = content.flatMap((block) =>
    block.type === 'toolUseBlock'
      ? [
          {
            id: block.toolUseId,
            type: 'function' as const,
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          },
        ]
      : []
  )
  if (text.length === 0 && toolCalls.length === 0) return []
  const message: ChatMessage = { role: 'assistant' }
  // An empty content next to tool_calls is omitted; some containers reject `"content": ""` or null there.
  if (text.length > 0) message.content = text
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return [message]
}
