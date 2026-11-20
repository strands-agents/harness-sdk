import { useMemo, type ReactElement } from 'react'
import { useInput } from 'ink'
import stringWidth from 'string-width'

import { sanitizeTerminalText, wrapWords } from '../../terminal/text.js'
import { Box, Text, useTheme } from '../../ui/theme.js'
import type { CaseResult, EvaluatorVerdict } from './model.js'
import {
  Field,
  Fill,
  ItemList,
  KeyHints,
  labelWidthFor,
  Line,
  oneLine,
  PanelTitle,
  ProgressBar,
  Rule,
  shortcut,
  SplitLine,
  useCursor,
  useSyncedState,
  type ListItem,
} from './ui.js'

export interface ReportKey {
  readonly key: string
  readonly hint: string
  readonly run: (current?: CaseResult) => void
  readonly inCase?: boolean
}

export interface CaseReportProps {
  readonly command: string
  readonly context: readonly string[]
  readonly details: readonly string[]
  readonly cases: readonly CaseResult[]
  readonly expected?: number
  readonly summary: string
  readonly keys?: readonly ReportKey[]
  readonly backHint: string
  readonly width: number
  readonly height: number
  readonly onBack: () => void
}

const REPORT_CHROME_ROWS = 4
const SCORE_COLUMN = 6
const CASE_CHROME_ROWS = 2
const CASE_INDENT = '  '
const CASE_LABEL_GAP = 2

const caseLine = (result: CaseResult): ListItem => {
  const failure = result.verdicts.find((verdict) => !verdict.passed)
  return {
    key: result.name,
    label: result.name,
    detail: failure?.reason ?? result.verdicts[0]?.reason ?? '',
    mark: result.passed ? { text: '✓', tone: 'success' } : { text: '✗', tone: 'error' },
    ...(result.passed ? { tone: 'muted' as const } : {}),
  }
}

const failuresFirst = (cases: readonly CaseResult[]): CaseResult[] => [
  ...cases.filter((result) => !result.passed),
  ...cases.filter((result) => result.passed),
]

export const CaseReport = ({
  command,
  context,
  details,
  cases,
  expected = cases.length,
  summary,
  keys = [],
  backHint,
  width,
  height,
  onBack,
}: CaseReportProps): ReactElement => {
  const ordered = failuresFirst(cases)
  const cursor = useCursor(ordered.length)
  const reading = useSyncedState(false)
  const index = cursor.index
  const current = ordered[index]
  const failed = ordered.filter((result) => !result.passed).length
  const verdictRows = current?.verdicts.length ?? 0
  const capacity = Math.max(1, height - REPORT_CHROME_ROWS - verdictRows - 1)
  const read = (at: number): void => {
    if (!ordered[at]) return
    cursor.set(at)
    reading.set(true)
  }
  useInput((input, key) => {
    if (reading.current() && current) return
    const typed = shortcut(input, key)
    if (key.escape) onBack()
    else if (key.upArrow) cursor.move(-1)
    else if (key.downArrow) cursor.move(1)
    else if (key.return || key.rightArrow) read(cursor.current())
    else keys.find((choice) => choice.key === typed)?.run(current)
  })
  if (reading.value && current)
    return (
      <CaseView
        command={command}
        context={context}
        width={width}
        height={height}
        result={current}
        keys={keys.filter(({ inCase }) => inCase)}
        onBack={() => reading.set(false)}
      />
    )
  const labelWidth = labelWidthFor(current?.verdicts.map(({ evaluator }) => evaluator) ?? [], width)
  return (
    <>
      <PanelTitle
        name={command}
        parts={[...context, ...details]}
        right={<ProgressBar done={cases.length} total={expected} />}
      />
      <SplitLine
        left={<Tally passed={cases.length - failed} failed={failed} />}
        right={<Text dimColor>{summary}</Text>}
      />
      {ordered.length > 0 ? (
        <ItemList
          items={ordered.map(caseLine)}
          selected={index}
          capacity={capacity}
          labelWidth={labelWidthFor(
            ordered.map(({ name }) => name),
            width
          )}
          onClick={read}
        />
      ) : (
        <Line tone="muted">{'  No case has finished yet. Each case shows here when it ends.'}</Line>
      )}
      <Rule width={width} />
      {current?.verdicts.map((verdict) => (
        <Field
          key={verdict.evaluator}
          label={verdict.evaluator}
          value={`${(verdict.passed ? '✓' : '✗').padEnd(2)} ${verdict.score.toFixed(2).padEnd(SCORE_COLUMN)}${verdict.reason}`}
          labelWidth={labelWidth + 2}
          {...(verdict.passed ? {} : { tone: 'error' as const })}
        />
      ))}
      <Fill />
      <KeyHints
        hints={['↑↓', ...(ordered.length > 0 ? ['Enter open case'] : []), ...keys.map(({ hint }) => hint), backHint]}
      />
    </>
  )
}

interface CaseRow {
  readonly label: string
  readonly lead: string
  readonly text: string
  readonly passed?: boolean
}

const verdictLead = ({ passed, score }: EvaluatorVerdict): string => `${passed ? '✓' : '✗'} ${score.toFixed(2)}  `

const orNone = (text: string | undefined): string => (text?.trim() ? text : '(none)')

const caseFields = (result: CaseResult): CaseRow[] => [
  ...result.verdicts.map((verdict) => ({
    label: verdict.evaluator,
    lead: verdictLead(verdict),
    text: verdict.reason,
    passed: verdict.passed,
  })),
  { label: 'input', lead: '', text: result.input },
  { label: 'expected', lead: '', text: orNone(result.expected) },
  { label: 'output', lead: '', text: orNone(result.actual) },
]

const wrapCaseRows = (fields: readonly CaseRow[], width: number): CaseRow[] =>
  fields.flatMap(({ label, lead, text, passed }) => {
    const leadWidth = stringWidth(lead)
    return wrapWords(sanitizeTerminalText(text), width - leadWidth).map((part, index) => ({
      label: index === 0 ? label : '',
      lead: index === 0 ? lead : ' '.repeat(leadWidth),
      text: part,
      ...(passed === undefined ? {} : { passed }),
    }))
  })

const CaseView = ({
  command,
  context,
  width,
  height,
  result,
  keys,
  onBack,
}: {
  command: string
  context: readonly string[]
  width: number
  height: number
  result: CaseResult
  keys: readonly ReportKey[]
  onBack: () => void
}): ReactElement => {
  const { success, error } = useTheme()
  const fields = useMemo(() => caseFields(result), [result])
  const labelWidth = labelWidthFor(
    fields.map(({ label }) => label),
    width
  )
  const labelColumn = CASE_INDENT.length + labelWidth
  const rows = useMemo(() => wrapCaseRows(fields, width - labelColumn - CASE_LABEL_GAP), [fields, width, labelColumn])
  const room = Math.max(1, height - CASE_CHROME_ROWS)
  const lastOffset = Math.max(0, rows.length - room)
  const page = Math.max(1, room - 1)
  const scroll = useSyncedState(0)
  const offset = Math.min(scroll.value, lastOffset)
  const scrollBy = (step: number): void =>
    scroll.set((value) => Math.max(0, Math.min(lastOffset, Math.min(value, lastOffset) + step)))
  useInput((input, key) => {
    const typed = shortcut(input, key)
    if (key.escape || key.return || key.leftArrow || key.backspace || key.delete) onBack()
    else if (keys.some((choice) => choice.key === typed)) keys.find((choice) => choice.key === typed)?.run(result)
    else if (key.upArrow) scrollBy(-1)
    else if (key.downArrow) scrollBy(1)
    else if (key.pageUp) scrollBy(-page)
    else if (key.pageDown) scrollBy(page)
    else if (key.home) scroll.set(0)
    else if (key.end) scroll.set(lastOffset)
  })
  const visible = rows.slice(offset, offset + room)
  const scrolls = rows.length > room
  return (
    <>
      <PanelTitle
        name={command}
        parts={[...context, result.name, result.passed ? 'passed' : 'failed']}
        right={
          scrolls ? (
            <Text dimColor>{`lines ${offset + 1}-${offset + visible.length} of ${rows.length}`}</Text>
          ) : undefined
        }
      />
      <Box flexDirection="column" height={room} flexShrink={0} overflow="hidden">
        {visible.map((row, position) => (
          <Box key={offset + position} height={1} flexShrink={0} overflow="hidden">
            <Box width={labelColumn} marginRight={CASE_LABEL_GAP} flexShrink={0} overflow="hidden">
              <Text dimColor wrap="truncate-end">{`${CASE_INDENT}${oneLine(row.label)}`}</Text>
            </Box>
            <Text wrap="truncate-end">
              {row.lead ? <Text color={row.passed ? success : error}>{row.lead}</Text> : null}
              {row.text}
            </Text>
          </Box>
        ))}
      </Box>
      <KeyHints
        hints={[...(scrolls ? ['↑↓ scroll'] : []), ...keys.map(({ hint }) => hint), 'Esc back to the report']}
      />
    </>
  )
}

const Tally = ({ passed, failed }: { passed: number; failed: number }): ReactElement => {
  const { success, error } = useTheme()
  return (
    <Text>
      <Text color={success}>{`  ✓ ${passed} passed`}</Text>
      <Text {...(failed > 0 ? { color: error } : { dimColor: true })}>{`   ✗ ${failed} failed`}</Text>
    </Text>
  )
}
