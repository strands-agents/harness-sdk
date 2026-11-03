import { describe, expect, it } from 'vitest'
import { planCut } from '../cut.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { Role } from '../../../types/messages.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import {
  buildToolNameMap,
  collectRemovableWithPair,
  getOldestMatches,
  resolvePreserveCount,
} from '../../strategies/offload/base.js'

const text = (role: Role, value: string = role): Message => new Message({ role, content: [new TextBlock(value)] })
const pinned = (role: Role): Message =>
  new Message({ role, content: [new TextBlock('pinned')], metadata: { custom: { pinned: true } } })
const toolUse = (id: string): Message =>
  new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'lookup', toolUseId: id, input: {} })] })
const toolResult = (id: string): Message =>
  new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId: id, status: 'success', content: [new TextBlock('result')] })],
  })

function indices(messages: Message[], part: Message[]): number[] {
  return part.map((message) => messages.indexOf(message))
}

describe('planCut', () => {
  describe('keepHead', () => {
    const messages = [text('user'), text('assistant'), text('user'), text('assistant'), text('user')]

    it('keeps message 0 in the head when keepHead is 1', () => {
      const cut = planCut(messages, 1, 2)!
      expect(indices(messages, cut.head)).toStrictEqual([0])
      expect(indices(messages, cut.body)).toStrictEqual([1, 2])
      expect(indices(messages, cut.tail)).toStrictEqual([3, 4])
    })

    it('starts the body at message 0 when keepHead is 0', () => {
      const cut = planCut(messages, 0, 2)!
      expect(cut.head).toStrictEqual([])
      expect(indices(messages, cut.body)).toStrictEqual([0, 1, 2])
    })

    it('keeps a tool result answering the head in the head', () => {
      const history = [toolUse('a'), toolResult('a'), text('assistant'), text('user')]
      const cut = planCut(history, 1, 1)!
      expect(indices(history, cut.head)).toStrictEqual([0, 1])
      expect(indices(history, cut.body)).toStrictEqual([2])
    })
  })

  describe('preserveRecent', () => {
    const messages = Array.from({ length: 10 }, (_, index) => text(index % 2 === 0 ? 'user' : 'assistant'))

    it.each([
      [0, 9],
      [1, 9],
      [3, 7],
      [9, undefined],
      [10, undefined],
      [0.3, 7],
      [0.7, 3],
      [0.95, undefined],
    ])('preserveRecent=%s ends the body at %s', (preserveRecent, tailStart) => {
      const cut = planCut(messages, 1, preserveRecent)
      expect(cut && messages.indexOf(cut.tail[0]!)).toBe(tailStart)
    })

    it('always keeps the last message', () => {
      const cut = planCut([text('user'), text('assistant'), text('user')], 0, 0)!
      expect(cut.tail).toHaveLength(1)
    })
  })

  describe('tool pairs', () => {
    it('moves a tool result split by the boundary into the body', () => {
      const history = [text('user'), toolUse('a'), toolResult('a'), text('assistant'), text('user')]
      const cut = planCut(history, 1, 3)!
      expect(indices(history, cut.body)).toStrictEqual([1, 2])
    })

    it('keeps the whole pair when its result is the last message', () => {
      const history = [text('user'), text('assistant'), text('user'), toolUse('a'), toolResult('a')]
      const cut = planCut(history, 1, 1)!
      expect(indices(history, cut.body)).toStrictEqual([1, 2])
      expect(indices(history, cut.tail)).toStrictEqual([3, 4])
    })

    it('summarizes nothing when only a pair answered by the last message is left', () => {
      expect(planCut([text('user'), toolUse('a'), toolResult('a')], 1, 0)).toBeUndefined()
    })
  })

  describe('roles at the boundary', () => {
    it('moves the boundary back to where roles differ', () => {
      const history = [
        text('user'),
        text('assistant'),
        text('user'),
        text('assistant'),
        text('assistant'),
        text('user'),
      ]
      const cut = planCut(history, 1, 2)!
      expect(indices(history, cut.body)).toStrictEqual([1, 2])
    })

    it('summarizes nothing when no boundary alternates', () => {
      expect(planCut([text('user'), text('assistant'), text('assistant')], 1, 0)).toBeUndefined()
    })
  })

  describe('endOnUser', () => {
    it('moves the boundary back until the body ends with a user message', () => {
      const history = [text('user'), text('assistant'), text('user'), text('assistant'), text('user')]
      expect(indices(history, planCut(history, 0, 1)!.body)).toStrictEqual([0, 1, 2, 3])
      expect(indices(history, planCut(history, 0, 1, true)!.body)).toStrictEqual([0, 1, 2])
    })

    it('summarizes nothing when no user message can end the body', () => {
      expect(planCut([text('assistant'), text('user')], 0, 0, true)).toBeUndefined()
    })
  })

  describe('pins', () => {
    it('stops in front of the first pin', () => {
      const history = [
        text('user'),
        text('assistant'),
        text('user'),
        pinned('assistant'),
        text('user'),
        text('assistant'),
        text('user'),
      ]
      const cut = planCut(history, 1, 1)!
      expect(indices(history, cut.body)).toStrictEqual([1, 2])
    })

    it('summarizes nothing when the first message after the head is pinned', () => {
      expect(
        planCut([text('user'), pinned('assistant'), text('user'), text('assistant'), text('user')], 1, 1)
      ).toBeUndefined()
    })

    it('keeps the tool result of a pinned tool call', () => {
      const history = [
        text('user'),
        text('assistant'),
        text('user'),
        toolUse('a'),
        toolResult('a'),
        text('assistant'),
        text('user'),
      ]
      history[3] = new Message({
        role: 'assistant',
        content: history[3]!.content,
        metadata: { custom: { pinned: true } },
      })
      const cut = planCut(history, 1, 1)!
      expect(indices(history, cut.body)).toStrictEqual([1, 2])
    })
  })

  describe('earlier summaries', () => {
    it('rolls a base summary after message 0 into the body', () => {
      const summary = new Message({
        role: 'assistant',
        content: [new TextBlock('earlier', { metadata: { offloaded: { method: 'summarize', removedMessages: 4 } } })],
      })
      const history = [text('user'), summary, text('user'), text('assistant'), text('user')]
      expect(planCut(history, 1, 1)!.body[0]).toBe(summary)
    })

    it('summarizes nothing when the body would hold only an earlier summary', () => {
      const summary = new Message({
        role: 'assistant',
        content: [new TextBlock('earlier', { metadata: { offloaded: { method: 'summarize', removedMessages: 4 } } })],
      })
      expect(planCut([text('user'), summary, pinned('user'), text('assistant'), text('user')], 1, 1)).toBeUndefined()
      expect(planCut([text('user'), summary, text('user')], 1, 1)).toBeUndefined()
    })

    it('rolls a native summary at message 0 into the body', () => {
      const native = new Message({
        role: 'assistant',
        content: [new TextBlock('earlier', { providerData: { provider: 'anthropic', data: {} } })],
      })
      const history = [native, text('assistant'), text('user'), text('assistant'), text('user')]
      expect(planCut(history, 0, 1)!.body[0]).toBe(native)
    })
  })

  // #5736: a pass main summarizes without touching the last message is not skipped.
  describe('low preserveRecent (#5736)', () => {
    it('summarizes message 1 of [task] [assistant] [user] with preserveRecent=1', () => {
      const history = [text('user', 'task'), text('assistant', 'x'.repeat(20_000)), text('user', 'y'.repeat(20_000))]
      const cut = planCut(history, 1, 1)!
      expect(indices(history, cut.body)).toStrictEqual([1])
      expect(cut.tail).toStrictEqual([history[2]])
    })

    it('never puts the last message in the body', () => {
      for (const preserveRecent of [0, 1, 2]) {
        const history = [text('user'), text('assistant'), text('user'), toolUse('a'), toolResult('a')]
        expect(planCut(history, 1, preserveRecent)?.tail.at(-1)).toBe(history.at(-1))
      }
    })
  })

  // Seeded substitute for the #5736 fuzz corpus, which was never published: random agent histories, checked for the
  // cut's invariants and against main's own selection functions.
  describe('generated histories', () => {
    const histories = Array.from({ length: 3000 }, (_, seed) => generateHistory(seed))
    const preserveValues = [0, 1, 2, 3, 4, 0.3, 0.7]

    it('holds every invariant', { timeout: 30_000 }, () => {
      for (const { messages } of histories) {
        for (const [keepHead, endOnUser] of [
          [0, true],
          [0, false],
          [1, false],
        ] as const) {
          for (const preserveRecent of preserveValues) {
            const cut = planCut(messages, keepHead, preserveRecent, endOnUser)
            if (cut) expectInvariants(messages, cut, keepHead, endOnUser)
            else expectNoLegalCut(messages, keepHead, preserveRecent, endOnUser)
          }
        }
      }
    })

    it('selects what main selects for alternating histories without pins', { timeout: 30_000 }, () => {
      for (const { messages, pins } of histories) {
        if (pins > 0) continue
        for (const preserveRecent of preserveValues) {
          const cut = planCut(messages, 1, preserveRecent)
          expect(cut?.body ?? []).toStrictEqual(mainSelection(messages, preserveRecent))
        }
      }
    })
  })
})

function expectInvariants(
  messages: Message[],
  cut: NonNullable<ReturnType<typeof planCut>>,
  keepHead: number,
  endOnUser: boolean
): void {
  expect([...cut.head, ...cut.body, ...cut.tail]).toStrictEqual(messages)
  expect(cut.body.length).toBeGreaterThan(0)
  expect(cut.tail.at(-1)).toBe(messages.at(-1))
  expect(cut.head.length - keepHead).toBeLessThanOrEqual(1)
  const bodyStart = cut.head.length
  const tailStart = bodyStart + cut.body.length
  expect(splitsPair(messages, bodyStart)).toBe(false)
  expect(splitsPair(messages, tailStart)).toBe(false)
  expect(messages[tailStart - 1]!.role).not.toBe(messages[tailStart]!.role)
  if (endOnUser) expect(cut.body.at(-1)!.role).toBe('user')
  for (let index = bodyStart; index < tailStart; index++) expect(isPinned(messages, index)).toBe(false)
}

/** Brute force: no boundary up to the preserveRecent target summarizes anything legally. */
function expectNoLegalCut(messages: Message[], keepHead: number, preserveRecent: number, endOnUser: boolean): void {
  const bodyStart = keepHead > 0 && splitsPair(messages, keepHead) ? keepHead + 1 : keepHead
  const target = Math.min(messages.length - resolvePreserveCount(messages.length, preserveRecent), messages.length - 1)
  for (let tailStart = bodyStart + 1; tailStart <= target; tailStart++) {
    const legal =
      (!endOnUser || messages[tailStart - 1]!.role === 'user') &&
      !splitsPair(messages, tailStart) &&
      messages[tailStart - 1]!.role !== messages[tailStart]!.role &&
      messages.slice(bodyStart, tailStart).every((_, offset) => !isPinned(messages, bodyStart + offset))
    expect(legal, `boundary ${tailStart} is legal`).toBe(false)
  }
}

/** The messages main's message-level summarize pass removes for target '*', using main's own functions. */
function mainSelection(messages: Message[], preserveRecent: number): Message[] {
  const toolNames = buildToolNameMap(messages)
  const candidates =
    preserveRecent > 0
      ? getOldestMatches(messages, '*', preserveRecent, toolNames, undefined, undefined).filter(
          (message) => messages.indexOf(message) > 0
        )
      : messages.filter((_, index) => index > 0)
  const selected = new Set(
    candidates.flatMap((message) => collectRemovableWithPair(messages, messages.indexOf(message)))
  )
  return messages.filter((message) => selected.has(message))
}

function splitsPair(messages: Message[], index: number): boolean {
  const message = messages[index]
  const previous = messages[index - 1]
  if (!message || !previous) return false
  return (
    message.content.some((block) => block instanceof ToolResultBlock) &&
    previous.content.some((block) => block instanceof ToolUseBlock)
  )
}

/** A random agent history: alternating roles, tool pairs, occasional pins, ending on a user turn. */
function generateHistory(seed: number): { messages: Message[]; pins: number } {
  const random = mulberry32(seed + 1)
  const messages: Message[] = [text('user', 'task')]
  const turns = 1 + Math.floor(random() * 8)
  let pins = 0
  for (let turn = 0; turn < turns; turn++) {
    const toolCalls = Math.floor(random() * 3)
    for (let call = 0; call < toolCalls; call++) {
      const id = `t${turn}-${call}`
      messages.push(toolUse(id), toolResult(id))
    }
    messages.push(text('assistant', `answer ${turn}`), text('user', `question ${turn}`))
  }
  for (let index = 1; index < messages.length - 1; index++) {
    if (random() < 0.05) {
      const message = messages[index]!
      messages[index] = new Message({
        role: message.role,
        content: message.content,
        metadata: { custom: { pinned: true } },
      })
      pins++
    }
  }
  return { messages, pins }
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
