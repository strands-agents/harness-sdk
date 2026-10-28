import { describe, it, expect } from 'vitest'
import { validateAbsolutePath } from '../paths.js'

describe('validateAbsolutePath', () => {
  it('accepts a POSIX absolute path', () => {
    validateAbsolutePath('/tmp/file.txt')
  })

  it('accepts a Windows drive-letter absolute path', () => {
    validateAbsolutePath('C:\\project\\file.txt')
  })

  it('accepts a UNC share', () => {
    validateAbsolutePath('\\\\server\\share\\file.txt')
  })

  it('rejects a relative path', () => {
    expect(() => validateAbsolutePath('relative.txt')).toThrow('not absolute')
  })

  it('rejects POSIX parent traversal', () => {
    expect(() => validateAbsolutePath('/tmp/../etc/passwd')).toThrow('path traversal is not allowed')
  })

  it('rejects Windows parent traversal', () => {
    // Backslash is the Windows separator and must also be inspected for `..`
    // segments so a POSIX-only split cannot hide a traversal.
    expect(() => validateAbsolutePath('C:\\project\\..\\etc\\hosts')).toThrow('path traversal is not allowed')
  })

  it('accepts a double-dot substring inside a segment', () => {
    // Only full segments equal to `..` are traversals; a filename that happens
    // to contain `..` as text is fine.
    validateAbsolutePath('/tmp/file..name.txt')
  })
})
