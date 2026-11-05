/**
 * Shared copy-to-clipboard button wiring with "copied!" feedback, reused by the
 * code terminals.
 *
 * (InstallCommand.astro keeps its own inline copy handler: its script is
 * `is:inline` so it can render the pip/npm command before paint, and inline
 * scripts can't import this module.)
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

export function attachCopyButton(button: HTMLElement, options: CopyButtonOptions): void {
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
  let resetTimer: number | undefined

  button.addEventListener('click', () => {
    const text = getText()
    if (!text) return
    navigator.clipboard
      .writeText(text)
      .then(() => {
        button.classList.add(activeClass)
        target.textContent = copiedText
        if (resetTimer) window.clearTimeout(resetTimer)
        resetTimer = window.setTimeout(() => {
          button.classList.remove(activeClass)
          target.textContent = idleText
        }, resetMs)

        if (track) {
          const sub = track.detail?.()
          const label = sub ? `${track.surface}:${sub}` : track.surface
          window.dispatchEvent(new CustomEvent(COPY_EVENT, { detail: { label, text } }))
        }
      })
      .catch((err) => {
        console.error('Copy to clipboard failed:', err)
        target.textContent = 'failed'
        if (resetTimer) window.clearTimeout(resetTimer)
        resetTimer = window.setTimeout(() => {
          target.textContent = idleText
        }, resetMs)
      })
  })
}
