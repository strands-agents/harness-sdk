import { describe, expect, it } from 'vitest'
import { InvocationQueue } from '../invocation-queue.js'
import { PendingInvocationCancelledError } from '../../errors.js'

describe('InvocationQueue', () => {
  it('lists entries in run order with id, submittedAt, and mode', () => {
    const queue = new InvocationQueue()
    void queue.wait('first', { mode: 'queue' }).catch(() => {})
    void queue.wait('second', { mode: 'stopPrevious' }).catch(() => {})

    const listed = queue.list()
    expect(listed.map((entry) => entry.id)).toEqual(['pending-2', 'pending-1'])
    expect(listed.map((entry) => entry.mode)).toEqual(['stopPrevious', 'queue'])
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

  it('stopPrevious entries insert at the front and displace queued latest-wins predecessors of either mode', async () => {
    const queue = new InvocationQueue()
    const plain = queue.wait('plain', { mode: 'queue' })
    const olderCancel = queue.wait('older-cancel', { mode: 'cancelPrevious' })
    const olderStop = queue.wait('older-stop', { mode: 'stopPrevious' })
    const newest = queue.wait('newest-stop', { mode: 'stopPrevious' })

    await expect(olderCancel).rejects.toThrow(PendingInvocationCancelledError)
    await expect(olderStop).rejects.toThrow(PendingInvocationCancelledError)
    expect(queue.list().map((entry) => entry.mode)).toEqual(['stopPrevious', 'queue'])
    queue.handoff()
    await newest
    queue.handoff()
    await plain
  })

  it('a cancelPrevious entry displaces a queued stopPrevious entry', async () => {
    const queue = new InvocationQueue()
    const stop = queue.wait('stop', { mode: 'stopPrevious' })
    const cancel = queue.wait('cancel', { mode: 'cancelPrevious' })

    await expect(stop).rejects.toThrow(PendingInvocationCancelledError)
    expect(queue.size).toBe(1)
    queue.handoff()
    await cancel
  })
})
