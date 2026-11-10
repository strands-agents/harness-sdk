// All tests here are purely synchronous — strategies compute a delay number;
// no timers fire and nothing is awaited, so tests never wait real wall time.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ConstantBackoff, LinearBackoff, ExponentialBackoff, type BackoffContext } from '../backoff-strategy.js'

function ctx(partial: Partial<BackoffContext> = {}): BackoffContext {
  return { attempt: 1, elapsedMs: 0, ...partial }
}

describe('ConstantBackoff', () => {
  it('returns the configured delay regardless of attempt', () => {
    const bo = new ConstantBackoff({ delayMs: 250 })
    expect(bo.nextDelay(ctx({ attempt: 1 }))).toBe(250)
    expect(bo.nextDelay(ctx({ attempt: 5 }))).toBe(250)
  })

  it('defaults delayMs to 1000', () => {
    expect(new ConstantBackoff().nextDelay(ctx())).toBe(1000)
  })

  it('rejects attempts below 1', () => {
    const bo = new ConstantBackoff()
    expect(() => bo.nextDelay(ctx({ attempt: 0 }))).toThrow(/attempt must be an integer/)
  })
})

describe('LinearBackoff', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('grows as baseMs * attempt', () => {
    const bo = new LinearBackoff({ baseMs: 100, jitter: 'none' })
    expect(bo.nextDelay(ctx({ attempt: 1 }))).toBe(100)
    expect(bo.nextDelay(ctx({ attempt: 2 }))).toBe(200)
    expect(bo.nextDelay(ctx({ attempt: 3 }))).toBe(300)
  })

  it('clamps to maxMs before jitter', () => {
    const bo = new LinearBackoff({ baseMs: 1000, maxMs: 2500, jitter: 'none' })
    expect(bo.nextDelay(ctx({ attempt: 10 }))).toBe(2500)
  })

  it('applies full jitter by default (Math.random() * raw)', () => {
    const bo = new LinearBackoff({ baseMs: 100 })
    // attempt 4 → raw 400, Math.random() mocked to 0.5 → 200
    expect(bo.nextDelay(ctx({ attempt: 4 }))).toBe(200)
  })

  it('rejects attempts below 1', () => {
    const bo = new LinearBackoff()
    expect(() => bo.nextDelay(ctx({ attempt: 0 }))).toThrow(/attempt must be an integer/)
  })
})

describe('ExponentialBackoff', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('grows as baseMs * multiplier^(attempt-1)', () => {
    const bo = new ExponentialBackoff({ baseMs: 100, jitter: 'none' })
    expect(bo.nextDelay(ctx({ attempt: 1 }))).toBe(100)
    expect(bo.nextDelay(ctx({ attempt: 2 }))).toBe(200)
    expect(bo.nextDelay(ctx({ attempt: 3 }))).toBe(400)
    expect(bo.nextDelay(ctx({ attempt: 4 }))).toBe(800)
  })

  it('honors custom multiplier', () => {
    const bo = new ExponentialBackoff({ baseMs: 100, multiplier: 3, jitter: 'none' })
    expect(bo.nextDelay(ctx({ attempt: 3 }))).toBe(900)
  })

  it('clamps to maxMs', () => {
    const bo = new ExponentialBackoff({ baseMs: 100, maxMs: 500, jitter: 'none' })
    expect(bo.nextDelay(ctx({ attempt: 10 }))).toBe(500)
  })

  it('applies full jitter by default', () => {
    const bo = new ExponentialBackoff({ baseMs: 100 })
    // attempt 3 → raw 400, Math.random() mocked to 0.5 → 200
    expect(bo.nextDelay(ctx({ attempt: 3 }))).toBe(200)
  })

  it('applies equal jitter as raw/2 + random*raw/2', () => {
    const bo = new ExponentialBackoff({ baseMs: 100, jitter: 'equal' })
    // attempt 2 → raw 200, equal → 100 + 0.5*100 = 150
    expect(bo.nextDelay(ctx({ attempt: 2 }))).toBe(150)
  })

  it('applies no jitter when set to none', () => {
    const bo = new ExponentialBackoff({ baseMs: 100, jitter: 'none' })
    expect(bo.nextDelay(ctx({ attempt: 3 }))).toBe(400)
  })

  it('falls back to full jitter for decorrelated when lastDelayMs missing', () => {
    const bo = new ExponentialBackoff({ baseMs: 100, jitter: 'decorrelated' })
    expect(bo.nextDelay(ctx({ attempt: 3 }))).toBe(200)
  })

  it('applies decorrelated jitter as uniform(baseMs, min(maxMs, lastDelayMs*3))', () => {
    const bo = new ExponentialBackoff({ baseMs: 100, maxMs: 10_000, jitter: 'decorrelated' })
    // lastDelayMs=200 → upper=min(10_000, 600)=600
    // random=0.5 → 100 + 0.5 * (600-100) = 350
    expect(bo.nextDelay(ctx({ attempt: 2, lastDelayMs: 200 }))).toBe(350)
  })

  it('caps decorrelated upper at maxMs', () => {
    const bo = new ExponentialBackoff({ baseMs: 100, maxMs: 500, jitter: 'decorrelated' })
    // lastDelayMs=1000 → upper=min(500, 3000)=500
    // random=0.5 → 100 + 0.5 * (500-100) = 300
    expect(bo.nextDelay(ctx({ attempt: 2, lastDelayMs: 1000 }))).toBe(300)
  })

  it('floors decorrelated upper at baseMs when lastDelay*3 < baseMs', () => {
    // Guards against inverted range: without max(baseMs, ...), upper=30 would be
    // below lower=100. The max clamp yields upper=baseMs, so delay stays at baseMs.
    const bo = new ExponentialBackoff({ baseMs: 100, maxMs: 500, jitter: 'decorrelated' })
    expect(bo.nextDelay(ctx({ attempt: 2, lastDelayMs: 10 }))).toBe(100)
  })

  it('rejects attempts below 1', () => {
    const bo = new ExponentialBackoff()
    expect(() => bo.nextDelay(ctx({ attempt: 0 }))).toThrow(/attempt must be an integer/)
  })

  it('rejects non-integer attempts', () => {
    const bo = new ExponentialBackoff()
    expect(() => bo.nextDelay(ctx({ attempt: 1.5 }))).toThrow(/attempt must be an integer/)
  })
})
