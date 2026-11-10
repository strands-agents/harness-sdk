/**
 * Regex pattern for validating language/interpreter names.
 * Allows alphanumeric characters, dots, hyphens, and underscores.
 * Rejects path separators, spaces, and shell metacharacters to prevent injection.
 */
export const LANGUAGE_PATTERN = /^[a-zA-Z0-9._-]+$/

/**
 * Regex pattern for validating environment variable names: a leading letter or
 * underscore, followed by letters, digits, or underscores (valid POSIX names).
 * Names outside this set are rejected to prevent shell-syntax injection where a
 * key is interpolated into a command, and to fail with a clear error otherwise.
 */
export const ENV_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Shell-escape a string for safe inclusion in a shell command.
 *
 * Wraps the value in single quotes and escapes any embedded single quotes
 * using the '\'' pattern. Single quotes disable all shell expansion
 * (variables, backticks, globbing), making this safe against injection.
 *
 * @param value - The string to escape.
 * @returns The shell-escaped string wrapped in single quotes.
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}
