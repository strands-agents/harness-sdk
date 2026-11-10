/**
 * Custom replacer for JSON.stringify that handles non-serializable types.
 * Converts Date to ISO string and replaces binary data, functions, symbols,
 * and BigInt with '<replaced>'.
 *
 * @param _key - The property key (unused)
 * @param value - The value to process
 * @returns A JSON-safe value
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  switch (true) {
    case value instanceof Date:
      return value.toISOString()
    case typeof value === 'bigint':
    case typeof value === 'function':
    case typeof value === 'symbol':
    case value instanceof ArrayBuffer:
    case value instanceof Uint8Array:
    case ArrayBuffer.isView(value):
      return '<replaced>'
    default:
      return value
  }
}
