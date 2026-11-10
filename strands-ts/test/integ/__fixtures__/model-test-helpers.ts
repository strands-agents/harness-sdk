import type { ContentBlock, Message } from '$/sdk/types/messages.js'

/**
 * Extracts plain text content from a Message object.
 *
 * This helper function handles different message formats by:
 * - Extracting text from Message objects by filtering for textBlock content blocks
 * - Joining multiple text blocks with newlines
 *
 * @param message - The message to extract text from. Message object with content blocks
 * @returns The extracted text content as a string, or empty string if no content is found
 */
export const getMessageText = (message: Message): string => {
  if (!message.content) return ''

  return message.content
    .filter((block: ContentBlock) => block.type === 'textBlock')
    .map((block) => block.text)
    .join('\n')
}
