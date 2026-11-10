import { Fragment, memo, type ReactElement, type ReactNode } from 'react'
import { URL } from 'node:url'
import { Box } from 'ink'
import { marked, type Token, type Tokens } from 'marked'

import { Text, useTheme, type Theme } from './theme.js'

export const Markdown = memo(function Markdown({ children }: { children: string }): ReactElement {
  const theme = useTheme()
  const tokens = marked.lexer(children, { breaks: true, gfm: true })
  return (
    <Box flexDirection="column">
      {tokens.map((token, index) =>
        token.type === 'space' ? <Box key={`block-${index}`} height={1} /> : renderBlock(token, `block-${index}`, theme)
      )}
    </Box>
  )
})

function renderBlock(token: Token, key: string, theme: Theme): ReactNode {
  switch (token.type) {
    case 'def':
      return null
    case 'heading': {
      const heading = token as Tokens.Heading
      return (
        <Box key={key} marginTop={heading.depth > 2 ? 0 : 1}>
          <Text bold {...(heading.depth <= 2 ? { color: theme.accent } : {})}>
            {renderInline(heading.tokens, key, theme)}
          </Text>
        </Box>
      )
    }
    case 'paragraph':
      return <Text key={key}>{renderInline((token as Tokens.Paragraph).tokens, key, theme)}</Text>
    case 'text': {
      const text = token as Tokens.Text
      return <Text key={key}>{text.tokens ? renderInline(text.tokens, key, theme) : text.text}</Text>
    }
    case 'code': {
      const code = token as Tokens.Code
      return (
        <Box key={key} backgroundColor={theme.surface} paddingX={1} marginY={1} flexDirection="column">
          {code.lang ? <Text dimColor>{code.lang}</Text> : null}
          <Text color="green">{code.text}</Text>
        </Box>
      )
    }
    case 'blockquote': {
      const blockquote = token as Tokens.Blockquote
      return (
        <Box key={key} paddingLeft={1} marginY={1} flexDirection="column" backgroundColor={theme.surface}>
          {blockquote.tokens.map((child, index) => renderBlock(child, `${key}-${index}`, theme))}
        </Box>
      )
    }
    case 'list': {
      const list = token as Tokens.List
      return (
        <Box key={key} flexDirection="column" marginY={1}>
          {list.items.map((item, index) => renderListItem(list, item, index, `${key}-${index}`, theme))}
        </Box>
      )
    }
    case 'table':
      return <Table key={key} token={token as Tokens.Table} />
    case 'hr':
      return (
        <Text key={key} dimColor>
          {'─'.repeat(40)}
        </Text>
      )
    default:
      return <Text key={key}>{'text' in token && typeof token.text === 'string' ? token.text : token.raw}</Text>
  }
}

function renderListItem(
  list: Tokens.List,
  item: Tokens.ListItem,
  index: number,
  key: string,
  theme: Theme
): ReactElement {
  const marker = item.task ? (item.checked ? '[x]' : '[ ]') : list.ordered ? `${Number(list.start || 1) + index}.` : '•'
  return (
    <Box key={key}>
      <Box width={marker.length + 1} flexShrink={0}>
        <Text color={theme.accent}>{marker} </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {item.tokens.map((token, tokenIndex) => renderBlock(token, `${key}-${tokenIndex}`, theme))}
      </Box>
    </Box>
  )
}

function Table({ token }: { token: Tokens.Table }): ReactElement {
  const theme = useTheme()
  return (
    <Box backgroundColor={theme.surface} flexDirection="column" paddingX={1} marginY={1}>
      {[token.header, ...token.rows].map((row, rowIndex) => (
        <Text key={`row-${rowIndex}`} bold={rowIndex === 0}>
          {row.map((cell, cellIndex) => (
            <Fragment key={`cell-${cellIndex}`}>
              {cellIndex > 0 ? <Text dimColor> │ </Text> : null}
              {renderInline(cell.tokens, `cell-${rowIndex}-${cellIndex}`, theme)}
            </Fragment>
          ))}
        </Text>
      ))}
    </Box>
  )
}

function renderInline(tokens: readonly Token[], keyPrefix: string, theme: Theme): ReactNode {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-inline-${index}`
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del': {
        const style = {
          strong: { bold: true },
          em: { italic: true },
          del: { strikethrough: true },
        }[token.type]
        return (
          <Text key={key} {...style}>
            {renderInline((token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens, key, theme)}
          </Text>
        )
      }
      case 'codespan':
        return (
          <Text key={key} color={theme.warning} backgroundColor={theme.surface}>
            {` ${(token as Tokens.Codespan).text} `}
          </Text>
        )
      case 'link': {
        const link = token as Tokens.Link
        const target = process.env.TERM_PROGRAM === 'Apple_Terminal' ? undefined : hyperlinkTarget(link.href)
        return (
          <Text key={key} color={theme.accent} underline>
            {target ? `\u001b]8;;${target}\u0007` : ''}
            {renderInline(link.tokens, key, theme)}
            {target ? '\u001b]8;;\u0007' : link.text === link.href ? '' : ` (${link.href})`}
          </Text>
        )
      }
      case 'image': {
        const image = token as Tokens.Image
        return (
          <Text key={key} color={theme.accent}>
            [image: {image.text || image.href}]
          </Text>
        )
      }
      case 'br':
        return '\n'
      case 'text': {
        const text = token as Tokens.Text
        return <Fragment key={key}>{text.tokens ? renderInline(text.tokens, key, theme) : text.text}</Fragment>
      }
      default:
        return <Fragment key={key}>{'text' in token ? String(token.text) : token.raw}</Fragment>
    }
  })
}

function hyperlinkTarget(href: string): string | undefined {
  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:', 'file:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}
