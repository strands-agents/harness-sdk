import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'

import type {
  ChatConfigurationDiffs,
  ChatConfigurationDocument,
  ChatConfigurationLanguage,
  ChatConfigurationSource,
  ChatDiffPreview,
} from '../chat/types.js'
import { graphemes } from '../terminal/composer.js'
import { CONFIG_DOCK_CHROME_HEIGHT, configurationDockCodeSize } from './interaction.js'
import { Box, Text, useTheme } from './theme.js'

interface ConfigurationRow {
  line?: number
  continuation: boolean
  text: string
  kind: 'source' | 'context' | 'add' | 'remove' | 'header'
}

interface SyntaxSegment {
  text: string
  tone?: 'comment' | 'keyword' | 'string' | 'number' | 'call'
}

const LABELS: Record<ChatConfigurationLanguage, string> = {
  typescript: 'TypeScript',
  python: 'Python',
}

export const CONFIGURATION_OPEN_CONTROL = 'configuration:open-project'

const TYPESCRIPT_KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'const',
  'else',
  'export',
  'false',
  'from',
  'function',
  'if',
  'import',
  'new',
  'null',
  'return',
  'true',
  'undefined',
])
const PYTHON_KEYWORDS = new Set([
  'as',
  'def',
  'else',
  'False',
  'from',
  'if',
  'import',
  'in',
  'None',
  'not',
  'return',
  'True',
])
const TOKEN_PATTERN =
  /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|#.*|\b(?:\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*\b)/gu

export function configurationDocument(
  configuration: ChatConfigurationSource,
  language: string
): { language: ChatConfigurationLanguage; document: ChatConfigurationDocument } {
  const selected = language === 'python' ? 'python' : 'typescript'
  return { language: selected, document: configuration.documents[selected] }
}

export function configurationRows(source: string, width: number): ConfigurationRow[] {
  const lines = source.replaceAll('\t', '    ').replaceAll('\r', '').split('\n')
  const lineWidth = String(Math.max(1, lines.length)).length
  const contentWidth = Math.max(1, width - lineWidth - 2)
  return lines.flatMap((line, index) => {
    const chunks = wrapCodeLine(line, contentWidth)
    return chunks.map((text, chunk) => ({
      line: index + 1,
      continuation: chunk > 0,
      text,
      kind: 'source',
    }))
  })
}

export function maxConfigurationScroll(source: string, width: number, height: number, diff?: ChatDiffPreview): number {
  return Math.max(0, configurationDisplayRows(source, diff, width).length - Math.max(1, height))
}

/** The passive dock's height: fits the content, capped at half the available rows. */
export function passiveConfigurationDockHeight(
  available: number,
  configuration: ChatConfigurationSource,
  diffs: ChatConfigurationDiffs | undefined,
  language: string | undefined,
  width: number
): number {
  const selected = configurationDocument(configuration, language ?? configuration.preferredLanguage)
  const codeWidth = configurationDockCodeSize(width, Number.MAX_SAFE_INTEGER).width
  const rowCount = configurationDisplayRows(selected.document.source, diffs?.[selected.language], codeWidth).length
  const cap = Math.max(CONFIG_DOCK_CHROME_HEIGHT + 1, Math.ceil(available / 2))
  return Math.max(1, Math.min(available, cap, CONFIG_DOCK_CHROME_HEIGHT + rowCount))
}

export function ConfigurationDock({
  configuration,
  configurationDiffs,
  explicit = false,
  language,
  scroll,
  width,
  height,
  pressedFilter,
  hoveredFilter,
  pressedOpen,
  hoveredOpen,
  onElement,
  onFilterElement,
  onOpenElement,
}: {
  configuration: ChatConfigurationSource
  configurationDiffs?: ChatConfigurationDiffs
  /** The /config panel view, as opposed to the passive dock beside a running turn. */
  explicit?: boolean
  language?: string
  scroll?: number
  width: number
  height: number
  pressedFilter?: string
  hoveredFilter?: string
  pressedOpen?: boolean
  hoveredOpen?: boolean
  onElement?: (element: DOMElement | null) => void
  onFilterElement?: (id: string, element: DOMElement | null) => void
  onOpenElement?: (element: DOMElement | null) => void
}): ReactElement {
  const { accent, border, selection, warning } = useTheme()
  const selected = configurationDocument(configuration, language ?? configuration.preferredLanguage)
  const codeSize = configurationDockCodeSize(width, height)
  const diff = configurationDiffs?.[selected.language]
  const rows = configurationDisplayRows(selected.document.source, diff, codeSize.width)
  const requestedStart =
    scroll ??
    (diff ? changeAnchor(rows, codeSize.height) : configurationAnchor(rows, selected.document.source, codeSize.height))
  const start = Math.max(0, Math.min(requestedStart, rows.length - codeSize.height))
  const end = Math.min(rows.length, start + codeSize.height)
  const progress = rows.length > codeSize.height ? `${start + 1}-${end}/${rows.length}` : undefined
  const switchHint = explicit ? languageSwitchHint(width, progress, configuration.project !== undefined) : undefined
  return (
    <Box
      ref={onElement}
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      borderStyle="single"
      borderColor={accent}
      paddingX={1}
    >
      <Box height={1} flexShrink={0} justifyContent="space-between" overflow="hidden">
        <Box flexShrink={0}>
          {(Object.keys(LABELS) as ChatConfigurationLanguage[]).map((id, index) => {
            const active = id === selected.language
            const pressed = id === pressedFilter
            return (
              <Box
                key={id}
                ref={(element) => onFilterElement?.(id, element)}
                marginLeft={index > 0 ? 1 : 0}
                paddingX={1}
                backgroundColor={id === hoveredFilter || pressed ? selection : undefined}
              >
                <Text {...(active ? { color: accent } : {})} bold={active} dimColor={!active}>
                  {LABELS[id]}
                </Text>
              </Box>
            )
          })}
        </Box>
        {switchHint ? (
          <Box flexGrow={1} marginLeft={1}>
            <Text dimColor>{switchHint}</Text>
          </Box>
        ) : null}
        <Box flexShrink={0}>
          {progress ? (
            <Text dimColor wrap="truncate-end">
              {progress}
            </Text>
          ) : null}
          {explicit && configuration.project ? (
            <Box
              ref={onOpenElement}
              marginLeft={1}
              paddingX={1}
              backgroundColor={hoveredOpen || pressedOpen ? selection : undefined}
            >
              <Text color={accent} bold>
                Open
              </Text>
            </Box>
          ) : null}
        </Box>
      </Box>
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text color={border}>{'─'.repeat(codeSize.width)}</Text>
      </Box>
      {selected.document.error ? (
        <Box flexGrow={1} overflow="hidden">
          <Text color={warning} wrap="wrap">
            {selected.document.error}
          </Text>
        </Box>
      ) : (
        <ConfigurationCode
          rows={rows.slice(start, end)}
          totalLines={selected.document.source.split('\n').length}
          language={selected.language}
          width={codeSize.width}
        />
      )}
    </Box>
  )
}

/** The arrow-key note beside the language tabs, shortened to whatever room the header leaves. */
function languageSwitchHint(width: number, progress: string | undefined, openable: boolean): string | undefined {
  const tabs = Object.values(LABELS).reduce((total, label, index) => total + label.length + 2 + (index > 0 ? 1 : 0), 0)
  const actions = (progress?.length ?? 0) + (openable ? 7 : 0)
  // Border and padding take four columns; the note keeps a column of space on each side.
  const room = width - 4 - tabs - actions - 2
  return room >= '←→ switch'.length ? '←→ switch' : room >= 2 ? '←→' : undefined
}

function ConfigurationCode({
  rows,
  totalLines,
  language,
  width,
}: {
  rows: readonly ConfigurationRow[]
  totalLines: number
  language: ChatConfigurationLanguage
  width: number
}): ReactElement {
  const theme = useTheme()
  const lineWidth = String(Math.max(1, totalLines)).length
  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {rows.map((row, index) => {
        const background = row.kind === 'add' ? theme.diffAdd : row.kind === 'remove' ? theme.diffRemove : undefined
        const marker = row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : '│'
        const number = row.continuation ? '' : String(row.line ?? '')
        return (
          <Box
            key={`${row.kind}:${row.line ?? ''}:${index}`}
            width={width}
            height={1}
            flexShrink={0}
            overflow="hidden"
            {...(background ? { backgroundColor: background } : {})}
          >
            <Text dimColor {...(background ? { backgroundColor: background } : {})}>
              {`${number.padStart(lineWidth)} `}
            </Text>
            <Text
              {...(row.kind === 'add' ? { color: theme.success } : row.kind === 'remove' ? { color: theme.error } : {})}
              dimColor={!background}
              bold={background !== undefined}
              {...(background ? { backgroundColor: background } : {})}
            >
              {row.continuation && !background ? ' ' : marker}
            </Text>
            <SyntaxText text={row.text} language={language} {...(background ? { backgroundColor: background } : {})} />
          </Box>
        )
      })}
    </Box>
  )
}

function SyntaxText({
  text,
  language,
  backgroundColor,
}: {
  text: string
  language: ChatConfigurationLanguage
  backgroundColor?: string
}): ReactElement {
  const theme = useTheme()
  return (
    <Text wrap="truncate-end" {...(backgroundColor ? { backgroundColor } : {})}>
      {syntaxSegments(text, language).map((segment, index) => (
        <Text
          key={index}
          {...(segment.tone === 'comment'
            ? { dimColor: true }
            : segment.tone === 'keyword'
              ? { color: theme.accent, bold: true }
              : segment.tone === 'string'
                ? { color: theme.success }
                : segment.tone === 'number'
                  ? { color: theme.warning }
                  : segment.tone === 'call'
                    ? { color: theme.hover, bold: true }
                    : {})}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  )
}

function syntaxSegments(value: string, language: ChatConfigurationLanguage): SyntaxSegment[] {
  const result: SyntaxSegment[] = []
  let offset = 0
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    if (match.index > offset) result.push({ text: value.slice(offset, match.index) })
    const text = match[0]
    const keyword = (language === 'python' ? PYTHON_KEYWORDS : TYPESCRIPT_KEYWORDS).has(text)
    const tone =
      text.startsWith('//') || text.startsWith('#')
        ? 'comment'
        : text.startsWith('"') || text.startsWith("'") || text.startsWith('`')
          ? 'string'
          : /^\d/u.test(text)
            ? 'number'
            : text === 'createHarness' || text === 'create_harness'
              ? 'call'
              : keyword
                ? 'keyword'
                : undefined
    result.push({ text, ...(tone ? { tone } : {}) })
    offset = match.index + text.length
  }
  if (offset < value.length) result.push({ text: value.slice(offset) })
  return result.length > 0 ? result : [{ text: value }]
}

function wrapCodeLine(value: string, width: number): string[] {
  if (!value) return ['']
  const rows: string[] = []
  let row = ''
  for (const token of value.match(/\s+|\S+/gu) ?? []) {
    if (row.trim() && stringWidth(row + token) > width) {
      rows.push(row)
      row = ''
    }
    for (const grapheme of graphemes(token)) {
      if (row && stringWidth(row + grapheme) > width) {
        rows.push(row)
        row = ''
      }
      row += grapheme
    }
  }
  rows.push(row)
  return rows
}

function configurationDisplayRows(
  source: string,
  diff: ChatDiffPreview | undefined,
  width: number
): ConfigurationRow[] {
  if (!diff) return configurationRows(source, width)
  const totalLines = source.split('\n').length
  const lineWidth = String(Math.max(1, totalLines)).length
  const contentWidth = Math.max(1, width - lineWidth - 2)
  return diff.lines.flatMap((line) =>
    line.kind === 'header'
      ? []
      : wrapCodeLine(line.text, contentWidth).map((text, chunk) => ({
          ...(line.kind === 'remove'
            ? { line: line.oldLine }
            : line.kind === 'add' || line.kind === 'context'
              ? { line: line.newLine }
              : {}),
          continuation: chunk > 0,
          text,
          kind: line.kind,
        }))
  )
}

/** Opens a diff a few rows above its first change, so the change is visible with some context. */
function changeAnchor(rows: readonly ConfigurationRow[], height: number): number {
  const first = rows.findIndex((row) => row.kind === 'add' || row.kind === 'remove')
  return Math.max(0, Math.min(rows.length - height, first - 2))
}

function configurationAnchor(rows: readonly ConfigurationRow[], source: string, height: number): number {
  const lines = source.split('\n')
  const line = lines.findIndex((value) => value.includes('await createHarness(') || value.includes('= create_harness('))
  if (line < 0) return 0
  const target = rows.findIndex((row) => row.line === line + 1)
  return Math.max(0, Math.min(rows.length - height, target - 1))
}
