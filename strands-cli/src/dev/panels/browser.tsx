import { useInput } from 'ink'
import { useState, type ReactElement } from 'react'

import { wrapWords } from '../../terminal/text.js'
import type { EvalsBrowser, EvalsBrowserNotice, EvalsBrowserPlace } from './model.js'
import { Fill, Gap, KeyHints, Line, PanelTitle, shortcut, type Tone } from './ui.js'

export const BROWSER_KEY = 'o'
export const BROWSER_HINT = 'o browser'

export const browserHints = (browser: EvalsBrowser | undefined): string[] => (browser ? [BROWSER_HINT] : [])

const NOTICE_INDENT = 4
const NOTICE_TONES: Readonly<Record<EvalsBrowserNotice['tone'], Tone | undefined>> = {
  normal: undefined,
  muted: 'muted',
  warning: 'warning',
}

export interface BrowserNotices {
  readonly notice: EvalsBrowserNotice | undefined
  readonly open: (place: EvalsBrowserPlace) => void
  readonly retry: () => void
  readonly dismiss: () => void
}

export const useBrowserNotice = (browser: EvalsBrowser | undefined): BrowserNotices => {
  const [notice, setNotice] = useState<EvalsBrowserNotice>()
  const [place, setPlace] = useState<EvalsBrowserPlace>({ view: 'runs' })
  const open = (next: EvalsBrowserPlace): void => {
    if (!browser) return
    setPlace(next)
    void browser.open(next).then(setNotice)
  }
  return { notice, open, retry: () => open(place), dismiss: () => setNotice(undefined) }
}

export const BrowserView = ({
  command,
  notice,
  width,
  onRetry,
  onBack,
}: {
  readonly command: string
  readonly notice: EvalsBrowserNotice
  readonly width: number
  readonly onRetry: () => void
  readonly onBack: () => void
}): ReactElement => {
  useInput((input, key) => {
    if (shortcut(input, key) === BROWSER_KEY) onRetry()
    else if (key.escape || key.return) onBack()
  })
  const rows = notice.lines.flatMap((line) => wrapWords(line, Math.max(1, width - NOTICE_INDENT)))
  const tone = NOTICE_TONES[notice.tone]
  return (
    <>
      <PanelTitle name={command} parts={['evals UI']} />
      <Gap />
      {rows.map((row, index) => (
        <Line key={`${index}:${row}`} {...(tone ? { tone } : {})}>{`  ${row}`}</Line>
      ))}
      <Fill />
      <KeyHints hints={['o try again', 'Esc back']} />
    </>
  )
}
