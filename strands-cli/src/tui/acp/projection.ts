import * as acp from '@agentclientprotocol/sdk'
import type { Agent, ContentBlockData, DocumentFormat, ImageFormat } from '@strands-agents/sdk'

import type { ChatEvent, ChatMediaContent, ChatToolResultContent, TokenUsage } from '../chat/controller.js'
import { projectMediaContent, projectToolResultContent } from '../chat/sdk-projector.js'

const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] satisfies readonly ImageFormat[]
const DOCUMENT_FORMATS = [
  'pdf',
  'csv',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'html',
  'txt',
  'md',
  'json',
  'xml',
] satisfies readonly DocumentFormat[]

const DOCUMENT_MIME_ENTRIES: [DocumentFormat, string][] = [
  ['csv', 'text/csv'],
  ['html', 'text/html'],
  ['json', 'application/json'],
  ['md', 'text/markdown'],
  ['pdf', 'application/pdf'],
  ['txt', 'text/plain'],
  ['xml', 'application/xml'],
]
const DOCUMENT_MIME_TYPES = Object.fromEntries(DOCUMENT_MIME_ENTRIES)
const MIME_DOCUMENT_FORMATS = Object.fromEntries(
  DOCUMENT_MIME_ENTRIES.map(([format, mimeType]): [string, DocumentFormat] => [mimeType, format])
)

function imageFormat(mimeType: string): ImageFormat | undefined {
  const extension = mimeType.toLowerCase().split('/')[1]
  return IMAGE_FORMATS.find((format) => format === extension)
}

function documentFormat(mimeType: string | null | undefined, name: string): DocumentFormat {
  const extension = name.toLowerCase().split('.').at(-1)
  const byExtension = DOCUMENT_FORMATS.find((format) => format === extension)
  if (byExtension) {
    return byExtension
  }
  return (mimeType && MIME_DOCUMENT_FORMATS[mimeType.toLowerCase()]) || 'txt'
}

export async function replaySessionHistory(
  agent: Pick<Agent, 'messages'>,
  sessionId: string,
  client: acp.AgentContext
): Promise<void> {
  for (const message of agent.messages) {
    for (const block of message.content) {
      switch (block.type) {
        case 'textBlock':
          await sendSessionUpdate(client, sessionId, {
            sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            messageId: message.trackingId,
            content: { type: 'text', text: block.text },
          })
          break
        case 'reasoningBlock':
          if (message.role === 'assistant' && block.text) {
            await sendSessionUpdate(client, sessionId, {
              sessionUpdate: 'agent_thought_chunk',
              messageId: message.trackingId,
              content: { type: 'text', text: block.text },
            })
          }
          break
        case 'toolUseBlock':
          await sendSessionUpdate(client, sessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: block.toolUseId,
            title: block.name,
            name: block.name,
            kind: toolKind(block.name),
            status: 'in_progress',
            rawInput: block.input,
          })
          break
        case 'toolResultBlock':
          await sendSessionUpdate(client, sessionId, {
            sessionUpdate: 'tool_call_update',
            toolCallId: block.toolUseId,
            status: block.status === 'success' ? 'completed' : 'failed',
            content: block.content.map((content) => ({
              type: 'content',
              content: toolContentToAcp(projectToolResultContent(content)),
            })),
            ...(block.error ? { rawOutput: { error: block.error.message } } : {}),
          })
          break
        case 'imageBlock':
        case 'videoBlock':
        case 'documentBlock': {
          const media = projectMediaContent(block)
          await sendSessionUpdate(client, sessionId, {
            sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            messageId: message.trackingId,
            content: mediaToAcp(media),
          })
          break
        }
        case 'cachePointBlock':
        case 'guardContentBlock':
        case 'citationsBlock':
          break
      }
    }
  }
}

export async function sendChatEvent(client: acp.AgentContext, sessionId: string, event: ChatEvent): Promise<void> {
  switch (event.type) {
    case 'textDelta':
    case 'reasoningDelta':
      await sendSessionUpdate(client, sessionId, {
        sessionUpdate: event.type === 'textDelta' ? 'agent_message_chunk' : 'agent_thought_chunk',
        content: { type: 'text', text: event.text },
      })
      break
    case 'media':
      await sendSessionUpdate(client, sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: mediaToAcp(event.content),
      })
      break
    case 'toolStart':
      await sendSessionUpdate(client, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: event.toolUseId,
        title: event.name,
        name: event.name,
        kind: toolKind(event.name),
        status: 'in_progress',
        rawInput: event.input,
      })
      break
    case 'toolResult':
      await sendSessionUpdate(client, sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.toolUseId,
        status: event.status === 'success' ? 'completed' : 'failed',
        content: event.content.map((content) => ({
          type: 'content',
          content: toolContentToAcp(content),
        })),
        ...(event.error ? { rawOutput: { error: event.error } } : {}),
      })
      break
  }
}

export function projectPrompt(prompt: readonly acp.ContentBlock[]): ContentBlockData[] {
  return prompt.flatMap((content): ContentBlockData[] => {
    switch (content.type) {
      case 'text':
        return [{ text: content.text }]
      case 'image': {
        const format = imageFormat(content.mimeType)
        return format
          ? [{ image: { format, source: { bytes: Uint8Array.from(Buffer.from(content.data, 'base64')) } } }]
          : [{ text: `[unsupported image: ${content.mimeType}]` }]
      }
      case 'resource_link':
        return [{ text: `${content.name}: ${content.uri}` }]
      case 'resource':
        return [embeddedResourceToContent(content.resource)]
      case 'audio':
        return [{ text: `[audio: ${content.mimeType}]` }]
    }
  })
}

function embeddedResourceToContent(resource: acp.EmbeddedResourceResource): ContentBlockData {
  const name = resource.uri.slice(resource.uri.lastIndexOf('/') + 1) || 'resource'
  const image = resource.mimeType ? imageFormat(resource.mimeType) : undefined
  if ('blob' in resource && image) {
    return {
      image: {
        format: image,
        source: { bytes: Uint8Array.from(Buffer.from(resource.blob, 'base64')) },
      },
    }
  }
  const format = documentFormat(resource.mimeType, name)
  const extension = name.lastIndexOf('.')
  return {
    document: {
      name: extension > 0 ? name.slice(0, extension) : name,
      format,
      source:
        'text' in resource ? { text: resource.text } : { bytes: Uint8Array.from(Buffer.from(resource.blob, 'base64')) },
    },
  }
}

function mediaToAcp(content: ChatMediaContent): acp.ContentBlock {
  if (content.type === 'image') {
    if (content.source.type === 'bytes') {
      return {
        type: 'image',
        mimeType: `image/${content.format === 'jpg' ? 'jpeg' : content.format}`,
        data: Buffer.from(content.source.bytes).toString('base64'),
      }
    }
    const uri = content.source.type === 'url' ? content.source.url : content.source.location.uri
    return { type: 'resource_link', name: 'image', uri, mimeType: `image/${content.format}` }
  }
  if (content.type === 'video') {
    const source =
      content.source.type === 's3'
        ? content.source.location.uri
        : `${content.source.bytes.byteLength.toLocaleString()} bytes`
    return { type: 'text', text: `[video: ${content.format}, ${source}]` }
  }

  const uri = `strands://document/${encodeURIComponent(content.name)}`
  const mimeType = DOCUMENT_MIME_TYPES[content.format] ?? 'application/octet-stream'
  switch (content.source.type) {
    case 'bytes':
      return {
        type: 'resource',
        resource: { uri, mimeType, blob: Buffer.from(content.source.bytes).toString('base64') },
      }
    case 'text':
      return { type: 'resource', resource: { uri, mimeType, text: content.source.text } }
    case 'content':
      return { type: 'resource', resource: { uri, mimeType, text: content.source.content.join('\n') } }
    case 's3':
      return { type: 'resource_link', name: content.name, uri: content.source.location.uri, mimeType }
  }
}

function toolContentToAcp(content: ChatToolResultContent): acp.ContentBlock {
  if (content.type === 'text') {
    return { type: 'text', text: content.text }
  }
  if (content.type === 'json') {
    return { type: 'text', text: JSON.stringify(content.value, null, 2) }
  }
  return mediaToAcp(content)
}

function toolKind(name: string): acp.ToolKind {
  const normalized = name.toLowerCase()
  if (normalized.includes('read')) return 'read'
  if (normalized.includes('write') || normalized.includes('edit')) return 'edit'
  if (normalized.includes('delete') || normalized.includes('remove')) return 'delete'
  if (normalized.includes('search')) return 'search'
  if (normalized.includes('fetch')) return 'fetch'
  if (normalized.includes('bash') || normalized.includes('shell') || normalized.includes('execute')) return 'execute'
  return 'other'
}

export function toAcpStopReason(reason: string): acp.StopReason {
  switch (reason) {
    case 'cancelled':
      return 'cancelled'
    case 'maxTokens':
    case 'limitOutputTokens':
    case 'limitTotalTokens':
    case 'modelContextWindowExceeded':
      return 'max_tokens'
    case 'limitTurns':
      return 'max_turn_requests'
    case 'contentFiltered':
    case 'guardrailIntervened':
    case 'refusal':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

export function toAcpUsage(usage: TokenUsage): acp.Usage | undefined {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return undefined
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedReadTokens: usage.cacheReadInputTokens,
    cachedWriteTokens: usage.cacheWriteInputTokens,
  }
}

function sendSessionUpdate(client: acp.AgentContext, sessionId: string, update: acp.SessionUpdate): Promise<void> {
  return client.notify(acp.methods.client.session.update, { sessionId, update })
}
