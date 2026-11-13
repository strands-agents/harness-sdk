import { Message, TextBlock, ToolResultBlock, type ContentBlock, type ToolResultContent } from '../types/messages.js'
import type { ToolSpec } from '../tools/types.js'

/**
 * Sends the tool references in each tool result as text, unless `keepsReferences` is set and every block of the result
 * is a reference to a tool the request defers (`deferLoading`). The Claude API rejects a tool result that mixes tool
 * references with other content, and a reference to a tool its request doesn't list. The text gives the parameters of
 * the request's tool with the reference's name.
 *
 * @param messages - The messages of a model call
 * @param toolSpecs - The tool specs of the call
 * @param keepsReferences - Whether the call's model defers tools natively, so references to deferred tools can stay
 * @returns The messages to send; the input is never changed
 * @internal
 */
export function withToolReferenceText(messages: Message[], toolSpecs: ToolSpec[], keepsReferences: boolean): Message[] {
  if (!hasToolReferences(messages)) return messages
  const specs = new Map(toolSpecs.map((spec) => [spec.name, spec]))
  const keeps = (content: ToolResultContent): boolean =>
    keepsReferences && content.type === 'toolReferenceBlock' && specs.get(content.name)?.deferLoading === true
  const sendsText = (block: ContentBlock): block is ToolResultBlock =>
    hasToolReference(block) && !block.content.every(keeps)
  const asText = (content: ToolResultContent): ToolResultContent =>
    content.type === 'toolReferenceBlock'
      ? new TextBlock(referenceText(content.name, specs.get(content.name)))
      : content
  return messages.map((message) =>
    message.content.some(sendsText)
      ? new Message({
          role: message.role,
          content: message.content.map((block) =>
            sendsText(block)
              ? new ToolResultBlock({
                  toolUseId: block.toolUseId,
                  status: block.status,
                  content: block.content.map(asText),
                  ...(block.error !== undefined && { error: block.error }),
                })
              : block
          ),
          trackingId: message.trackingId,
          ...(message.metadata !== undefined && { metadata: message.metadata }),
        })
      : message
  )
}

/**
 * Whether any tool result in the messages holds a tool reference.
 *
 * @param messages - The messages of a model call
 * @returns `true` when a tool result holds a `ToolReferenceBlock`
 * @internal
 */
export function hasToolReferences(messages: Message[]): boolean {
  return messages.some((message) => message.content.some(hasToolReference))
}

function referenceText(name: string, spec: ToolSpec | undefined): string {
  if (!spec) return `Loaded tool ${name}, which this request doesn't include.`
  return `${name} parameters: ${JSON.stringify(spec.inputSchema ?? {})}`
}

function hasToolReference(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'toolResultBlock' && block.content.some((content) => content.type === 'toolReferenceBlock')
}
