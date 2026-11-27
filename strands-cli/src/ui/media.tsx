import { type ReactElement } from 'react'
import type { ChatAttachmentSummary, ChatMediaContent, ChatToolResultContent } from '../agent/types.js'
import { Box, Text, useTheme } from './theme.js'
import { Box as InkBox } from 'ink'
import { formatValue } from './presentation.js'
import { expandTabs } from '../terminal/text.js'

export function attachmentPreviewRows(attachments: readonly ChatAttachmentSummary[]): number {
  return Math.min(2, attachments.length)
}

export function AttachmentPreview({
  attachments,
  maxRows = 2,
}: {
  attachments: readonly ChatAttachmentSummary[]
  maxRows?: number
}): ReactElement {
  const { accent } = useTheme()
  const visible = attachments.length > maxRows ? attachments.slice(0, Math.max(0, maxRows - 1)) : attachments
  return (
    <Box flexDirection="column" flexShrink={0} overflow="hidden">
      {visible.map((attachment) => (
        <Box key={`${attachment.name}:${attachment.size}`} height={1} flexShrink={0} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color={accent}>
              {attachment.kind === 'image' ? '▣' : '◆'} {attachment.name}
            </Text>
            <Text dimColor> · {formatBytes(attachment.size)}</Text>
          </Text>
        </Box>
      ))}
      {attachments.length > visible.length ? (
        <Box height={1} flexShrink={0}>
          <Text dimColor>+ {attachments.length - visible.length} more attached</Text>
        </Box>
      ) : null}
    </Box>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function MediaView({ content }: { content: ChatMediaContent }): ReactElement {
  const theme = useTheme()
  if (content.type !== 'document') {
    return (
      <Text color={theme.accent}>
        {content.type}: {content.format}, {sourceLabel(content.source)}
        {content.type === 'video' ? ' (terminal preview unavailable)' : null}
      </Text>
    )
  }

  return (
    <InkBox flexDirection="column">
      <Text color={theme.accent}>
        document: {content.name}.{content.format}, {sourceLabel(content.source)}
      </Text>
      {content.source.type === 'text' ? <DocumentPreview text={content.source.text} /> : null}
      {content.source.type === 'content' ? <DocumentPreview text={content.source.content.join('\n')} /> : null}
      {content.context ? <Text dimColor>{content.context}</Text> : null}
    </InkBox>
  )
}

export function ToolResultContentView({ content }: { content: readonly ChatToolResultContent[] }): ReactElement {
  return (
    <InkBox flexDirection="column">
      {content.map((item, index) => {
        if (item.type === 'text' || item.type === 'json') {
          return (
            <Text key={`${item.type}-${index}`} dimColor>
              {item.type === 'text' ? expandTabs(item.text) : formatValue(item.value)}
            </Text>
          )
        }
        return <MediaView key={`media-${index}`} content={item} />
      })}
    </InkBox>
  )
}

function DocumentPreview({ text }: { text: string }): ReactElement {
  const theme = useTheme()
  const lines = text.split('\n')
  const visible = lines.slice(0, 6)
  return (
    <InkBox backgroundColor={theme.surface} paddingX={1} flexDirection="column" marginTop={1}>
      {visible.map((line, index) => (
        <Text key={`document-${index}`} dimColor>
          {expandTabs(line) || ' '}
        </Text>
      ))}
      {lines.length > visible.length ? <Text dimColor>... {lines.length - visible.length} more lines</Text> : null}
    </InkBox>
  )
}

function sourceLabel(source: ChatMediaContent['source']): string {
  switch (source.type) {
    case 'bytes':
      return `${source.bytes.byteLength.toLocaleString()} bytes`
    case 'url':
      return source.url
    case 's3':
      return source.location.uri
    case 'text':
      return `${source.text.length.toLocaleString()} characters`
    case 'content':
      return `${source.content.length.toLocaleString()} blocks`
  }
}
