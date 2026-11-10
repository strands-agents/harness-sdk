/**
 * Minimal async mutex for serializing access to a resource.
 *
 * `acquire()` resolves only once all previously acquired holders have released,
 * so awaiting callers run one at a time in FIFO order.
 */
export class AsyncLock {
  /** Resolves when the currently-held lock (if any) is released. */
  private _tail: Promise<void> = Promise.resolve()

  /**
   * Acquires the lock, waiting until all previously-acquired holders release.
   *
   * Declare the result with `using` to release the lock at scope exit:
   * `using _lock = await lock.acquire()`.
   *
   * @returns A handle whose disposal releases the lock. Disposal is idempotent.
   */
  async acquire(): Promise<{ [Symbol.dispose](): void }> {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })

    // Wait on the current tail, then install ours so the next acquirer waits on us.
    const previous = this._tail
    this._tail = previous.then(() => next)
    await previous

    let released = false
    return {
      [Symbol.dispose](): void {
        if (released) return
        released = true
        release()
      },
    }
  }
}
