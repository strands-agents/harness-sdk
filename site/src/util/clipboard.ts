/**
 * Shared copy-to-clipboard button wiring with "copied!" feedback, reused by the
 * code terminals.
 *
 * InstallCommand.astro keeps its language renderer inline so the pip/npm
 * command paints before hydration, then uses this helper for copy behavior.
 */
/**
 * Analytics descriptor for a copy button. On a successful copy the helper fires
 * a `strands:copy` CustomEvent whose `detail.label` is `surface` (optionally
 * `surface:detail`), e.g. `install:pip`, `install:npm`, `code:use-cases:Python`,
 * and whose `detail.text` is the exact copied string. Analytics.astro listens
 * for `strands:copy` and routes it into the (consent-gated) WebSDK, logging the
 * first line of the text so we can tell which command/snippet was copied. This
 * helper stays decoupled from the analytics transport.
 */
export interface CopyTrack {
  surface: string
  /** Optional sub-label resolved at click time, e.g. the language or command. */
  detail?: () => string | null | undefined
}

export const COPY_EVENT = 'strands:copy'

export interface CopyButtonOptions {
  /** Returns the text to copy at click time (read lazily so it can follow UI state). */
  getText: () => string
  /** Element whose text shows the copy/copied label. Defaults to the button itself. */
  label?: HTMLElement | null
  /** Class toggled on the button while in the copied state. */
  activeClass?: string
  idleText?: string
  copiedText?: string
  resetMs?: number
  /** Fires a `strands:copy` analytics event on a successful copy. */
  track?: CopyTrack
}

export interface CopyButtonController {
  reset: () => void
}

export function attachCopyButton(button: HTMLElement, options: CopyButtonOptions): CopyButtonController {
  const {
    getText,
    label = null,
    activeClass = 'is-copied',
    idleText = 'copy',
    copiedText = 'copied!',
    resetMs = 1600,
    track,
  } = options
  const target = label ?? button
  const idleAriaLabel = button.getAttribute('aria-label')
  let resetTimer: number | undefined
  let operationId = 0

  const setAccessibleState = (message: string | null) => {
    if (!idleAriaLabel) return
    button.setAttribute('aria-label', message ?? idleAriaLabel)
  }

  const reset = () => {
    operationId += 1
    if (resetTimer) window.clearTimeout(resetTimer)
    resetTimer = undefined
    button.classList.remove(activeClass)
    target.textContent = idleText
    setAccessibleState(null)
  }

  button.addEventListener('click', () => {
    const text = getText()
    if (!text) return
    const pendingOperation = ++operationId
    const trackDetail = track?.detail?.()
    navigator.clipboard
      .writeText(text)
      .then(() => {
        if (pendingOperation !== operationId) return
        button.classList.add(activeClass)
        target.textContent = copiedText
        setAccessibleState('Copied to clipboard')
        if (resetTimer) window.clearTimeout(resetTimer)
        resetTimer = window.setTimeout(() => {
          if (pendingOperation !== operationId) return
          button.classList.remove(activeClass)
          target.textContent = idleText
          setAccessibleState(null)
        }, resetMs)

        if (track) {
          const eventLabel = trackDetail ? `${track.surface}:${trackDetail}` : track.surface
          window.dispatchEvent(new CustomEvent(COPY_EVENT, { detail: { label: eventLabel, text } }))
        }
      })
      .catch((err) => {
        if (pendingOperation !== operationId) return
        console.error('Copy to clipboard failed:', err)
        target.textContent = 'failed'
        setAccessibleState('Copy to clipboard failed')
        if (resetTimer) window.clearTimeout(resetTimer)
        resetTimer = window.setTimeout(() => {
          if (pendingOperation !== operationId) return
          target.textContent = idleText
          setAccessibleState(null)
        }, resetMs)
      })
  })

  return { reset }
}
