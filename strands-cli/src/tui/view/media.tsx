import type { ReactElement } from 'react'
import { Box } from 'ink'

import type { ChatMediaContent, ChatToolResultContent } from '../chat/controller.js'
import { formatValue } from './presentation.js'
import { Text, useTheme } from './theme.js'

type TerminalImageProtocol = 'iterm2' | 'kitty'

export function terminalImageProtocol(environment: NodeJS.ProcessEnv = process.env): TerminalImageProtocol | undefined {
  if (environment.KITTY_WINDOW_ID || environment.TERM === 'xterm-kitty') {
    return 'kitty'
  }
  if (environment.TERM_PROGRAM === 'iTerm.app' || environment.LC_TERMINAL === 'iTerm2') {
    return 'iterm2'
  }
  return undefined
}

export function terminalImageSequence(
  bytes: Uint8Array,
  protocol: TerminalImageProtocol,
  columns = 56,
  rows = 10
): string {
  const data = Buffer.from(bytes).toString('base64')
  if (protocol === 'iterm2') {
    return `\u001b]1337;File=inline=1;width=${columns};height=${rows};preserveAspectRatio=1:${data}\u0007`
  }

  const chunks = data.match(/.{1,4096}/g) ?? ['']
  return chunks
    .map((chunk, index) => {
      const more = index < chunks.length - 1 ? 1 : 0
      const parameters = index === 0 ? `a=T,f=100,q=2,c=${columns},r=${rows},m=${more}` : `m=${more}`
      return `\u001b_G${parameters};${chunk}\u001b\\`
    })
    .join('')
}

export function MediaView({
  content,
  maxColumns = 56,
}: {
  content: ChatMediaContent
  maxColumns?: number
}): ReactElement {
  const theme = useTheme()
  if (content.type === 'image') {
    const protocol = terminalImageProtocol()
    if (protocol && content.source.type === 'bytes') {
      const rows = 10
      return (
        <Box flexDirection="column">
          <Text>{terminalImageSequence(content.source.bytes, protocol, maxColumns, rows)}</Text>
          {Array.from({ length: rows }, (_, index) => (
            <Text key={`image-row-${index}`}> </Text>
          ))}
          <Text dimColor>
            image: {content.format}, {content.source.bytes.byteLength.toLocaleString()} bytes
          </Text>
        </Box>
      )
    }
  }

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
              {item.type === 'text' ? item.text : formatValue(item.value)}
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
          {line || ' '}
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
