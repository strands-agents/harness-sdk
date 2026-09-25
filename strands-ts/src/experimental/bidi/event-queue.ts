/** Single-consumer bounded queue for push-based provider transports. @internal */
export class EventQueue<T> {
  private readonly _items: T[] = []
  private _wake: (() => void) | undefined
  private _closed = false
  private _error: Error | undefined
  private _bytes = 0

  constructor(
    private readonly _capacity: number,
    private readonly _maxBytes: number
  ) {}

  push(value: T): void {
    if (this._closed) return
    const bytes = this._size(value)
    if (this._items.length >= this._capacity || this._bytes + bytes > this._maxBytes) {
      throw new Error('Bidirectional event buffer is full')
    }
    this._items.push(value)
    this._bytes += bytes
    this._notify()
  }

  discard(predicate: (value: T) => boolean): void {
    for (let index = this._items.length - 1; index >= 0; index--) {
      if (predicate(this._items[index]!)) {
        this._bytes -= this._size(this._items[index]!)
        this._items.splice(index, 1)
      }
    }
  }

  close(error?: Error): void {
    if (this._closed) return
    this._closed = true
    this._error = error
    if (error) {
      this._items.length = 0
      this._bytes = 0
    }
    this._notify()
  }

  async *receive(): AsyncGenerator<T> {
    while (true) {
      if (this._error) throw this._error
      if (this._items.length) {
        const value = this._items.shift()!
        this._bytes -= this._size(value)
        yield value
        continue
      }
      if (this._closed) return
      await new Promise<void>((resolve) => {
        this._wake = resolve
      })
    }
  }

  private _size(value: T): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  }

  private _notify(): void {
    this._wake?.()
    this._wake = undefined
  }
}
