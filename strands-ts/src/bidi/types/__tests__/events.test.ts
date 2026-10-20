import { describe, expect, it } from 'vitest'

import {
  BidiAudioDeltaEvent,
  BidiAudioStartEvent,
  BidiAudioStopEvent,
  BidiBargeInEvent,
  BidiConnectionRestartEvent,
  BidiConnectionStartEvent,
  BidiConnectionStopEvent,
  BidiReasoningBlockEvent,
  BidiReasoningDeltaEvent,
  BidiReasoningStartEvent,
  BidiReasoningStopEvent,
  BidiResponseStartEvent,
  BidiResponseStopEvent,
  BidiTextBlockEvent,
  BidiTextDeltaEvent,
  BidiTextStartEvent,
  BidiTextStopEvent,
  BidiToolUseBlocksEvent,
  BidiTranscriptBlockEvent,
  BidiTranscriptDeltaEvent,
  BidiTranscriptStartEvent,
  BidiTranscriptStopEvent,
  BidiUsageEvent,
  isBidiOutputEvent,
  normalizeRole,
} from '../events.js'
import { ToolUseBlock } from '../../../types/messages.js'
import { encodeBase64 } from '../../../types/media.js'
import { ConnectionTimeoutError } from '../../models/model.js'

import type { Role } from '../../../types/messages.js'

const audioBytes = new Uint8Array([1, 2, 3])

const roundTrip = (event: object): unknown => JSON.parse(JSON.stringify(event))

describe('bidi output events', () => {
  describe('JSON serialization', () => {
    it.each([
      [
        new BidiConnectionStartEvent({ type: 'bidiConnectionStart', connectionId: 'c1', model: 'm1' }),
        { type: 'bidiConnectionStart', connectionId: 'c1', model: 'm1' },
      ],
      [
        new BidiResponseStartEvent({ type: 'bidiResponseStart', responseId: 'r1' }),
        { type: 'bidiResponseStart', responseId: 'r1' },
      ],
      [
        new BidiTextStartEvent({ type: 'bidiTextStart', contentId: 'text' }),
        { type: 'bidiTextStart', contentId: 'text' },
      ],
      [
        new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: ' Some text. ', contentId: 'text' }),
        { type: 'bidiTextDelta', delta: ' Some text. ', contentId: 'text' },
      ],
      [new BidiTextStopEvent({ type: 'bidiTextStop', contentId: 'text' }), { type: 'bidiTextStop', contentId: 'text' }],
      [
        new BidiTextBlockEvent({ type: 'bidiTextBlock', text: ' Some text. ', contentId: 'text' }),
        { type: 'bidiTextBlock', text: ' Some text. ', contentId: 'text' },
      ],
      [
        new BidiReasoningStartEvent({ type: 'bidiReasoningStart', contentId: 'reasoning' }),
        { type: 'bidiReasoningStart', contentId: 'reasoning' },
      ],
      [
        new BidiReasoningDeltaEvent({ type: 'bidiReasoningDelta', delta: ' Some thought. ', contentId: 'reasoning' }),
        { type: 'bidiReasoningDelta', delta: ' Some thought. ', contentId: 'reasoning' },
      ],
      [
        new BidiReasoningStopEvent({ type: 'bidiReasoningStop', contentId: 'reasoning' }),
        { type: 'bidiReasoningStop', contentId: 'reasoning' },
      ],
      [
        new BidiReasoningBlockEvent({ type: 'bidiReasoningBlock', text: ' Some thought. ', contentId: 'reasoning' }),
        { type: 'bidiReasoningBlock', text: ' Some thought. ', contentId: 'reasoning' },
      ],
      [
        new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role: 'user', contentId: 'u1' }),
        { type: 'bidiTranscriptStart', role: 'user', contentId: 'u1' },
      ],
      [
        new BidiTranscriptStopEvent({ type: 'bidiTranscriptStop', role: 'user', contentId: 'u1' }),
        { type: 'bidiTranscriptStop', role: 'user', contentId: 'u1' },
      ],
      [
        new BidiAudioStartEvent({ type: 'bidiAudioStart', contentId: 'audio' }),
        { type: 'bidiAudioStart', contentId: 'audio' },
      ],
      [
        new BidiAudioStopEvent({ type: 'bidiAudioStop', contentId: 'audio' }),
        { type: 'bidiAudioStop', contentId: 'audio' },
      ],
      [
        new BidiAudioDeltaEvent({
          type: 'bidiAudioDelta',
          audio: audioBytes,
          format: 'pcm',
          sampleRate: 24000,
          channels: 1,
          contentId: 'audio',
        }),
        {
          type: 'bidiAudioDelta',
          audio: encodeBase64(audioBytes),
          format: 'pcm',
          sampleRate: 24000,
          channels: 1,
          contentId: 'audio',
        },
      ],
      [
        new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: 'Hello',
          role: 'assistant',
          contentId: 't1',
        }),
        { type: 'bidiTranscriptDelta', delta: 'Hello', role: 'assistant', contentId: 't1' },
      ],
      [
        new BidiTranscriptBlockEvent({
          type: 'bidiTranscriptBlock',
          transcript: 'Hello',
          role: 'assistant',
          contentId: 't1',
        }),
        { type: 'bidiTranscriptBlock', transcript: 'Hello', role: 'assistant', contentId: 't1' },
      ],
      [new BidiBargeInEvent(), { type: 'bidiBargeIn' }],
      [
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'r1' }),
        { type: 'bidiResponseStop', responseId: 'r1' },
      ],
      [
        new BidiUsageEvent({ type: 'bidiUsage', inputTokens: 10, outputTokens: 20, totalTokens: 30 }),
        { type: 'bidiUsage', inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ],
      [
        new BidiUsageEvent({
          type: 'bidiUsage',
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          inputTokenDetails: { text: 10, audio: 0, cacheRead: 4 },
          outputTokenDetails: { text: 5, audio: 15, reasoning: 3 },
        }),
        {
          type: 'bidiUsage',
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          inputTokenDetails: { text: 10, audio: 0, cacheRead: 4 },
          outputTokenDetails: { text: 5, audio: 15, reasoning: 3 },
        },
      ],
      [
        new BidiConnectionStopEvent({ type: 'bidiConnectionStop', connectionId: 'c1', reason: 'userRequest' }),
        { type: 'bidiConnectionStop', connectionId: 'c1', reason: 'userRequest' },
      ],
    ])('round-trips %#', (event, expected) => {
      expect(roundTrip(event)).toEqual(expected)
      expect(isBidiOutputEvent(event)).toBe(true)
    })

    it('omits an absent usage breakdown rather than serializing undefined', () => {
      const event = new BidiUsageEvent({ type: 'bidiUsage', inputTokens: 1, outputTokens: 2, totalTokens: 3 })

      expect(event.inputTokenDetails).toBeUndefined()
      expect(event.outputTokenDetails).toBeUndefined()
      expect(Object.keys(roundTrip(event) as object)).toEqual(['type', 'inputTokens', 'outputTokens', 'totalTokens'])
    })
  })

  describe('isBidiOutputEvent', () => {
    it('rejects an event type outside the union', () => {
      expect(isBidiOutputEvent({ type: 'modelMessageStartEvent' })).toBe(false)
      expect(isBidiOutputEvent({ type: 'bidiBargeIn' })).toBe(true)
    })
  })

  describe('BidiConnectionRestartEvent', () => {
    it('defaults turnInterrupted to false and omits an absent timeout error', () => {
      const event = new BidiConnectionRestartEvent({ type: 'bidiConnectionRestart', reason: 'scheduled' })

      expect(roundTrip(event)).toEqual({
        type: 'bidiConnectionRestart',
        reason: 'scheduled',
        turnInterrupted: false,
      })
    })

    it('carries the timeout error and interrupted turn on the reactive path', () => {
      const timeoutError = new ConnectionTimeoutError('connection timed out', { promptName: 'p1' })
      const event = new BidiConnectionRestartEvent({
        type: 'bidiConnectionRestart',
        reason: 'timeout',
        timeoutError,
        turnInterrupted: true,
      })

      expect(event.timeoutError).toBe(timeoutError)
      expect(event.turnInterrupted).toBe(true)
    })
  })

  describe('transcript boundary events', () => {
    it.each([
      ['user', 'bidiTranscriptStart'],
      ['assistant', 'bidiTranscriptStart'],
      ['user', 'bidiTranscriptStop'],
      ['assistant', 'bidiTranscriptStop'],
    ] as [Role, 'bidiTranscriptStart' | 'bidiTranscriptStop'][])(
      'carries role %s and contentId on %s',
      (role, type) => {
        const event =
          type === 'bidiTranscriptStart'
            ? new BidiTranscriptStartEvent({ type, role, contentId: 't1' })
            : new BidiTranscriptStopEvent({ type, role, contentId: 't1' })

        expect(roundTrip(event)).toEqual({ type, role, contentId: 't1' })
      }
    )
  })

  describe('BidiResponseStopEvent', () => {
    it('carries the response id', () => {
      const event = new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'r1' })

      expect(roundTrip(event)).toEqual({ type: 'bidiResponseStop', responseId: 'r1' })
      expect(event.responseId).toBe('r1')
    })
  })

  describe('BidiTranscriptDeltaEvent', () => {
    it('contains only the incremental text', () => {
      const event = new BidiTranscriptDeltaEvent({
        type: 'bidiTranscriptDelta',
        delta: 'Hello',
        role: 'user',
        contentId: 'user-transcript',
      })

      expect(event.role).toBe('user')
      expect(event.delta).toBe('Hello')
    })

    it.each(['system', 'admin', 'SYSTEM', 'tool', 'developer', 'unknown', ''])(
      'coerces out-of-range role %j to user',
      (rawRole) => {
        const event = new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: 'hi',
          role: rawRole as Role,
          contentId: 'transcript',
        })

        // attacker-controlled content is never attributed to the assistant
        expect(event.role).toBe('user')
      }
    )

    it('strips whitespace from a legitimately-spaced role rather than mislabeling it', () => {
      const event = new BidiTranscriptDeltaEvent({
        type: 'bidiTranscriptDelta',
        delta: 'hi',
        role: ' user ' as Role,
        contentId: 'transcript',
      })

      expect(event.role).toBe('user')
    })

    it('normalizes a supported role in mixed casing to lowercase', () => {
      const event = new BidiTranscriptDeltaEvent({
        type: 'bidiTranscriptDelta',
        delta: 'hi',
        role: 'USER' as Role,
        contentId: 'transcript',
      })

      expect(event.role).toBe('user')
    })
  })

  describe('BidiTranscriptBlockEvent', () => {
    it('carries the accumulated transcript', () => {
      const event = new BidiTranscriptBlockEvent({
        type: 'bidiTranscriptBlock',
        transcript: 'Hello world',
        role: 'assistant',
        contentId: 'assistant-transcript',
      })

      expect(roundTrip(event)).toEqual({
        type: 'bidiTranscriptBlock',
        transcript: 'Hello world',
        role: 'assistant',
        contentId: 'assistant-transcript',
      })
    })
  })

  describe('BidiToolUseBlocksEvent', () => {
    it('groups the tool calls to execute together', () => {
      const toolUses = [
        new ToolUseBlock({ toolUseId: 'a', name: 'lookup', input: { key: 'first' } }),
        new ToolUseBlock({ toolUseId: 'b', name: 'lookup', input: { key: 'second' } }),
      ]
      const event = new BidiToolUseBlocksEvent({ type: 'bidiToolUseBlocks', toolUses })

      expect(event.toolUses).toBe(toolUses)
      expect(roundTrip(event)).toEqual({
        type: 'bidiToolUseBlocks',
        toolUses: [
          { toolUse: { toolUseId: 'a', name: 'lookup', input: { key: 'first' } } },
          { toolUse: { toolUseId: 'b', name: 'lookup', input: { key: 'second' } } },
        ],
      })
    })
  })
})

describe('normalizeRole', () => {
  describe('when given a supported role', () => {
    it.each([
      ['user', 'user'],
      ['assistant', 'assistant'],
      ['USER', 'user'],
      ['Assistant', 'assistant'],
    ])('lowercases and preserves %j', (rawRole, expected) => {
      expect(normalizeRole(rawRole)).toBe(expected)
    })

    it.each([
      [' user ', 'user'],
      [' User ', 'user'],
      ['\tassistant\n', 'assistant'],
      ['  USER', 'user'],
    ])('trims surrounding whitespace on %j', (rawRole, expected) => {
      expect(normalizeRole(rawRole)).toBe(expected)
    })
  })

  describe('when given an unsupported value', () => {
    it.each(['system', 'admin', 'SYSTEM', 'tool', '', 'unknown', undefined, null, 123])(
      'falls back to the lowest-trust role for %j',
      (rawRole) => {
        expect(normalizeRole(rawRole)).toBe('user')
        expect(normalizeRole(rawRole, 'assistant')).toBe('assistant')
      }
    )
  })
})
