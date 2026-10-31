import type { ReactElement } from 'react'
import { Box } from 'ink'

import type { ChatMediaContent, ChatToolResultContent } from '../chat/controller.js'
import { expandTabs, formatValue } from './presentation.js'
import { Text, useTheme } from './theme.js'

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
    <Box flexDirection="column">
      <Text color={theme.accent}>
        document: {content.name}.{content.format}, {sourceLabel(content.source)}
      </Text>
      {content.source.type === 'text' ? <DocumentPreview text={content.source.text} /> : null}
      {content.source.type === 'content' ? <DocumentPreview text={content.source.content.join('\n')} /> : null}
      {content.context ? <Text dimColor>{content.context}</Text> : null}
    </Box>
  )
}

export function ToolResultContentView({ content }: { content: readonly ChatToolResultContent[] }): ReactElement {
  return (
    <Box flexDirection="column">
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
    </Box>
  )
}

function DocumentPreview({ text }: { text: string }): ReactElement {
  const theme = useTheme()
  const lines = text.split('\n')
  const visible = lines.slice(0, 6)
  return (
    <Box backgroundColor={theme.surface} paddingX={1} flexDirection="column" marginTop={1}>
      {visible.map((line, index) => (
        <Text key={`document-${index}`} dimColor>
          {expandTabs(line) || ' '}
        </Text>
      ))}
      {lines.length > visible.length ? <Text dimColor>... {lines.length - visible.length} more lines</Text> : null}
    </Box>
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
