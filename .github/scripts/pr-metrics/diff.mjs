// Unified-diff parsing: which lines did this PR actually change?
//
// The complexity labeler scores only the functions a diff touches, so a file
// that already contains a very complex function does not tag every PR that
// edits an unrelated part of it.

/**
 * Parse a unified diff into added/changed line numbers per file, using
 * post-image (new file) numbering.
 *
 * Deleted lines are deliberately ignored: they no longer exist in the head
 * revision, so no function range can contain them.
 *
 * @param {string} diff - output of `git diff -U0`
 * @returns {Map<string, Set<number>>} new path -> changed line numbers
 */
export function parseChangedLines(diff) {
  const changed = new Map()
  let path = null
  let newLine = -1
  // Header lines and body lines share prefixes ('+++' is a valid added line
  // whose content begins with '++'), so they are only distinguishable by
  // position: headers precede the first @@ hunk of each file.
  let inHunk = false

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      path = null
      newLine = -1
      inHunk = false
      continue
    }

    if (!inHunk && line.startsWith('+++ ')) {
      // git appends a tab after paths containing whitespace, and may append
      // timestamp fields; a real filename can end in a space, so only strip
      // from the tab onward rather than trimming.
      const target = line.slice(4).replace(/\t.*$/, '')
      path = target === '/dev/null' ? null : stripPrefix(target)
      continue
    }

    if (line.startsWith('@@')) {
      inHunk = true
      const m = /^@@+ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(line)
      if (!m) {
        newLine = -1
        continue
      }
      // A hunk with a zero-length post-image is a pure deletion.
      newLine = m[2] === '0' ? -1 : Number(m[1])
      continue
    }

    if (!inHunk || path === null || newLine < 0) continue

    if (line.startsWith('+')) {
      if (!changed.has(path)) changed.set(path, new Set())
      changed.get(path).add(newLine)
      newLine += 1
    } else if (line.startsWith(' ') || line === '') {
      // A context line; an empty string is an unchanged blank line, which git
      // may emit without its leading space.
      newLine += 1
    }
    // '-' (deletion) and '\' (no-newline marker) do not advance post-image
    // numbering.
  }
  return changed
}

// git prefixes paths with a/ and b/ unless --no-prefix is used.
function stripPrefix(p) {
  return p.startsWith('b/') || p.startsWith('a/') ? p.slice(2) : p
}

/**
 * Does a function's line range overlap any changed line?
 * Both bounds are inclusive and 1-indexed.
 */
export function rangeTouched(changedLines, startLine, endLine) {
  if (!changedLines) return false
  for (let n = startLine; n <= endLine; n += 1) {
    if (changedLines.has(n)) return true
  }
  return false
}
