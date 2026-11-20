import { useInput } from 'ink'
import type { ReactElement } from 'react'

import { wrapWords } from '../../terminal/text.js'
import { Box, Text, useTheme } from '../../ui/theme.js'
import { useDevPanelClicks } from '../../ui/panels/dev.js'
import { Fill, Gap, KeyHints, Line, listed, PanelTitle, useSyncedState } from '../../ui/panels/kit.js'
import type { RunAgent } from './model.js'

export * from '../../ui/panels/kit.js'

export interface PaidRun {
  readonly title: readonly string[]
  readonly facts: readonly string[]
  readonly warnings?: readonly string[]
  readonly start: () => void
}

export interface PaidRunConfirm {
  readonly pending: PaidRun | undefined
  readonly asking: () => boolean
  readonly ask: (run: PaidRun) => void
  readonly answer: (start: boolean) => void
}

export const agentModel = (agent: RunAgent | undefined): string => agent?.model ?? 'the model that the agent file sets'

export const awsBedrockFact = (calls: string): string =>
  `${calls} use AWS Bedrock, with the AWS credentials and region of the shell that started strands dev, also when ` +
  'your agent uses another provider.'

export const fileToolWarnings = (agent: RunAgent | undefined): string[] => {
  const tools = agent?.fileTools ?? []
  if (!agent || tools.length === 0) return []
  return [
    `The cases run in ${agent.folder}. The ${listed(tools)} ${tools.length === 1 ? 'tool' : 'tools'} of your agent ` +
      'can change files there.',
  ]
}

export const usePaidRunConfirm = (): PaidRunConfirm => {
  const pending = useSyncedState<PaidRun | undefined>(undefined)
  return {
    pending: pending.value,
    asking: () => pending.current() !== undefined,
    ask: (run) => pending.set(run),
    answer: (start): void => {
      const run = pending.current()
      pending.set(undefined)
      if (start) run?.start()
    },
  }
}

const PAID_RUN_CHROME_ROWS = 5
const PAID_RUN_INDENT = '  '
const WARNING_MARK = '⚠ '

interface PaidRunRow {
  readonly text: string
  readonly warning: boolean
}

const paidRunRows = ({ facts, warnings = [] }: PaidRun, width: number, room: number): PaidRunRow[] => {
  const textWidth = Math.max(1, width - PAID_RUN_INDENT.length)
  const factRows = facts.flatMap((fact) => wrapWords(fact, textWidth).map((text) => ({ text, warning: false })))
  const warningRows = warnings.flatMap((warning) =>
    wrapWords(warning, textWidth - WARNING_MARK.length).map((text, index) => ({
      text: `${index === 0 ? WARNING_MARK : ' '.repeat(WARNING_MARK.length)}${text}`,
      warning: true,
    }))
  )
  return [...factRows.slice(0, Math.max(0, room - warningRows.length)), ...warningRows]
}

const PaidRunButtons = ({ onAnswer }: { onAnswer: (start: boolean) => void }): ReactElement => {
  const { accent, selection } = useTheme()
  const clicks = useDevPanelClicks()
  return (
    <Box height={1} flexShrink={0}>
      <Box
        flexShrink={0}
        marginRight={2}
        backgroundColor={selection}
        {...(clicks ? { ref: clicks.target(() => onAnswer(true)) } : {})}
      >
        <Text color={accent}>{'› '}</Text>
        <Text color={accent} bold>
          {'[ Start the run ]'}
        </Text>
      </Box>
      <Box flexShrink={0} {...(clicks ? { ref: clicks.target(() => onAnswer(false)) } : {})}>
        <Text>{'  Cancel'}</Text>
      </Box>
    </Box>
  )
}

export const PaidRunView = ({
  command,
  run,
  width,
  height,
  backHint,
  onAnswer,
}: {
  command: string
  run: PaidRun
  width: number
  height: number
  backHint: string
  onAnswer: (start: boolean) => void
}): ReactElement => {
  useInput((_input, key) => {
    if (key.return) onAnswer(true)
    else if (key.escape) onAnswer(false)
  })
  return (
    <>
      <PanelTitle name={command} parts={[...run.title, 'start a paid run?']} />
      <Gap />
      {paidRunRows(run, width, height - PAID_RUN_CHROME_ROWS).map(({ text, warning }, index) => (
        <Line key={index} {...(warning ? { tone: 'warning' as const } : {})}>
          {`${PAID_RUN_INDENT}${text}`}
        </Line>
      ))}
      <Fill />
      <PaidRunButtons onAnswer={onAnswer} />
      <KeyHints hints={['Enter start the run', backHint]} />
    </>
  )
}
