import { encodeBase64 } from '../../../types/media.js'
import { ModelError } from '../../../errors.js'
import type { ConversationItem, RealtimeClientEvent, RealtimeResponse } from 'openai/resources/realtime/realtime'
import type { ContentBlock, Message } from '../../../types/messages.js'
import type { BidiModelInput, ToolUseStreamEvent } from '../types.js'
import type { JSONValue } from '../../../types/json.js'

/** Converts a content block without performing network I/O. @internal */
export function formatItem(block: ContentBlock, role: 'user' | 'assistant'): ConversationItem {
  switch (block.type) {
    case 'textBlock':
      return role === 'user'
        ? { type: 'message', role, content: [{ type: 'input_text', text: block.text }] }
        : { type: 'message', role, content: [{ type: 'output_text', text: block.text }] }
    case 'imageBlock': {
      if (role !== 'user' || block.source.type !== 'imageSourceBytes' || !['png', 'jpeg'].includes(block.format)) {
        throw new Error('Realtime images require user-provided PNG or JPEG bytes')
      }
      return {
        type: 'message',
        role,
        content: [
          { type: 'input_image', image_url: `data:image/${block.format};base64,${encodeBase64(block.source.bytes)}` },
        ],
      }
    }
    case 'toolUseBlock':
      if (role !== 'assistant') throw new Error('Tool requests require the assistant role')
      return {
        type: 'function_call',
        call_id: block.toolUseId,
        name: block.name,
        arguments: JSON.stringify(block.input),
      }
    case 'toolResultBlock':
      return {
        type: 'function_call_output',
        call_id: block.toolUseId,
        output: JSON.stringify(block.toJSON().toolResult),
      }
    default:
      throw new Error(`Unsupported Realtime history block: ${block.type}`)
  }
}

/** Validates and converts history before opening a connection. @internal */
export function formatHistory(messages: Message[]): RealtimeClientEvent[] {
  return messages.flatMap((message) =>
    message.content.map((block) => ({
      type: 'conversation.item.create' as const,
      item: formatItem(block, message.role),
    }))
  )
}

/** Converts live input; PCM is signed 16-bit little-endian mono at 24 kHz. @internal */
export function formatInput(content: BidiModelInput): RealtimeClientEvent {
  if (content.type === 'audioDelta') {
    if (content.format !== 'pcm' || content.source.bytes.byteLength % 2 !== 0) {
      throw new Error('Realtime input requires aligned PCM16 samples at 24 kHz')
    }
    return { type: 'input_audio_buffer.append', audio: encodeBase64(content.source.bytes) }
  }
  return { type: 'conversation.item.create', item: formatItem(content, 'user') }
}

/** Completed responses expose only complete, parsed tool requests. @internal */
export function formatToolCalls(response: RealtimeResponse): ToolUseStreamEvent[] {
  if (response.status !== 'completed') return []
  const calls: ToolUseStreamEvent[] = []
  for (const item of response.output ?? []) {
    if (item.type !== 'function_call') continue
    if (!item.call_id || !item.name || item.arguments === undefined) {
      throw new ModelError('Incomplete Realtime tool request')
    }
    calls.push({
      type: 'toolUseStream',
      delta: { type: 'toolUseInputDelta', input: item.arguments },
      currentToolUse: {
        toolUseId: item.call_id,
        name: item.name,
        input: JSON.parse(item.arguments) as JSONValue,
      },
    })
  }
  return calls
}
