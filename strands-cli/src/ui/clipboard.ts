import { useCallback, useEffect, useRef, useState } from 'react'
import { useInput, useStdout, type Key } from 'ink'
import { copyTerminalText } from '../terminal/terminal.js'
import { graphemes, sanitizeTerminalText } from '../terminal/text.js'

export type ClipboardNotice = { status: 'success'; characterCount: number } | { status: 'error' }

const NOTICE_DURATION_MS = 2_000
const ERROR_COPY_HINT = 'Ctrl+Y copy error'

export const clipboardNoticeText = (notice: ClipboardNotice): string =>
  notice.status === 'success'
    ? `${notice.characterCount} ${notice.characterCount === 1 ? 'char' : 'chars'} copied to clipboard`
    : 'Clipboard copy failed'

export const isCopyShortcut = (input: string, key: Key): boolean =>
  key.ctrl && !key.meta && !key.super && input.toLowerCase() === 'y'

export const useClipboard = (): {
  copyText: (text: string) => void
  clipboardNotice: ClipboardNotice | undefined
} => {
  const { stdout } = useStdout()
  const [clipboardNotice, setClipboardNotice] = useState<ClipboardNotice>()
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    (): (() => void) => () => {
      clearTimeout(noticeTimer.current)
    },
    []
  )
  const copyText = useCallback(
    (text: string): void => {
      const characterCount = graphemes(text).length
      void copyTerminalText(text, stdout).then((copied) => {
        clearTimeout(noticeTimer.current)
        setClipboardNotice(copied ? { status: 'success', characterCount } : { status: 'error' })
        noticeTimer.current = setTimeout(() => {
          setClipboardNotice(undefined)
        }, NOTICE_DURATION_MS)
      })
    },
    [stdout]
  )
  return { copyText, clipboardNotice }
}

export const useCopyableError = (error: string | undefined): string | undefined => {
  const { copyText, clipboardNotice } = useClipboard()
  useInput((input, key) => {
    if (error && isCopyShortcut(input, key)) copyText(sanitizeTerminalText(error))
  })
  if (!error) return undefined
  return clipboardNotice ? clipboardNoticeText(clipboardNotice) : ERROR_COPY_HINT
}
