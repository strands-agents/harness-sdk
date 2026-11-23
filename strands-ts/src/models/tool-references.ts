import {
  JsonBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  type ContentBlock,
  type ToolResultContent,
} from '../types/messages.js'
import type { ToolSpec } from '../tools/types.js'
import type { JSONValue } from '../types/json.js'

/**
 * Sends the tool references in each tool result as text, unless every block of the result is a reference to a tool
 * the request lists and keeps as a reference (`keptReferences`). The Claude API rejects a tool result that mixes tool
 * references with other content, and a reference to a tool its request doesn't list. The text gives the parameters of
 * the request's tool with the reference's name.
 *
 * @param messages - The messages of a model call
 * @param toolSpecs - The tool specs of the call
 * @param keptReferences - The tools whose references stay as they are: those the call defers, when its model defers
 *   tools natively
 * @returns The messages to send; the input is never changed
 * @internal
 */
export function withToolReferenceText(
  messages: Message[],
  toolSpecs: ToolSpec[],
  keptReferences: ReadonlySet<string> = new Set()
): Message[] {
  return replaceReferences(
    messages,
    toolSpecs,
    keptReferences,
    (name, spec) => new TextBlock(referenceText(name, spec))
  )
}

/**
 * Puts the input schema each tool reference brings into the model's context in its place, as JSON, so a count of the
 * request measures a loaded schema the way it measures a tool spec.
 *
 * @param messages - The messages of a model call
 * @param toolSpecs - The tool specs of the call
 * @returns The messages to count; the input is never changed
 * @internal
 */
export function withToolReferenceSchemas(messages: Message[], toolSpecs: ToolSpec[]): Message[] {
  return replaceReferences(messages, toolSpecs, new Set(), (name, spec) =>
    spec ? new JsonBlock({ json: (spec.inputSchema ?? {}) as JSONValue }) : new TextBlock(referenceText(name, spec))
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

/**
 * Whether a tool result holds a tool reference, as a loader's result and the answer to a call made before its tool's
 * load do. Such a result is what keeps a loaded tool's schema in the model's context.
 *
 * @param block - The tool result
 * @returns `true` when a block of the result is a `ToolReferenceBlock`
 * @internal
 */
export function holdsToolReference(block: ToolResultBlock): boolean {
  return block.content.some((content) => content.type === 'toolReferenceBlock')
}

/** The messages with `render`'s content in place of each tool reference in a result that can't keep its references. */
function replaceReferences(
  messages: Message[],
  toolSpecs: ToolSpec[],
  keptReferences: ReadonlySet<string>,
  render: (name: string, spec: ToolSpec | undefined) => ToolResultContent
): Message[] {
  if (!hasToolReferences(messages)) return messages
  const specs = new Map(toolSpecs.map((spec) => [spec.name, spec]))
  const keeps = (content: ToolResultContent): boolean =>
    content.type === 'toolReferenceBlock' && keptReferences.has(content.name) && specs.has(content.name)
  const replaces = (block: ContentBlock): block is ToolResultBlock =>
    hasToolReference(block) && !block.content.every(keeps)
  const replace = (content: ToolResultContent): ToolResultContent =>
    content.type === 'toolReferenceBlock' ? render(content.name, specs.get(content.name)) : content
  return messages.map((message) =>
    message.content.some(replaces)
      ? new Message({
          role: message.role,
          content: message.content.map((block) =>
            replaces(block)
              ? new ToolResultBlock({
                  toolUseId: block.toolUseId,
                  status: block.status,
                  content: block.content.map(replace),
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
 * The text a tool reference becomes where it can't stay a reference: the parameters of the request's tool with its
 * name.
 *
 * @param name - The referenced tool's name
 * @param spec - The request's tool with that name, if it has one
 * @returns The text to send in the reference's place
 * @internal
 */
export function referenceText(name: string, spec: ToolSpec | undefined): string {
  if (!spec) return `Loaded tool ${name}, which this request doesn't include.`
  return `${name} parameters: ${JSON.stringify(spec.inputSchema ?? {})}`
}

function hasToolReference(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'toolResultBlock' && holdsToolReference(block)
}
