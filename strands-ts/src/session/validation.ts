import type { Scope } from './types.js'

/**
 * Validates that an identifier contains only allowed characters.
 * Allowed characters: lowercase letters (a-z), numbers (0-9), hyphens (-), and underscores (_)
 *
 * @param id - The identifier to validate
 * @returns The validated identifier
 * @throws Error if identifier contains invalid characters
 */
export function validateIdentifier(id: string): string {
  const validPattern = /^[a-z0-9_-]+$/
  if (!validPattern.test(id)) {
    throw new Error(`Identifier '${id}' can only contain lowercase letters, numbers, hyphens, and underscores`)
  }
  return id
}

/**
 * Validates that a snapshot scope is supported.
 *
 * @internal
 * @param scope - The scope to validate
 * @returns The validated scope
 * @throws Error if the scope is not supported
 */
export function validateScope(scope: unknown): Scope {
  if (scope !== 'agent' && scope !== 'multiAgent') {
    throw new Error(`Invalid scope '${String(scope)}': must be 'agent' or 'multiAgent'`)
  }
  return scope
}

/**
 * Validates that a string is a UUID v7.
 *
 * @param id - The string to validate
 * @throws Error if the string is not a valid UUID v7
 */
export function validateUuidV7(id: string): void {
  const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuidV7Pattern.test(id)) {
    throw new Error(`'${id}' is not a valid UUID v7 snapshot ID`)
  }
}
