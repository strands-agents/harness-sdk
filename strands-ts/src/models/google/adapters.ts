/**
 * Adapters for converting between Strands SDK types and Gemini API format.
 *
 * @internal This module is not part of the public API.
 */

import {
  type Content,
  type GenerateContentResponse,
  type Part,
  FunctionResponse,
  FinishReason as GeminiFinishReason,
} from '@google/genai'
import type {
  Message,
  StopReason,
  ContentBlock,
  ReasoningBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../../types/messages.js'
import type { ModelStreamEvent } from '../streaming.js'
import type { GoogleStreamState } from './types.js'
import { encodeBase64, type ImageBlock, type DocumentBlock, type VideoBlock } from '../../types/media.js'
import { toMimeType } from '../../mime.js'
import { logger } from '../../logging/logger.js'

/**
 * Mapping of Gemini finish reasons to SDK stop reasons.
 * Only MAX_TOKENS needs explicit mapping; everything else defaults to endTurn.
 * Tool use stop reason is determined by the hasToolCalls flag in GoogleStreamState,
 * since Gemini does not have a tool use finish reason.
 *
 * @internal
 */
export const FINISH_REASON_MAP: Partial<Record<GeminiFinishReason, StopReason>> = {
  [GeminiFinishReason.MAX_TOKENS]: 'maxTokens',
}

// =============================================================================
// Strands → Gemini
// =============================================================================

/**
 * Formats an array of messages for the Gemini API.
 *
 * @param messages - SDK messages to format
 * @returns Gemini-formatted contents array
 *
 * @internal
 */
export function formatMessages(messages: Message[]): Content[] {
  const contents: Content[] = []

  // Build toolUseId → name mapping for resolving tool result names
  const toolUseIdToName = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock') {
        toolUseIdToName.set(block.toolUseId, block.name)
      }
    }
  }

  for (const message of messages) {
    const parts: Part[] = []

    for (const block of message.content) {
      parts.push(...formatContentBlock(block, toolUseIdToName))
    }

    if (parts.length > 0) {
      contents.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts,
      })
    }
  }

  return contents
}

/**
 * Formats a content block to Gemini Parts.
 *
 * @param block - SDK content block
 * @returns Array of Gemini Parts
 *
 * @internal
 */
function formatContentBlock(block: ContentBlock, toolUseIdToName: Map<string, string>): Part[] {
  switch (block.type) {
    case 'textBlock':
      return [{ text: block.text }]

    case 'imageBlock':
      return formatImageBlock(block)

    case 'reasoningBlock':
      return formatReasoningBlock(block)

    case 'documentBlock':
      return formatDocumentBlock(block)

    case 'videoBlock':
      return formatVideoBlock(block)

    case 'toolUseBlock':
      return formatToolUseBlock(block)

    case 'toolResultBlock':
      return formatToolResultBlock(block, toolUseIdToName)

    case 'cachePointBlock':
      logger.warn('block_type=<cachePointBlock> | cache points not supported by gemini, skipping')
      return []

    case 'guardContentBlock':
      logger.warn('block_type=<guardContentBlock> | guard content not supported by gemini, skipping')
      return []

    default:
      return []
  }
}

/**
 * Formats an image block to Gemini Parts.
 *
 * @param block - Image block to format
 * @returns Array of Gemini Parts
 *
 * @internal
 */
function formatImageBlock(block: ImageBlock): Part[] {
  const mimeType = toMimeType(block.format) ?? `image/${block.format}`

  switch (block.source.type) {
    case 'imageSourceBytes':
      return [{ inlineData: { data: encodeBase64(block.source.bytes), mimeType } }]

    case 'imageSourceUrl':
      return [{ fileData: { fileUri: block.source.url, mimeType } }]

    case 'imageSourceS3Location':
      logger.warn('source_type=<imageSourceS3Location> | s3 sources not supported by gemini, skipping')
      return []

    default:
      return []
  }
}

/**
 * Formats a reasoning block to Gemini Parts.
 *
 * @param block - Reasoning block to format
 * @returns Array of Gemini Parts
 *
 * @internal
 */
function formatReasoningBlock(block: ReasoningBlock): Part[] {
  if (!block.text) {
    return []
  }

  const part: Part = {
    text: block.text,
    thought: true,
  }

  // Add thought signature if present
  if (block.signature) {
    part.thoughtSignature = block.signature
  }

  return [part]
}

/**
 * Formats a document block to Gemini Parts.
 *
 * @param block - Document block to format
 * @returns Array of Gemini Parts
 *
 * @internal
 */
function formatDocumentBlock(block: DocumentBlock): Part[] {
  const mimeType = toMimeType(block.format) ?? `application/${block.format}`

  switch (block.source.type) {
    case 'documentSourceBytes':
      return [{ inlineData: { data: encodeBase64(block.source.bytes), mimeType } }]

    case 'documentSourceText':
      // Convert text to bytes - Gemini API doesn't accept text directly
      return [{ inlineData: { data: encodeBase64(new TextEncoder().encode(block.source.text)), mimeType } }]

    case 'documentSourceContentBlock':
      return block.source.content.map((contentBlock) => ({ text: contentBlock.text }))

    case 'documentSourceS3Location':
      logger.warn('source_type=<documentSourceS3Location> | s3 sources not supported by gemini, skipping')
      return []

    default:
      return []
  }
}

/**
 * Formats a video block to Gemini Parts.
 *
 * @param block - Video block to format
 * @returns Array of Gemini Parts
 *
 * @internal
 */
function formatVideoBlock(block: VideoBlock): Part[] {
  const mimeType = toMimeType(block.format) ?? `video/${block.format}`

  switch (block.source.type) {
    case 'videoSourceBytes':
      return [{ inlineData: { data: encodeBase64(block.source.bytes), mimeType } }]

    case 'videoSourceS3Location':
      logger.warn('source_type=<videoSourceS3Location> | s3 sources not supported by gemini, skipping')
      return []

    default:
      return []
  }
}

/**
 * Formats a tool use block to a Gemini Part.
 *
 * @param block - Tool use block to format
 * @returns Array of Gemini Parts with functionCall
 *
 * @internal
 */
function formatToolUseBlock(block: ToolUseBlock): Part[] {
  return [
    {
      functionCall: {
        id: block.toolUseId,
        name: block.name,
        args: block.input as Record<string, unknown>,
      },
      ...(block.reasoningSignature && { thoughtSignature: block.reasoningSignature }),
    },
  ]
}

/**
 * Formats a tool result block to a Gemini Part.
 *
 * @param block - Tool result block to format
 * @param toolUseIdToName - Mapping from tool use IDs to tool names
 * @returns Array of Gemini Parts with functionResponse
 *
 * @internal
 */
function formatToolResultBlock(block: ToolResultBlock, toolUseIdToName: Map<string, string>): Part[] {
  const parts: Part[] = []
  const output: Array<{ text?: string; json?: unknown }> = []

  // Gemini enforces unique displayNames within one function_response.parts. Disambiguate
  // collisions (e.g. two same-format images, or two documents sharing a name) by suffixing.
  const usedDisplayNames = new Set<string>()
  const uniqueDisplayName = (name: string): string => {
    if (!usedDisplayNames.has(name)) {
      usedDisplayNames.add(name)
      return name
    }
    const dot = name.lastIndexOf('.')
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    let i = 1
    let candidate = `${base}-${i}${ext}`
    while (usedDisplayNames.has(candidate)) {
      candidate = `${base}-${++i}${ext}`
    }
    usedDisplayNames.add(candidate)
    return candidate
  }

  for (const c of block.content) {
    switch (c.type) {
      case 'textBlock':
        output.push({ text: c.text })
        break
      case 'jsonBlock':
        output.push({ json: c.json })
        break
      case 'imageBlock': {
        const mimeType = toMimeType(c.format) ?? `image/${c.format}`
        if (c.source.type === 'imageSourceBytes') {
          parts.push({
            inlineData: {
              data: encodeBase64(c.source.bytes),
              mimeType,
              displayName: uniqueDisplayName(`image.${c.format}`),
            },
          })
        } else {
          logger.warn('source_type=<%s> | only bytes sources supported in gemini tool results', c.source.type)
        }
        break
      }
      case 'documentBlock': {
        const mimeType = toMimeType(c.format) ?? `application/${c.format}`
        if (c.source.type === 'documentSourceBytes') {
          parts.push({
            inlineData: {
              data: encodeBase64(c.source.bytes),
              mimeType,
              displayName: uniqueDisplayName(c.name),
            },
          })
        } else if (c.source.type === 'documentSourceText') {
          parts.push({
            inlineData: {
              data: encodeBase64(new TextEncoder().encode(c.source.text)),
              mimeType,
              displayName: uniqueDisplayName(c.name),
            },
          })
        } else {
          logger.warn('source_type=<%s> | only bytes/text sources supported in gemini tool results', c.source.type)
        }
        break
      }
      case 'videoBlock':
        logger.warn('block_type=<videoBlock> | videos not supported in gemini tool results, skipping')
        break
    }
  }

  const functionResponse = new FunctionResponse()
  functionResponse.id = block.toolUseId
  functionResponse.name = toolUseIdToName.get(block.toolUseId) ?? block.toolUseId
  functionResponse.response = { output }
  if (parts.length > 0) {
    functionResponse.parts = parts
  }

  return [{ functionResponse }]
}

// =============================================================================
// Gemini → Strands
// =============================================================================

/**
 * Maps a Gemini response chunk to SDK streaming events.
 *
 * @param chunk - Gemini response chunk
 * @param streamState - Mutable state object tracking message and content block state
 * @returns Array of SDK streaming events
 *
 * @internal
 */
export function mapChunkToEvents(chunk: GenerateContentResponse, streamState: GoogleStreamState): ModelStreamEvent[] {
  const events: ModelStreamEvent[] = []

  // Extract usage metadata if available
  if (chunk.usageMetadata) {
    const usageMetadata = chunk.usageMetadata
    const promptTokens = usageMetadata.promptTokenCount || 0
    const toolUsePromptTokens = usageMetadata.toolUsePromptTokenCount || 0
    const totalTokens = usageMetadata.totalTokenCount || 0
    const candidatesTokens = usageMetadata.candidatesTokenCount
    const thoughtsTokens = usageMetadata.thoughtsTokenCount || 0
    const inputTokens = promptTokens + toolUsePromptTokens

    streamState.inputTokens = inputTokens
    streamState.outputTokens =
      candidatesTokens === undefined ? Math.max(0, totalTokens - inputTokens) : candidatesTokens + thoughtsTokens
    streamState.totalTokens = totalTokens
    const cachedTokens = usageMetadata.cachedContentTokenCount
    if (typeof cachedTokens === 'number' && cachedTokens > 0) {
      streamState.cacheReadInputTokens = cachedTokens
    } else {
      delete streamState.cacheReadInputTokens
    }
  }

  const candidates = chunk.candidates
  if (!candidates || candidates.length === 0) {
    return events
  }

  const candidate = candidates[0]
  if (!candidate) {
    return events
  }

  // Handle message start
  if (!streamState.messageStarted) {
    streamState.messageStarted = true
    events.push({
      type: 'modelMessageStartEvent',
      role: 'assistant',
    })
  }

  // Process content parts
  const content = candidate.content
  if (content && content.parts) {
    for (const part of content.parts) {
      // Handle function call parts
      if (part.functionCall) {
        // Close any open text/reasoning blocks before tool use
        if (streamState.textContentBlockStarted) {
          events.push({ type: 'modelContentBlockStopEvent' })
          streamState.textContentBlockStarted = false
        }
        if (streamState.reasoningContentBlockStarted) {
          events.push({ type: 'modelContentBlockStopEvent' })
          streamState.reasoningContentBlockStarted = false
        }

        const toolUseId = part.functionCall.id || `tooluse_${globalThis.crypto.randomUUID()}`

        events.push({
          type: 'modelContentBlockStartEvent',
          start: {
            type: 'toolUseStart',
            name: part.functionCall.name!,
            toolUseId,
            ...(part.thoughtSignature && { reasoningSignature: part.thoughtSignature }),
          },
        })

        events.push({
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'toolUseInputDelta',
            input: JSON.stringify(part.functionCall.args ?? {}),
          },
        })

        events.push({ type: 'modelContentBlockStopEvent' })

        streamState.hasToolCalls = true
        continue
      }

      // Handle text and reasoning parts
      if ('text' in part && part.text) {
        const isThought = 'thought' in part && part.thought === true

        if (isThought) {
          // Handle reasoning content
          // Close text block if transitioning from text to reasoning
          if (streamState.textContentBlockStarted) {
            events.push({ type: 'modelContentBlockStopEvent' })
            streamState.textContentBlockStarted = false
          }

          if (!streamState.reasoningContentBlockStarted) {
            streamState.reasoningContentBlockStarted = true
            events.push({ type: 'modelContentBlockStartEvent' })
          }

          // Extract signature if present
          const signature = part.thoughtSignature

          events.push({
            type: 'modelContentBlockDeltaEvent',
            delta: {
              type: 'reasoningContentDelta',
              text: part.text,
              ...(signature !== undefined && { signature }),
            },
          })
        } else {
          // Handle regular text content
          // Close reasoning block if transitioning from reasoning to text
          if (streamState.reasoningContentBlockStarted) {
            events.push({ type: 'modelContentBlockStopEvent' })
            streamState.reasoningContentBlockStarted = false
          }

          if (!streamState.textContentBlockStarted) {
            streamState.textContentBlockStarted = true
            events.push({ type: 'modelContentBlockStartEvent' })
          }

          events.push({
            type: 'modelContentBlockDeltaEvent',
            delta: {
              type: 'textDelta',
              text: part.text,
            },
          })
        }
      }
    }
  }

  // Handle finish reason
  const finishReason = candidate.finishReason
  if (finishReason && finishReason !== GeminiFinishReason.FINISH_REASON_UNSPECIFIED) {
    // Close any open content blocks
    if (streamState.textContentBlockStarted) {
      events.push({ type: 'modelContentBlockStopEvent' })
      streamState.textContentBlockStarted = false
    }
    if (streamState.reasoningContentBlockStarted) {
      events.push({ type: 'modelContentBlockStopEvent' })
      streamState.reasoningContentBlockStarted = false
    }

    const stopReason = streamState.hasToolCalls ? 'toolUse' : FINISH_REASON_MAP[finishReason] || 'endTurn'

    events.push({
      type: 'modelMessageStopEvent',
      stopReason,
    })
  }

  return events
}
