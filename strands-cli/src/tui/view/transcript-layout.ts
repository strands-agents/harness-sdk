export interface TranscriptWindow {
  start: number
  end: number
  before: number
  after: number
}

export interface TranscriptLayoutPlan {
  window: TranscriptWindow
  /** Whether the content overflows the viewport and must be anchored to its bottom edge. */
  anchorBottom: boolean
  /** The scroll offset after clamping to the measured content, in rows. */
  scrollOffset: number
}

/**
 * Decide which completed turns to mount and how to anchor the transcript from the heights measured
 * so far. An `undefined` height marks a turn that has not been measured yet; such turns are always
 * mounted so the next measurement can fill them in. A zero viewport height means nothing has been
 * measured at all, so every turn mounts.
 */
export function planTranscriptLayout(
  heights: readonly (number | undefined)[],
  rootHeight: number,
  activeHeight: number,
  viewportHeight: number,
  scrollOffset: number
): TranscriptLayoutPlan {
  const known = heights.map((height) => Math.max(0, height ?? 0))
  const contentHeight = rootHeight + known.reduce((sum, height) => sum + height, 0) + activeHeight
  const bounded = Math.max(0, Math.min(scrollOffset, contentHeight - viewportHeight))
  if (viewportHeight <= 0) {
    return {
      window: { start: 0, end: heights.length, before: 0, after: 0 },
      anchorBottom: false,
      scrollOffset: bounded,
    }
  }
  const visibleStart = Math.max(0, contentHeight - viewportHeight - bounded)
  const window = transcriptWindow(known, visibleStart - rootHeight, visibleStart + viewportHeight - rootHeight)
  const firstUnmeasured = heights.findIndex((height) => height === undefined)
  if (firstUnmeasured !== -1) {
    const lastUnmeasured = [...heights].lastIndexOf(undefined)
    window.start = Math.min(window.start, firstUnmeasured)
    window.end = Math.max(window.end, lastUnmeasured + 1)
    window.before = known.slice(0, window.start).reduce((sum, height) => sum + height, 0)
    window.after = known.slice(window.end).reduce((sum, height) => sum + height, 0)
  }
  return { window, anchorBottom: contentHeight > viewportHeight, scrollOffset: bounded }
}

export function sameTranscriptLayoutPlan(previous: TranscriptLayoutPlan, next: TranscriptLayoutPlan): boolean {
  return (
    previous.anchorBottom === next.anchorBottom &&
    previous.scrollOffset === next.scrollOffset &&
    previous.window.start === next.window.start &&
    previous.window.end === next.window.end &&
    previous.window.before === next.window.before &&
    previous.window.after === next.window.after
  )
}

export function transcriptWindow(
  heights: readonly number[],
  visibleStart: number,
  visibleEnd: number
): TranscriptWindow {
  const normalized = heights.map((height) => Math.max(0, height))
  const total = normalized.reduce((sum, height) => sum + height, 0)
  let before = 0
  let start = 0
  while (start < normalized.length && before + normalized[start]! <= visibleStart) {
    before += normalized[start]!
    start++
  }

  let end = start
  let rendered = 0
  while (end < normalized.length && before + rendered < visibleEnd) {
    rendered += normalized[end]!
    end++
  }
  return {
    start,
    end,
    before,
    after: Math.max(0, total - before - rendered),
  }
}
