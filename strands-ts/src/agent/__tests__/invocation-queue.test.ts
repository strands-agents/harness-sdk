import { describe, expect, it } from 'vitest'
import { InvocationQueue } from '../invocation-queue.js'
import { PendingInvocationCancelledError } from '../../errors.js'
import { AgentResult } from '../../types/agent.js'
import { Message, TextBlock } from '../../types/messages.js'

function fakeResult(text: string): AgentResult {
  return { lastMessage: new Message({ role: 'assistant', content: [new TextBlock(text)] }) } as unknown as AgentResult
}

describe('InvocationQueue', () => {
  it('lists entries in run order with id, submittedAt, and mode', () => {
    const queue = new InvocationQueue()
    void queue.wait('first', { mode: 'queue' }).catch(() => {})
    void queue.wait('second', { mode: 'inject' }).catch(() => {})

    const listed = queue.list()
    expect(listed.map((entry) => entry.id)).toEqual(['pending-1', 'pending-2'])
    expect(listed.map((entry) => entry.mode)).toEqual(['queue', 'inject'])
    expect(listed[0]!.submittedAt).toBeInstanceOf(Date)
    expect(Object.isFrozen(listed[0])).toBe(true)
    expect(queue.size).toBe(2)
  })

  it('resolves waiters FIFO on handoff', async () => {
    const queue = new InvocationQueue()
    const order: string[] = []
    const first = queue.wait('a', { mode: 'queue' }).then(() => order.push('a'))
    const second = queue.wait('b', { mode: 'queue' }).then(() => order.push('b'))

    expect(queue.handoff()).toBe(true)
    await first
    expect(queue.handoff()).toBe(true)
    await second
    expect(order).toEqual(['a', 'b'])
    expect(queue.size).toBe(0)
  })

  it('returns false from handoff when empty', () => {
    expect(new InvocationQueue().handoff()).toBe(false)
  })

  it('inserts cancelPrevious entries ahead of waiting ones', async () => {
    const queue = new InvocationQueue()
    const order: string[] = []
    const normal = queue.wait('normal', { mode: 'queue' }).then(() => order.push('normal'))
    const urgent = queue.wait('urgent', { mode: 'cancelPrevious' }).then(() => order.push('urgent'))

    queue.handoff()
    await urgent
    queue.handoff()
    await normal
    expect(order).toEqual(['urgent', 'normal'])
  })

  it('a cancelPrevious entry displaces queued cancelPrevious predecessors but not plain ones', async () => {
    const queue = new InvocationQueue()
    const plain = queue.wait('plain', { mode: 'queue' })
    const older = queue.wait('older-urgent', { mode: 'cancelPrevious' })
    const newer = queue.wait('newer-urgent', { mode: 'cancelPrevious' })

    await expect(older).rejects.toThrow(PendingInvocationCancelledError)
    expect(queue.list().map((entry) => entry.id)).toEqual(['pending-3', 'pending-1'])
    queue.handoff()
    await newer
    queue.handoff()
    await plain
  })

  it('cancel removes the entry and rejects its waiter with the entry id', async () => {
    const queue = new InvocationQueue()
    const waiting = queue.wait('doomed', { mode: 'queue' })
    expect(queue.cancel('pending-1')).toBe(true)
    await expect(waiting).rejects.toMatchObject({ pendingInvocationId: 'pending-1' })
    expect(queue.size).toBe(0)
  })

  it('cancel returns false for an unknown id', () => {
    expect(new InvocationQueue().cancel('pending-99')).toBe(false)
  })

  it('rejects immediately when the cancelSignal is already aborted', async () => {
    const queue = new InvocationQueue()
    const controller = new AbortController()
    controller.abort()
    await expect(queue.wait('late', { mode: 'queue', cancelSignal: controller.signal })).rejects.toThrow(
      PendingInvocationCancelledError
    )
    expect(queue.size).toBe(0)
  })

  it('removes the entry and rejects when the cancelSignal aborts while queued', async () => {
    const queue = new InvocationQueue()
    const controller = new AbortController()
    const waiting = queue.wait('abandoned', { mode: 'queue', cancelSignal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toThrow(PendingInvocationCancelledError)
    expect(queue.size).toBe(0)
  })

  it('detaches the abort listener on handoff (a later abort does not reject)', async () => {
    const queue = new InvocationQueue()
    const controller = new AbortController()
    const waiting = queue.wait('handed-off', { mode: 'queue', cancelSignal: controller.signal })
    queue.handoff()
    await expect(waiting).resolves.toBeUndefined()
    controller.abort()
  })

  it('notifies onEnqueue listeners when an entry enters the queue, including at the front', () => {
    const queue = new InvocationQueue()
    let notified = 0
    queue.onEnqueue(() => notified++)
    void queue.wait('first', { mode: 'queue' }).catch(() => {})
    expect(notified).toBe(1)
    void queue.wait('urgent', { mode: 'cancelPrevious' }).catch(() => {})
    expect(notified).toBe(2)
  })

  it('does not notify onEnqueue when a pre-aborted call is rejected without queueing', () => {
    const queue = new InvocationQueue()
    let notified = 0
    queue.onEnqueue(() => notified++)
    const aborted = new AbortController()
    aborted.abort()
    void queue.wait('never queued', { mode: 'queue', cancelSignal: aborted.signal }).catch(() => {})
    expect(notified).toBe(0)
  })

  it('stops notifying a detached onEnqueue listener', () => {
    const queue = new InvocationQueue()
    let notified = 0
    const detach = queue.onEnqueue(() => notified++)
    void queue.wait('first', { mode: 'queue' }).catch(() => {})
    detach()
    void queue.wait('second', { mode: 'queue' }).catch(() => {})
    expect(notified).toBe(1)
  })

  describe('inject entries', () => {
    it('takeInjects removes only inject entries, in submission order, leaving other modes queued', () => {
      const queue = new InvocationQueue()
      void queue.wait('q1', { mode: 'queue' }).catch(() => {})
      void queue.wait('i1', { mode: 'inject' }).catch(() => {})
      void queue.wait('q2', { mode: 'queue' }).catch(() => {})
      void queue.wait('i2', { mode: 'inject' }).catch(() => {})

      const taken = queue.takeInjects()
      expect(taken.map((inject) => inject.args)).toEqual(['i1', 'i2'])
      expect(queue.list().map((entry) => entry.id)).toEqual(['pending-1', 'pending-3'])
    })

    it('an absorbed inject resolves its waiter with the absorbing result', async () => {
      const queue = new InvocationQueue()
      const waiting = queue.wait('joined', { mode: 'inject' })
      const [inject] = queue.takeInjects()
      const result = fakeResult('done')
      inject!.resolve(result)
      await expect(waiting).resolves.toBe(result)
    })

    it('a taken inject no longer reacts to its cancelSignal', async () => {
      const queue = new InvocationQueue()
      const controller = new AbortController()
      const waiting = queue.wait('joined', { mode: 'inject', cancelSignal: controller.signal })
      const [inject] = queue.takeInjects()
      controller.abort()
      inject!.resolve(fakeResult('done'))
      await expect(waiting).resolves.toBeDefined()
    })

    it('requeue returns the call to the front as a queue entry that handoff grants the turn', async () => {
      const queue = new InvocationQueue()
      void queue.wait('later', { mode: 'queue' }).catch(() => {})
      const waiting = queue.wait('joined', { mode: 'inject' })
      const [inject] = queue.takeInjects()

      inject!.requeue()
      expect(queue.list().map((entry) => [entry.id, entry.mode])).toEqual([
        ['pending-2', 'queue'],
        ['pending-1', 'queue'],
      ])
      expect(queue.handoff()).toBe(true)
      await expect(waiting).resolves.toBeUndefined()
    })

    it('a requeued inject re-arms its cancelSignal', async () => {
      const queue = new InvocationQueue()
      const controller = new AbortController()
      const waiting = queue.wait('joined', { mode: 'inject', cancelSignal: controller.signal })
      const [inject] = queue.takeInjects()
      inject!.requeue()
      controller.abort()
      await expect(waiting).rejects.toThrow(PendingInvocationCancelledError)
      expect(queue.size).toBe(0)
    })

    it('an inject entry still queued at handoff is granted the turn like any other', async () => {
      const queue = new InvocationQueue()
      const waiting = queue.wait('missed', { mode: 'inject' })
      expect(queue.handoff()).toBe(true)
      await expect(waiting).resolves.toBeUndefined()
    })

    it('handoff demotes every inject left behind to a queue entry so none joins the next turn owner', () => {
      const queue = new InvocationQueue()
      void queue.wait('missed-1', { mode: 'inject' }).catch(() => {})
      void queue.wait('missed-2', { mode: 'inject' }).catch(() => {})
      void queue.wait('urgent', { mode: 'cancelPrevious' }).catch(() => {})

      expect(queue.handoff()).toBe(true)
      expect(queue.list().map((entry) => [entry.id, entry.mode])).toEqual([
        ['pending-1', 'queue'],
        ['pending-2', 'queue'],
      ])
      expect(queue.takeInjects()).toEqual([])
    })

    it('requeue rejects a call whose cancelSignal already aborted instead of queueing it', async () => {
      const queue = new InvocationQueue()
      const controller = new AbortController()
      const waiting = queue.wait('joined', { mode: 'inject', cancelSignal: controller.signal })
      const [inject] = queue.takeInjects()
      controller.abort()
      inject!.requeue()
      await expect(waiting).rejects.toThrow(PendingInvocationCancelledError)
      expect(queue.size).toBe(0)
    })
  })
})
