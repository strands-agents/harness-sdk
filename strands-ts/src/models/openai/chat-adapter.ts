/**
 * Chat Completions API adapter for the OpenAI model provider.
 *
 * @internal
 */

import OpenAI from 'openai'
import type { ChatCompletionContentPartText } from 'openai/resources/index.mjs'
import type { Message, StopReason, ToolResultBlock } from '../../types/messages.js'
import type { ImageBlock, DocumentBlock } from '../../types/media.js'
import { encodeBase64 } from '../../types/media.js'
import { toMimeType } from '../../mime.js'
import type { ModelStreamEvent } from '../streaming.js'
import type { StreamOptions } from '../model.js'
import { logger } from '../../logging/logger.js'
import { MODEL_DEFAULTS } from '../defaults.js'
import { formatImageDataUrl, warnManagedParams as warnManagedParamsShared } from './formatting.js'
import { applyCacheConfig } from './cache.js'
import type { ChatStreamState, OpenAIChatConfig } from './types.js'

export const DEFAULT_CHAT_MODEL_ID = MODEL_DEFAULTS.openai.modelId

const MANAGED_PARAMS: ReadonlySet<string> = new Set(['model', 'messages', 'stream', 'stream_options'])

/**
 * Logs a warning for each chat-managed key present in `params`.
 *
 * @internal
 */
export function warnManagedParams(params: Record<string, unknown> | undefined): void {
  warnManagedParamsShared(params, MANAGED_PARAMS)
}

type OpenAIChatChoice = {
  delta?: {
    role?: string
    content?: string
    tool_calls?: Array<{
      index: number
      id?: string
      type?: string
      function?: {
        name?: string
        arguments?: string
      }
    }>
  }
  finish_reason?: string
  index: number
}

/**
 * Builds a Chat Completions streaming request body.
 *
 * @internal
 */
export function formatChatRequest(
  config: OpenAIChatConfig,
  messages: Message[],
  options?: StreamOptions
): OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming {
  // User `params` are spread first so provider-managed fields always win.
  // The managed-params warning fires at config time to surface the collision.
  const request = {
    ...(config.params ?? {}),
    model: config.modelId ?? DEFAULT_CHAT_MODEL_ID,
    messages: [] as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    stream: true as const,
    stream_options: { include_usage: true },
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming

  if (options?.systemPrompt !== undefined) {
    if (typeof options.systemPrompt === 'string') {
      if (options.systemPrompt.trim().length > 0) {
        request.messages.push({ role: 'system', content: options.systemPrompt })
      }
    } else if (Array.isArray(options.systemPrompt) && options.systemPrompt.length > 0) {
      const textBlocks: string[] = []
      let hasCachePoints = false
      let hasGuardContent = false

      for (const block of options.systemPrompt) {
        if (block.type === 'textBlock') {
          textBlocks.push(block.text)
        } else if (block.type === 'cachePointBlock') {
          hasCachePoints = true
        } else if (block.type === 'guardContentBlock') {
          hasGuardContent = true
        }
      }

      if (hasCachePoints) {
        logger.warn('cache points are not supported in openai system prompts, ignoring cache points')
      }
      if (hasGuardContent) {
        logger.warn('guard content is not supported in openai system prompts, removing guard content block')
      }

      if (textBlocks.length > 0) {
        request.messages.push({ role: 'system', content: textBlocks.join('') })
      }
    }
  }

  request.messages.push(...formatChatMessages(messages))

  if (config.temperature !== undefined) request.temperature = config.temperature
  if (config.maxTokens !== undefined) request.max_completion_tokens = config.maxTokens
  if (config.topP !== undefined) request.top_p = config.topP
  if (config.frequencyPenalty !== undefined) request.frequency_penalty = config.frequencyPenalty
  if (config.presencePenalty !== undefined) request.presence_penalty = config.presencePenalty

  if (options?.toolSpecs && options.toolSpecs.length > 0) {
    request.tools = options.toolSpecs.map((spec) => {
      if (!spec.name || !spec.description) {
        throw new Error('Tool specification must have both name and description')
      }
      return {
        type: 'function' as const,
        function: {
          name: spec.name,
          description: spec.description,
          parameters: spec.inputSchema as Record<string, unknown>,
        },
      }
    })

    if (options.toolChoice) {
      if ('auto' in options.toolChoice) {
        request.tool_choice = 'auto'
      } else if ('any' in options.toolChoice) {
        request.tool_choice = 'required'
      } else if ('tool' in options.toolChoice) {
        request.tool_choice = {
          type: 'function',
          function: { name: options.toolChoice.tool.name },
        }
      }
    }
  }

  applyCacheConfig(request, config.cacheConfig, options?.agentMetadata)

  if ('n' in request && request.n !== undefined && request.n !== null && request.n > 1) {
    throw new Error('Streaming with n > 1 is not supported')
  }

  return request
}

/**
 * Converts SDK messages into Chat Completions message params. Tool result blocks
 * are split out into separate `tool`-role messages; media inside tool results is
 * hoisted into a following user-role message (OpenAI restricts media to user role).
 */
function formatChatMessages(messages: Message[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const openAIMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

  for (const message of messages) {
    if (message.role === 'user') {
      const toolResults = message.content.filter((b) => b.type === 'toolResultBlock')
      const otherContent = message.content.filter((b) => b.type !== 'toolResultBlock')

      if (otherContent.length > 0) {
        const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []

        for (const block of otherContent) {
          switch (block.type) {
            case 'textBlock': {
              contentParts.push({ type: 'text', text: block.text })
              break
            }
            case 'imageBlock': {
              const formatted = formatImageContentPart(block as ImageBlock)
              if (formatted) contentParts.push(formatted)
              break
            }
            case 'documentBlock': {
              const docBlock = block as DocumentBlock
              switch (docBlock.source.type) {
                case 'documentSourceBytes': {
                  const mimeType = toMimeType(docBlock.format) || `application/${docBlock.format}`
                  const base64 = encodeBase64(docBlock.source.bytes)
                  contentParts.push({
                    type: 'file',
                    file: {
                      file_data: `data:${mimeType};base64,${base64}`,
                      filename: docBlock.name,
                    },
                  })
                  break
                }
                case 'documentSourceText': {
                  logger.warn(
                    'source_type=<documentSourceText> | openai does not support text document sources directly | converting to string content'
                  )
                  contentParts.push({ type: 'text', text: docBlock.source.text })
                  break
                }
                case 'documentSourceContentBlock': {
                  contentParts.push(
                    ...docBlock.source.content.map<ChatCompletionContentPartText>((b) => ({
                      type: 'text',
                      text: b.text,
                    }))
                  )
                  break
                }
                default: {
                  logger.warn(
                    `source_type=<${docBlock.source.type}> | openai only supports text content in user messages | skipping document block`
                  )
                  break
                }
              }
              break
            }
            default: {
              logger.warn(`block_type=<${block.type}> | unsupported content type in openai user message | skipping`)
              break
            }
          }
        }

        if (contentParts.length > 0) {
          openAIMessages.push({ role: 'user', content: contentParts })
        }
      }

      const userMessagesWithMedia: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

      for (const toolResult of toolResults) {
        const [textContent, imageParts] = splitToolResultMedia(toolResult)

        if (imageParts.length > 0) {
          logger.warn(
            `tool_call_id=<${toolResult.toolUseId}> | moving images from tool result to separate user message for openai compatibility`
          )
        }

        const effectiveTextContent =
          textContent.trim().length === 0 && imageParts.length > 0
            ? 'Tool successfully returned an image. The image is being provided in the following user message.'
            : textContent

        if (!effectiveTextContent || effectiveTextContent.trim().length === 0) {
          throw new Error(
            `Tool result for toolUseId "${toolResult.toolUseId}" has empty content. ` +
              'OpenAI requires tool messages to have non-empty content.'
          )
        }

        const finalContent = toolResult.status === 'error' ? `[ERROR] ${effectiveTextContent}` : effectiveTextContent

        openAIMessages.push({
          role: 'tool',
          tool_call_id: toolResult.toolUseId,
          content: finalContent,
        })

        if (imageParts.length > 0) {
          userMessagesWithMedia.push({ role: 'user', content: imageParts })
        }
      }

      openAIMessages.push(...userMessagesWithMedia)
    } else {
      const toolUseCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = []
      const textParts: string[] = []

      for (const block of message.content) {
        switch (block.type) {
          case 'textBlock': {
            textParts.push(block.text)
            break
          }
          case 'toolUseBlock': {
            try {
              toolUseCalls.push({
                id: block.toolUseId,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input),
                },
              })
            } catch (error: unknown) {
              if (error instanceof Error) {
                throw new Error(`Failed to serialize tool input for "${block.name}`, error)
              }
              throw error
            }
            break
          }
          case 'reasoningBlock': {
            if (block.text) {
              logger.warn('block_type=<reasoningBlock> | reasoning blocks not supported by openai | converting to text')
              textParts.push(block.text)
            }
            break
          }
          default: {
            logger.warn(`block_type=<${block.type}> | unsupported content type in openai assistant message | skipping`)
          }
        }
      }

      const textContent = textParts.join('').trim()
      const assistantMessage: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: textContent,
      }
      if (toolUseCalls.length > 0) {
        assistantMessage.tool_calls = toolUseCalls
      }
      if (textContent.length > 0 || toolUseCalls.length > 0) {
        openAIMessages.push(assistantMessage)
      }
    }
  }

  return openAIMessages
}

function formatImageContentPart(
  imageBlock: ImageBlock
): OpenAI.Chat.Completions.ChatCompletionContentPartImage | undefined {
  const url = formatImageDataUrl(imageBlock)
  if (!url) return undefined
  return { type: 'image_url', image_url: { url } }
}

function splitToolResultMedia(
  toolResult: ToolResultBlock
): [string, OpenAI.Chat.Completions.ChatCompletionContentPart[]] {
  const textParts: string[] = []
  const imageParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []

  for (const c of toolResult.content) {
    if (c.type === 'textBlock') {
      textParts.push(c.text)
    } else if (c.type === 'jsonBlock') {
      try {
        textParts.push(JSON.stringify(c.json))
      } catch (error: unknown) {
        if (error instanceof Error) {
          const dataPreview =
            typeof c.json === 'object' && c.json !== null
              ? `object with keys: ${Object.keys(c.json).slice(0, 5).join(', ')}`
              : typeof c.json
          textParts.push(`[JSON Serialization Error: ${error.message}. Data type: ${dataPreview}]`)
        }
      }
    } else if (c.type === 'imageBlock') {
      const formatted = formatImageContentPart(c as ImageBlock)
      if (formatted) imageParts.push(formatted)
    } else if (c.type === 'documentBlock') {
      logger.warn('block_type=<documentBlock> | documents not supported in openai tool results, skipping')
    } else if (c.type === 'videoBlock') {
      logger.warn('block_type=<videoBlock> | videos not supported in openai tool results, skipping')
    }
  }

  return [textParts.join(''), imageParts]
}

/**
 * Maps a Chat Completions streaming chunk to one or more SDK events. Mutates
 * `state` and `activeToolCalls` as a side effect.
 *
 * @internal
 */
export function mapChatChunkToEvents(
  chunk: { choices: unknown[] },
  state: ChatStreamState,
  activeToolCalls: Map<number, boolean>
): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = []

  if (!chunk.choices || chunk.choices.length === 0) return events

  const choice = chunk.choices[0]
  if (!choice || typeof choice !== 'object') {
    logger.warn(`choice=<${choice}> | invalid choice format in openai chunk`)
    return events
  }

  const typedChoice = choice as OpenAIChatChoice
  if (!typedChoice.delta && !typedChoice.finish_reason) return events

  const delta = typedChoice.delta

  if (delta?.role && !state.messageStarted) {
    state.messageStarted = true
    events.push({ type: 'modelMessageStartEvent', role: delta.role as 'user' | 'assistant' })
  }

  if (delta?.content && delta.content.length > 0) {
    if (!state.textContentBlockStarted) {
      state.textContentBlockStarted = true
      events.push({ type: 'modelContentBlockStartEvent' })
    }
    events.push({
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'textDelta', text: delta.content },
    })
  }

  if (delta?.tool_calls && delta.tool_calls.length > 0) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.index === undefined || typeof toolCall.index !== 'number') {
        logger.warn(`tool_call=<${JSON.stringify(toolCall)}> | received tool call with invalid index`)
        continue
      }

      if (toolCall.id && toolCall.function?.name) {
        events.push({
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: toolCall.function.name, toolUseId: toolCall.id },
        })
        activeToolCalls.set(toolCall.index, true)
      }

      if (toolCall.function?.arguments) {
        events.push({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: toolCall.function.arguments },
        })
      }
    }
  }

  if (typedChoice.finish_reason) {
    if (state.textContentBlockStarted) {
      events.push({ type: 'modelContentBlockStopEvent' })
      state.textContentBlockStarted = false
    }

    for (const [index] of activeToolCalls) {
      events.push({ type: 'modelContentBlockStopEvent' })
      activeToolCalls.delete(index)
    }

    const stopReasonMap: Record<string, StopReason> = {
      stop: 'endTurn',
      tool_calls: 'toolUse',
      length: 'maxTokens',
      content_filter: 'contentFiltered',
    }
    const stopReason: StopReason = stopReasonMap[typedChoice.finish_reason] ?? snakeToCamel(typedChoice.finish_reason)
    if (!stopReasonMap[typedChoice.finish_reason]) {
      logger.warn(
        `finish_reason=<${typedChoice.finish_reason}>, fallback=<${stopReason}> | unknown openai stop reason, using camelCase conversion as fallback`
      )
    }

    events.push({ type: 'modelMessageStopEvent', stopReason })
  }

  return events
}

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}
