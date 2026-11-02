/**
 * Path validation shared across sandbox-routed file tools.
 */

// Drive-letter (`C:\` / `C:/`) or UNC (`\\server\share`) roots; POSIX `/` is checked separately.
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/

/**
 * Reject non-absolute paths and `..` segments.
 *
 * @internal
 * @param filePath - Path supplied by the model.
 * @throws Error if the path is not absolute (POSIX or Windows), or contains a `..` segment.
 */
export function validateAbsolutePath(filePath: string): void {
  if (!(filePath.startsWith('/') || WINDOWS_ABSOLUTE.test(filePath))) {
    throw new Error(
      `The path ${filePath} is not absolute; it should start with '/' (or a drive letter or UNC share on Windows).`
    )
  }
  if (filePath.split(/[/\\]/).includes('..')) {
    throw new Error('Invalid path: path traversal is not allowed.')
  }
}
