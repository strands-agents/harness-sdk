import type { ReactElement } from 'react'

import type { ChatAttachmentSummary } from '../chat/types.js'
import { Box, Text, useTheme } from './theme.js'

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
