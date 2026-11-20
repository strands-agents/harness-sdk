import { describe, it, expect } from 'vitest'
import { Message, TextBlock } from '../../types/messages.js'
import { holdsRun, placeholderFor, removeMessages } from '../message-trimming.js'
import type { Model } from '../../models/model.js'

const history = (): Message[] => [
  new Message({ role: 'user', content: [new TextBlock('task')] }),
  new Message({ role: 'assistant', content: [new TextBlock('old1')] }),
  new Message({ role: 'user', content: [new TextBlock('old2')] }),
  new Message({ role: 'assistant', content: [new TextBlock('old3')] }),
  new Message({ role: 'user', content: [new TextBlock('recent')] }),
]

const texts = (messages: Message[]): string[] =>
  messages.flatMap((message) => message.content.map((block) => (block as TextBlock).text))

/** A token count that removes `victimIndex` from the history, standing in for a pass running concurrently. */
function mutatingModel(messages: Message[], victimIndex?: number): Pick<Model, 'countTokens'> {
  let fired = false
  return {
    countTokens: async (): Promise<number> => {
      if (victimIndex !== undefined && !fired) {
        fired = true
        messages.splice(victimIndex, 1)
      }
      return 100
    },
  }
}

const drop = (messages: Message[], toRemove: Message[], model: Pick<Model, 'countTokens'>): Promise<boolean> =>
  removeMessages(
    messages,
    toRemove,
    placeholderFor(model, (tokens) => `[Dropped ${tokens}]`),
    'drop',
    undefined
  )

describe('holdsRun', () => {
  it('holds a run at its own index', () => {
    const messages = history()

    expect(holdsRun(messages, 1, messages.slice(1, 3))).toBe(true)
  })

  it('rejects a run that moved', () => {
    const messages = history()

    expect(holdsRun(messages, 2, messages.slice(1, 3))).toBe(false)
  })

  it('rejects a run reaching past the history', () => {
    const messages = history()

    expect(holdsRun(messages, 3, [...messages.slice(3), new Message({ role: 'user', content: [] })])).toBe(false)
  })

  it('compares by identity rather than equality', () => {
    const messages = history()

    expect(holdsRun(messages, 1, [new Message({ role: 'assistant', content: [new TextBlock('old1')] })])).toBe(false)
  })
})

describe('removeMessages', () => {
  // A run is selected before the token count it is measured by, so the history can change in between.

  it('replaces a run whose messages all remain', async () => {
    const messages = history()
    const selected = messages.slice(1, 3)

    expect(await drop(messages, selected, mutatingModel(messages))).toBe(true)

    // The marker joins the assistant message beside the gap rather than becoming one of its own.
    expect(texts(messages)).toEqual(['task', 'old3', '[Dropped 100]', 'recent'])
  })

  it('keeps the history when the run head leaves during the count', async () => {
    const messages = history()
    const selected = messages.slice(1, 3)

    expect(await drop(messages, selected, mutatingModel(messages, 1))).toBe(false)

    // The head's removal is the only one: the run is no longer there to replace, so nothing else is taken.
    expect(texts(messages)).toEqual(['task', 'old2', 'old3', 'recent'])
  })

  it('keeps unselected messages when the run is broken up during the count', async () => {
    const messages = history()
    const selected = messages.slice(1, 3)

    expect(await drop(messages, selected, mutatingModel(messages, 2))).toBe(false)

    // Removing the run by its length from the surviving head would reach past it into messages nobody selected.
    expect(texts(messages)).toEqual(['task', 'old1', 'old3', 'recent'])
  })
})
