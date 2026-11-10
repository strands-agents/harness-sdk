/**
 * Ensures a value is defined, throwing an error if it's null or undefined.
 *
 * @param value - The value to check
 * @param fieldName - Name of the field for error reporting
 * @returns The value if defined
 * @throws Error if value is null or undefined
 */
export function ensureDefined<T>(value: T | null | undefined, fieldName: string): T {
  if (value == null) {
    throw new Error(`Expected ${fieldName} to be defined, but got ${value}`)
  }
  return value
}
