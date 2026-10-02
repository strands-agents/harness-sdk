export { TestModelProvider } from '../testing/test-model-provider.js'

/**
 * Helper function to collect events and result from an async generator.
 * Properly handles AsyncGenerator where the final value is returned
 * rather than yielded.
 *
 * @param generator - An async generator that yields items and returns a final result
 * @returns Object with items array (yielded values) and result (return value)
 */
export async function collectGenerator<E, R>(
  generator: AsyncGenerator<E, R, never>
): Promise<{ items: E[]; result: R }> {
  const items: E[] = []
  let done = false
  let result: R | undefined

  while (!done) {
    const { value, done: isDone } = await generator.next()
    done = isDone ?? false
    if (!done) {
      items.push(value as E)
    } else {
      result = value as R
    }
  }

  return { items, result: result! }
}

/**
 * Helper function to collect all items from an async iterator.
 *
 * @param stream - An async iterable that yields items
 * @returns Array of all yielded items
 */
export async function collectIterator<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}
