import { describe, expect, it } from 'vitest'
import {
  formatDropped,
  formatDroppedMessages,
  formatElided,
  formatOffloaded,
  formatSummarized,
  formatTruncated,
  offloadPlaceholder,
} from '../placeholder.js'
import { OffloadedBlock } from '../../types/messages.js'

describe('offloadPlaceholder', () => {
  it('appends the stash ref and records what the placeholder stands for', () => {
    expect(offloadPlaceholder('drop', '[Dropped: earlier messages]', 'removed-abc')).toStrictEqual(
      new OffloadedBlock({ text: '[Dropped: earlier messages] [ref: removed-abc]', method: 'drop', ref: 'removed-abc' })
    )
  })

  it('leaves out the ref when the original was not stashed', () => {
    expect(offloadPlaceholder('drop', '[Dropped]', undefined)).toStrictEqual(
      new OffloadedBlock({ text: '[Dropped]', method: 'drop' })
    )
  })
})

describe('markers', () => {
  it.each([
    ['a dropped block', formatDropped(2525), '[Dropped: ~2,525 tokens]'],
    ['an unmeasured dropped block', formatDropped(0), '[Dropped]'],
    [
      'dropped media',
      formatDropped(2525, 'image'),
      '[Dropped: image, ~2,525 tokens, removed from context after it was received]',
    ],
    [
      'unmeasured dropped media',
      formatDropped(0, 'image'),
      '[Dropped: image, removed from context after it was received]',
    ],
    ['dropped messages', formatDroppedMessages(1200), '[Dropped: earlier messages, ~1,200 tokens]'],
    ['unmeasured dropped messages', formatDroppedMessages(0), '[Dropped: earlier messages]'],
    ['an offloaded block', formatOffloaded(2525), '[Offloaded: ~2,525 tokens]'],
    ['an unmeasured block', formatOffloaded(0), '[Offloaded]'],
    [
      'offloaded media',
      formatOffloaded(2525, 'document'),
      '[Offloaded: document, ~2,525 tokens, removed from context after it was received]',
    ],
    ['unmeasured media', formatOffloaded(0, 'image'), '[Offloaded: image, removed from context after it was received]'],
    ['a summary', formatSummarized('tool result', 2525, 'short'), '[Summarized: tool result, ~2,525 tokens]\n\nshort'],
    [
      'an unmeasured summary',
      formatSummarized('media block', 0, 'a red square'),
      '[Summarized: media block]\n\na red square',
    ],
    ['a truncated block', formatTruncated(1, 7500, 'head'), '[Truncated: 1 block, ~7,500 tokens]\n\nhead'],
    ['truncated blocks', formatTruncated(2, 7500, 'head'), '[Truncated: 2 blocks, ~7,500 tokens]\n\nhead'],
    ['elided messages', formatElided(1200), '[... earlier messages elided, ~1,200 tokens ...]'],
    ['unmeasured elided messages', formatElided(0), '[... earlier messages elided ...]'],
  ])('formats %s', (_case, text, expected) => {
    expect(text).toBe(expected)
  })
})
