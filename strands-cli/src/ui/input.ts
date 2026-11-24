// The one place that takes Ink's hook: everything else asks for one of the two below.
// eslint-disable-next-line no-restricted-imports
import { useInput as useInkInput, type Key } from 'ink'

import { parseMouseInput } from '../terminal/mouse-input.js'

/**
 * Everything the terminal sends: keys, typed text, and its mouse reports. Ink hands a report of a move, a click, or
 * the wheel to every handler as if it were typed, so only a screen that follows the mouse itself asks for this.
 */
export const useTerminalInput = useInkInput

/**
 * Keys and typed text, without the mouse reports of the terminal. A handler that takes typing would otherwise type
 * each report into its field, as `[<35;50;20M`, whenever the mouse moves or scrolls.
 */
export const useInput = (handler: (input: string, key: Key) => void, options?: { isActive?: boolean }): void =>
  useInkInput((input, key) => {
    if (!parseMouseInput(input)) handler(input, key)
  }, options)
