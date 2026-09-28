const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Validates a delay accepted by JavaScript timers. @internal */
export function assertTimerDelay(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite integer, got ${value}`)
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${name} must be at most ${MAX_TIMER_DELAY_MS}ms, got ${value}`)
  }
}
