import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileEditor, makeFileEditor } from '../file-editor.js'
import type { ToolContext } from '../../../index.js'
import { StateStore } from '../../../state-store.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { TestSandbox } from '../../../__fixtures__/test-sandbox.node.js'
import { promises as fs, mkdtempSync } from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'
import { Buffer } from 'buffer'

describe('fileEditor tool', () => {
  let testDir: string
  let context: ToolContext

  // Helper to create fresh state and context for each test
  const createFreshContext = (): { state: StateStore; context: ToolContext } => {
    const agent = createMockAgent()
    const toolContext: ToolContext = {
      toolUse: {
        name: 'fileEditor',
        toolUseId: 'test-id',
        input: {},
      },
      agent,
      invocationState: {},
      cancelSignal: agent.cancelSignal,
      interrupt: () => {
        throw new Error('interrupt not available in mock context')
      },
    }
    return { state: agent.appState, context: toolContext }
  }

  // Helper to create a test file
  const createTestFile = async (filename: string, content: string): Promise<string> => {
    const filePath = path.join(testDir, filename)
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return filePath
  }

  // Helper to create a test directory with files
  const createTestDirectory = async (dirName: string, files: Record<string, string>): Promise<string> => {
    const dirPath = path.join(testDir, dirName)
    await fs.mkdir(dirPath, { recursive: true })
    for (const [filename, content] of Object.entries(files)) {
      const filePath = path.join(dirPath, filename)
      const fileDir = path.dirname(filePath)
      await fs.mkdir(fileDir, { recursive: true })
      await fs.writeFile(filePath, content, 'utf-8')
    }
    return dirPath
  }

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = path.join(tmpdir(), `file-editor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(testDir, { recursive: true })

    // Create fresh state and context
    const fresh = createFreshContext()
    context = fresh.context
  })

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('view command', () => {
    describe('when viewing entire file', () => {
      it('returns file content with line numbers', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
        const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
        expect(result).toContain("Here's the result of running `cat -n`")
        expect(result).toContain('     1  Line 1')
        expect(result).toContain('     2  Line 2')
        expect(result).toContain('     3  Line 3')
      })

      it('handles empty file', async () => {
        const filePath = await createTestFile('empty.txt', '')
        const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
        expect(result).toContain("Here's the result of running `cat -n`")
      })

      it('handles single line file', async () => {
        const filePath = await createTestFile('single.txt', 'Only one line')
        const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
        expect(result).toContain('     1  Only one line')
      })
    })

    describe('when viewing with line range', () => {
      it('returns specified lines with line numbers', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5')
        const result = await fileEditor.invoke({ command: 'view', path: filePath, view_range: [2, 4] }, context)
        expect(result).toContain('     2  Line 2')
        expect(result).toContain('     3  Line 3')
        expect(result).toContain('     4  Line 4')
        expect(result).not.toContain('     1  ')
        expect(result).not.toContain('     5  ')
      })

      it('handles negative end index (-1 means to end)', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5')
        const result = await fileEditor.invoke({ command: 'view', path: filePath, view_range: [3, -1] }, context)
        expect(result).toContain('     3  Line 3')
        expect(result).toContain('     4  Line 4')
        expect(result).toContain('     5  Line 5')
        expect(result).not.toContain('     1  ')
        expect(result).not.toContain('     2  ')
      })

      it('handles single line range', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
        const result = await fileEditor.invoke({ command: 'view', path: filePath, view_range: [2, 2] }, context)
        expect(result).toContain('     2  Line 2')
        expect(result).not.toContain('     1  ')
        expect(result).not.toContain('     3  ')
      })
    })

    describe('when viewing directory', () => {
      it('lists files up to 2 levels deep', async () => {
        const dirPath = await createTestDirectory('testdir', {
          'file1.txt': 'content',
          'file2.txt': 'content',
          'subdir/file3.txt': 'content',
          'subdir/nested/file4.txt': 'content',
        })
        const result = await fileEditor.invoke({ command: 'view', path: dirPath }, context)
        expect(result).toContain('file1.txt')
        expect(result).toContain('file2.txt')
        expect(result).toContain('subdir')
        expect(result).toContain('file3.txt')
        expect(result).toContain('file4.txt')
      })

      it('excludes hidden files', async () => {
        const dirPath = await createTestDirectory('testdir', {
          'visible.txt': 'content',
          '.hidden.txt': 'content',
          'subdir/.hidden-dir/file.txt': 'content',
        })
        const result = await fileEditor.invoke({ command: 'view', path: dirPath }, context)
        expect(result).toContain('visible.txt')
        expect(result).not.toContain('.hidden')
      })
    })

    describe('error cases', () => {
      it('throws when file not found', async () => {
        const nonExistentPath = path.join(testDir, 'nonexistent.txt')
        await expect(fileEditor.invoke({ command: 'view', path: nonExistentPath }, context)).rejects.toThrow(
          'does not exist'
        )
      })

      it('throws when path is not absolute', async () => {
        await expect(fileEditor.invoke({ command: 'view', path: 'relative/path.txt' }, context)).rejects.toThrow(
          'not an absolute path'
        )
      })

      it('normalizes .. and defers existence to the sandbox', async () => {
        // No root configured: `..` normalizes lexically and the sandbox decides
        // what exists. The resolver does not manufacture a traversal error.
        await expect(
          fileEditor.invoke({ command: 'view', path: '/tmp/../nonexistent-xyzzy' }, context)
        ).rejects.toThrow(/does not exist/)
      })

      it('throws when view_range has invalid start line', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
        await expect(
          fileEditor.invoke({ command: 'view', path: filePath, view_range: [0, 2] }, context)
        ).rejects.toThrow('view_range')
      })

      it('throws when view_range end is beyond file length', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
        await expect(
          fileEditor.invoke({ command: 'view', path: filePath, view_range: [1, 10] }, context)
        ).rejects.toThrow('view_range')
      })

      it('throws when view_range end is before start', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
        await expect(
          fileEditor.invoke({ command: 'view', path: filePath, view_range: [3, 1] }, context)
        ).rejects.toThrow('view_range')
      })

      it('throws when view_range is provided for directory', async () => {
        const dirPath = await createTestDirectory('testdir', { 'file.txt': 'content' })
        await expect(
          fileEditor.invoke({ command: 'view', path: dirPath, view_range: [1, 2] }, context)
        ).rejects.toThrow('not allowed when')
      })
    })
  })

  describe('create command', () => {
    it('creates new file with content', async () => {
      const filePath = path.join(testDir, 'new-file.txt')
      const content = 'Hello World\nLine 2'
      const result = await fileEditor.invoke({ command: 'create', path: filePath, file_text: content }, context)
      expect(result).toContain('File created successfully')
      expect(result).toContain(filePath)

      // Verify file was created
      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe(content)
    })

    it('creates file in non-existent directory', async () => {
      const filePath = path.join(testDir, 'newdir', 'subdir', 'new-file.txt')
      const content = 'Content'
      const result = await fileEditor.invoke({ command: 'create', path: filePath, file_text: content }, context)
      expect(result).toContain('File created successfully')

      // Verify file and directories were created
      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe(content)
    })

    it('creates empty file', async () => {
      const filePath = path.join(testDir, 'empty.txt')
      const result = await fileEditor.invoke({ command: 'create', path: filePath, file_text: '' }, context)
      expect(result).toContain('File created successfully')

      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('')
    })

    describe('error cases', () => {
      it('throws when file already exists', async () => {
        const filePath = await createTestFile('existing.txt', 'content')
        await expect(
          fileEditor.invoke({ command: 'create', path: filePath, file_text: 'new content' }, context)
        ).rejects.toThrow('already exists')
      })

      it('throws when path is not absolute', async () => {
        await expect(
          fileEditor.invoke({ command: 'create', path: 'relative/path.txt', file_text: 'content' }, context)
        ).rejects.toThrow('not an absolute path')
      })

      it('throws when path contains traversal', async () => {
        const filePath = '..outside.txt'
        await expect(
          fileEditor.invoke({ command: 'create', path: filePath, file_text: 'content' }, context)
        ).rejects.toThrow()
      })

      it('throws when trying to create in directory as path', async () => {
        const dirPath = await createTestDirectory('testdir', {})
        await expect(
          fileEditor.invoke({ command: 'create', path: dirPath, file_text: 'content' }, context)
        ).rejects.toThrow('already exists')
      })
    })
  })

  describe('view media', () => {
    const imageCases: [string, string][] = [
      ['photo.png', 'png'],
      ['photo.jpg', 'jpeg'],
      ['photo.jpeg', 'jpeg'],
      ['photo.gif', 'gif'],
      ['photo.webp', 'webp'],
      ['photo.PNG', 'png'],
    ]
    for (const [filename, expectedFormat] of imageCases) {
      it(`returns an image content block for ${filename}`, async () => {
        const payload = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
        const filePath = path.join(testDir, filename)
        await fs.writeFile(filePath, payload)
        const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
        expect(result).toMatchObject({
          status: 'success',
          toolUseId: 'test-id',
          content: [{ image: { format: expectedFormat } }],
        })
        const block = (result as unknown as { content: [{ image: { source: { bytes: Uint8Array } } }] }).content[0]
        expect(Buffer.from(block.image.source.bytes)).toEqual(payload)
      })
    }

    const docCases: [string, string][] = [
      ['report.pdf', 'pdf'],
      ['report.doc', 'doc'],
      ['report.docx', 'docx'],
      ['report.xls', 'xls'],
      ['report.xlsx', 'xlsx'],
    ]
    for (const [filename, expectedFormat] of docCases) {
      it(`returns a document content block for ${filename}`, async () => {
        const payload = Buffer.concat([Buffer.from('%PDF-1.4\n%\xd0\xd4\xc5\xd8\n', 'binary'), Buffer.alloc(32)])
        const filePath = path.join(testDir, filename)
        await fs.writeFile(filePath, payload)
        const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
        expect(result).toMatchObject({
          status: 'success',
          content: [{ document: { format: expectedFormat, name: filename } }],
        })
      })
    }

    for (const filename of ['notes.csv', 'notes.html', 'notes.txt', 'notes.md']) {
      it(`keeps ${filename} on the text path (numbered lines)`, async () => {
        // csv/html/txt/md are documents by Bedrock's taxonomy but text-
        // representable, so view stays on the numbered-lines path where
        // find_line and str_replace still work.
        const filePath = path.join(testDir, filename)
        await fs.writeFile(filePath, 'alpha\nbeta\n', 'utf-8')
        const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
        expect(typeof result).toBe('string')
        expect(result as string).toContain('alpha')
        expect(result as string).toContain('beta')
      })
    }

    it('rejects view_range on an image', async () => {
      const filePath = path.join(testDir, 'photo.png')
      await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      await expect(fileEditor.invoke({ command: 'view', path: filePath, view_range: [1, 2] }, context)).rejects.toThrow(
        /view_range/
      )
    })

    it('rejects view_range on a document', async () => {
      const filePath = path.join(testDir, 'report.pdf')
      await fs.writeFile(filePath, Buffer.from('%PDF-1.4\n', 'utf-8'))
      await expect(fileEditor.invoke({ command: 'view', path: filePath, view_range: [1, 2] }, context)).rejects.toThrow(
        /view_range/
      )
    })

    it('still enforces max_file_size on media', async () => {
      const filePath = path.join(testDir, 'big.png')
      await fs.writeFile(filePath, Buffer.alloc(4096))
      const editor = makeFileEditor({ maxFileSize: 256 })
      await expect(editor.invoke({ command: 'view', path: filePath }, context)).rejects.toThrow(
        /exceeds maximum allowed size/
      )
    })
  })

  describe('str_replace command', () => {
    it('replaces unique string occurrence', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2 OLD\nLine 3\nLine 4')
      const result = await fileEditor.invoke(
        { command: 'str_replace', path: filePath, old_str: 'OLD', new_str: 'NEW' },
        context
      )
      expect(result).toContain('The file')
      expect(result).toContain('has been edited')
      expect(result).toContain('NEW')

      // Verify file was updated
      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('Line 1\nLine 2 NEW\nLine 3\nLine 4')
    })

    it('shows snippet with 4 lines before and after change', async () => {
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5 OLD\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10'
      const filePath = await createTestFile('test.txt', content)
      const result = await fileEditor.invoke(
        { command: 'str_replace', path: filePath, old_str: 'OLD', new_str: 'NEW' },
        context
      )
      // Should show lines 1-9 (4 before + line 5 + 4 after)
      expect(result).toContain('Line 1')
      expect(result).toContain('Line 9')
      expect(result).not.toContain('Line 10')
    })

    it('handles empty new_str (deletion)', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2 DELETE_ME\nLine 3')
      const result = await fileEditor.invoke(
        { command: 'str_replace', path: filePath, old_str: ' DELETE_ME', new_str: '' },
        context
      )
      expect(result).toContain('has been edited')

      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('Line 1\nLine 2\nLine 3')
    })

    it('handles multi-line old_str', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nOLD LINE 1\nOLD LINE 2\nLine 4')
      const result = await fileEditor.invoke(
        { command: 'str_replace', path: filePath, old_str: 'OLD LINE 1\nOLD LINE 2', new_str: 'NEW LINE' },
        context
      )
      expect(result).toContain('has been edited')

      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('Line 1\nNEW LINE\nLine 4')
    })

    it('preserves dollar sign patterns in new_str literally', async () => {
      const filePath = await createTestFile('test.txt', 'const value = getPrice()')
      await fileEditor.invoke(
        { command: 'str_replace', path: filePath, old_str: 'getPrice()', new_str: '$& is not $1 or $$' },
        context
      )

      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('const value = $& is not $1 or $$')
    })

    describe('error cases', () => {
      it('throws when old_str not found', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
        await expect(
          fileEditor.invoke({ command: 'str_replace', path: filePath, old_str: 'NOTFOUND', new_str: 'NEW' }, context)
        ).rejects.toThrow('did not appear')
      })

      it('throws when multiple occurrences of old_str', async () => {
        const filePath = await createTestFile('test.txt', 'DUP Line 1\nLine 2\nDUP Line 3')
        await expect(
          fileEditor.invoke({ command: 'str_replace', path: filePath, old_str: 'DUP', new_str: 'NEW' }, context)
        ).rejects.toThrow('Multiple occurrences')
      })

      it('throws when file not found', async () => {
        const nonExistentPath = path.join(testDir, 'nonexistent.txt')
        await expect(
          fileEditor.invoke({ command: 'str_replace', path: nonExistentPath, old_str: 'OLD', new_str: 'NEW' }, context)
        ).rejects.toThrow('does not exist')
      })

      it('throws when path is directory', async () => {
        const dirPath = await createTestDirectory('testdir', {})
        await expect(
          fileEditor.invoke({ command: 'str_replace', path: dirPath, old_str: 'OLD', new_str: 'NEW' }, context)
        ).rejects.toThrow('directory')
      })

      it('rejects empty old_str', async () => {
        const filePath = await createTestFile('test.txt', 'some content')
        await expect(
          fileEditor.invoke({ command: 'str_replace', path: filePath, old_str: '', new_str: 'x' }, context)
        ).rejects.toThrow('must not be empty')
      })

      it('preserves tabs and CRLF outside the edited region', async () => {
        const content = 'func a() {\n\treturn 1\n}\r\n\r\nfunc b() {\n\treturn 2\n}\n'
        const filePath = await createTestFile('preserve.go', content)
        await fileEditor.invoke(
          { command: 'str_replace', path: filePath, old_str: '\treturn 1', new_str: '\treturn 10' },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('func a() {\n\treturn 10\n}\r\n\r\nfunc b() {\n\treturn 2\n}\n')
      })

      it('reports correct line numbers for repeated multi-line old_str', async () => {
        const content = 'if (x) {\n  do()\n}\nspacer\nif (x) {\n  do()\n}\n'
        const filePath = await createTestFile('multi.txt', content)
        await expect(
          fileEditor.invoke(
            { command: 'str_replace', path: filePath, old_str: 'if (x) {\n  do()\n}', new_str: 'z' },
            context
          )
        ).rejects.toThrow(/lines \[1,5\]/)
      })

      it('preserves a file that is entirely tabs', async () => {
        const content = '\t\t\tfirst\n\t\t\tsecond\n\t\t\tthird\n'
        const filePath = await createTestFile('tabs.txt', content)
        await fileEditor.invoke(
          { command: 'str_replace', path: filePath, old_str: '\t\t\tsecond', new_str: '\t\t\treplaced' },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('\t\t\tfirst\n\t\t\treplaced\n\t\t\tthird\n')
      })

      it('preserves an all-CRLF file when editing one line', async () => {
        const content = 'line1\r\nline2\r\nline3\r\n'
        const filePath = await createTestFile('crlf.txt', content)
        await fileEditor.invoke(
          { command: 'str_replace', path: filePath, old_str: 'line2', new_str: 'changed' },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('line1\r\nchanged\r\nline3\r\n')
      })

      it('handles old_str that spans multiple lines', async () => {
        const content = 'function hello() {\n  console.log("hi")\n  return true\n}\n'
        const filePath = await createTestFile('span.ts', content)
        await fileEditor.invoke(
          {
            command: 'str_replace',
            path: filePath,
            old_str: '  console.log("hi")\n  return true',
            new_str: '  return false',
          },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('function hello() {\n  return false\n}\n')
      })

      it('handles replacing with empty string (deletion)', async () => {
        const content = 'keep\ndelete me\nkeep too\n'
        const filePath = await createTestFile('delete.txt', content)
        await fileEditor.invoke({ command: 'str_replace', path: filePath, old_str: 'delete me\n' }, context)
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('keep\nkeep too\n')
      })

      it('handles special regex characters in old_str', async () => {
        const content = 'price is $100.00 (USD)\nother line\n'
        const filePath = await createTestFile('regex.txt', content)
        await fileEditor.invoke(
          { command: 'str_replace', path: filePath, old_str: '$100.00 (USD)', new_str: '$200.00 (EUR)' },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('price is $200.00 (EUR)\nother line\n')
      })

      it('handles replacement at the very start of file', async () => {
        const content = 'first line\nsecond\n'
        const filePath = await createTestFile('start.txt', content)
        await fileEditor.invoke(
          { command: 'str_replace', path: filePath, old_str: 'first line', new_str: 'new first' },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('new first\nsecond\n')
      })

      it('handles replacement at the very end of file', async () => {
        const content = 'first\nlast line'
        const filePath = await createTestFile('end.txt', content)
        await fileEditor.invoke(
          { command: 'str_replace', path: filePath, old_str: 'last line', new_str: 'new last' },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('first\nnew last')
      })

      it('handles replacement that makes file larger', async () => {
        const content = 'x\n'
        const filePath = await createTestFile('grow.txt', content)
        await fileEditor.invoke(
          {
            command: 'str_replace',
            path: filePath,
            old_str: 'x',
            new_str: 'a very long replacement string that is much bigger',
          },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('a very long replacement string that is much bigger\n')
      })

      it('handles mixed tabs and spaces without corrupting either', async () => {
        const content = '\tindented with tab\n    indented with spaces\n  \tmixed\n'
        const filePath = await createTestFile('mixed.txt', content)
        await fileEditor.invoke(
          { command: 'str_replace', path: filePath, old_str: '    indented with spaces', new_str: '    changed' },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('\tindented with tab\n    changed\n  \tmixed\n')
      })
    })
  })

  describe('insert command', () => {
    it('inserts at beginning (line 0)', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
      const result = await fileEditor.invoke(
        { command: 'insert', path: filePath, insert_line: 0, new_str: 'NEW LINE' },
        context
      )
      expect(result).toContain('has been edited')

      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('NEW LINE\nLine 1\nLine 2\nLine 3')
    })

    it('inserts in middle', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
      const result = await fileEditor.invoke(
        { command: 'insert', path: filePath, insert_line: 2, new_str: 'NEW LINE' },
        context
      )
      expect(result).toContain('has been edited')

      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('Line 1\nLine 2\nNEW LINE\nLine 3')
    })

    it('inserts at end', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2\nLine 3')
      const result = await fileEditor.invoke(
        { command: 'insert', path: filePath, insert_line: 3, new_str: 'NEW LINE' },
        context
      )
      expect(result).toContain('has been edited')

      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('Line 1\nLine 2\nLine 3\nNEW LINE')
    })

    it('shows snippet with 4 lines before and after insertion', async () => {
      const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9'
      const filePath = await createTestFile('test.txt', content)
      const result = await fileEditor.invoke(
        { command: 'insert', path: filePath, insert_line: 5, new_str: 'INSERTED' },
        context
      )
      // Inserting at line 5 (0-indexed) means after Line 5
      // Snippet shows 4 lines before (lines 2-5) + inserted + 4 lines after (lines 6-9)
      expect(result).toContain('Line 2')
      expect(result).toContain('Line 9')
      expect(result).toContain('INSERTED')
    })

    it('handles multi-line insertion', async () => {
      const filePath = await createTestFile('test.txt', 'Line 1\nLine 2')
      const result = await fileEditor.invoke(
        { command: 'insert', path: filePath, insert_line: 1, new_str: 'NEW 1\nNEW 2\nNEW 3' },
        context
      )
      expect(result).toContain('has been edited')

      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('Line 1\nNEW 1\nNEW 2\nNEW 3\nLine 2')
    })

    it('handles insertion in empty file', async () => {
      const filePath = await createTestFile('empty.txt', '')
      const result = await fileEditor.invoke(
        { command: 'insert', path: filePath, insert_line: 0, new_str: 'First line' },
        context
      )
      expect(result).toContain('has been edited')

      const fileContent = await fs.readFile(filePath, 'utf-8')
      expect(fileContent).toBe('First line')
    })

    describe('error cases', () => {
      it('throws when insert_line is negative', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2')
        await expect(
          fileEditor.invoke({ command: 'insert', path: filePath, insert_line: -1, new_str: 'NEW' }, context)
        ).rejects.toThrow('insert_line')
      })

      it('throws when insert_line is beyond file length', async () => {
        const filePath = await createTestFile('test.txt', 'Line 1\nLine 2')
        await expect(
          fileEditor.invoke({ command: 'insert', path: filePath, insert_line: 10, new_str: 'NEW' }, context)
        ).rejects.toThrow('insert_line')
      })

      it('throws when file not found', async () => {
        const nonExistentPath = path.join(testDir, 'nonexistent.txt')
        await expect(
          fileEditor.invoke({ command: 'insert', path: nonExistentPath, insert_line: 0, new_str: 'NEW' }, context)
        ).rejects.toThrow('does not exist')
      })

      it('throws when path is directory', async () => {
        const dirPath = await createTestDirectory('testdir', {})
        await expect(
          fileEditor.invoke({ command: 'insert', path: dirPath, insert_line: 0, new_str: 'NEW' }, context)
        ).rejects.toThrow('directory')
      })
    })
  })

  describe('path validation and security', () => {
    it('rejects relative paths', async () => {
      await expect(fileEditor.invoke({ command: 'view', path: 'relative/path.txt' }, context)).rejects.toThrow(
        'not an absolute path'
      )
    })
  })

  describe('file size limits', () => {
    it('throws when file exceeds configured size limit', async () => {
      const smallEditor = makeFileEditor({ maxFileSize: 1024 })
      const filePath = await createTestFile('large.txt', 'x'.repeat(2048))
      await expect(smallEditor.invoke({ command: 'view', path: filePath }, context)).rejects.toThrow('exceeds')
    })

    it('default cap is 1 MB: accepts a file just under and rejects a 2 MB file', async () => {
      const under = await createTestFile('under.txt', 'x'.repeat(1 * 1024 * 1024 - 1))
      const result = await fileEditor.invoke({ command: 'view', path: under }, context)
      expect(result).toContain('cat -n')
      const over = await createTestFile('over.txt', 'x'.repeat(2 * 1024 * 1024))
      await expect(fileEditor.invoke({ command: 'view', path: over }, context)).rejects.toThrow('exceeds')
    })
  })

  describe('binary rejection', () => {
    it('rejects a binary file on view', async () => {
      const filePath = path.join(testDir, 'binary.bin')
      await fs.writeFile(filePath, Buffer.from([0x00, 0x01, 0x02, 0x66, 0x6f, 0x6f, 0x00]))
      await expect(fileEditor.invoke({ command: 'view', path: filePath }, context)).rejects.toThrow('binary')
    })

    it('rejects a binary file on str_replace', async () => {
      const filePath = path.join(testDir, 'binary.bin')
      await fs.writeFile(filePath, Buffer.from([0x48, 0x45, 0x41, 0x44, 0x00, 0x54, 0x41, 0x49, 0x4c]))
      await expect(
        fileEditor.invoke({ command: 'str_replace', path: filePath, old_str: 'HEAD', new_str: 'X' }, context)
      ).rejects.toThrow('binary')
    })

    it('rejects a UTF-16 file as unsupported encoding, not as binary', async () => {
      const filePath = path.join(testDir, 'utf16.txt')
      const bom = Buffer.from([0xff, 0xfe])
      const body = Buffer.from('hello world', 'utf16le')
      await fs.writeFile(filePath, Buffer.concat([bom, body]))
      await expect(fileEditor.invoke({ command: 'view', path: filePath }, context)).rejects.toThrow('UTF-16')
    })
  })

  describe('write-side size caps', () => {
    it('rejects a create whose file_text exceeds maxFileSize', async () => {
      const editor = makeFileEditor({ maxFileSize: 1024 })
      const filePath = path.join(testDir, 'big-create.txt')
      await expect(
        editor.invoke({ command: 'create', path: filePath, file_text: 'x'.repeat(2048) }, context)
      ).rejects.toThrow('exceeds maximum allowed size')
    })

    it('rejects a str_replace whose new_str exceeds maxFileSize', async () => {
      const editor = makeFileEditor({ maxFileSize: 1024 })
      const filePath = await createTestFile('small.txt', 'small')
      await expect(
        editor.invoke({ command: 'str_replace', path: filePath, old_str: 'small', new_str: 'y'.repeat(2048) }, context)
      ).rejects.toThrow('exceeds maximum allowed size')
    })

    it('rejects a str_replace whose result expands past the cap', async () => {
      // Cap is 32 bytes. Original is 20 bytes. `replace_all` on 'x' -> 'XXX'
      // produces 60 bytes, past the cap even though every individual new_str
      // fits.
      const editor = makeFileEditor({ maxFileSize: 32 })
      const filePath = await createTestFile('grow.txt', 'x'.repeat(20))
      await expect(
        editor.invoke(
          { command: 'str_replace', path: filePath, old_str: 'x', new_str: 'XXX', replace_all: true },
          context
        )
      ).rejects.toThrow('exceeding the maximum')
    })

    it('rejects an insert whose result expands past the cap', async () => {
      const editor = makeFileEditor({ maxFileSize: 32 })
      const filePath = await createTestFile('grow.txt', 'x'.repeat(30))
      await expect(
        editor.invoke({ command: 'insert', path: filePath, insert_line: 0, new_str: 'y'.repeat(10) }, context)
      ).rejects.toThrow('exceeding the maximum')
    })

    it('preflights str_replace output before allocation', async () => {
      // Guards #3235: replace_all must reject an oversized projected output
      // by byte-count arithmetic, before V8 allocates the substituted string.
      const editor = makeFileEditor({ maxFileSize: 4 * 1024 })
      const filePath = await createTestFile('small.txt', 'a'.repeat(1000))
      await expect(
        editor.invoke(
          { command: 'str_replace', path: filePath, old_str: 'a', new_str: 'x'.repeat(100), replace_all: true },
          context
        )
      ).rejects.toThrow('exceeding the maximum')
    })
  })

  describe('empty input rejection', () => {
    it('rejects an empty old_str on str_replace', async () => {
      // `"".count("")` returns len + 1; without an explicit guard the caller
      // would see a confusing "multiple occurrences" error or, with replace_all,
      // new_str inserted between every character.
      const filePath = await createTestFile('empty-old.txt', 'hello\n')
      await expect(
        fileEditor.invoke({ command: 'str_replace', path: filePath, old_str: '', new_str: 'X' }, context)
      ).rejects.toThrow('must not be empty')
    })
  })

  describe('missing root', () => {
    it('rejects on first use when root does not exist in the sandbox', async () => {
      const missingRoot = '/workspace-does-not-exist-anywhere'
      const editor = makeFileEditor({ root: missingRoot })
      await expect(editor.invoke({ command: 'view', path: `${missingRoot}/foo.txt` }, context)).rejects.toThrow(
        'does not exist in the sandbox'
      )
    })
  })

  describe('undo LRU eviction', () => {
    it('evicts the oldest entry when maxUndoEntries is exceeded', async () => {
      const editor = makeFileEditor({ maxUndoEntries: 2 })
      const paths: string[] = []
      for (let i = 0; i < 3; i++) {
        const p = await createTestFile(`f${i}.txt`, `orig${i}`)
        paths.push(p)
        await editor.invoke({ command: 'str_replace', path: p, old_str: `orig${i}`, new_str: `new${i}` }, context)
      }
      // Oldest (f0) has been evicted.
      await expect(editor.invoke({ command: 'undo_edit', path: paths[0]! }, context)).rejects.toThrow('No undo history')
      // Second-oldest still restores.
      await editor.invoke({ command: 'undo_edit', path: paths[1]! }, context)
      expect(await fs.readFile(paths[1]!, 'utf-8')).toBe('orig1')
    })

    it('evicts past the byte cap', async () => {
      // Byte cap sized to fit one snapshot but not two, so a second edit forces the oldest out.
      const snapshot = 'x'.repeat(100)
      const editor = makeFileEditor({ maxUndoBytes: snapshot.length + 20 })
      const p1 = await createTestFile('big1.txt', snapshot)
      const p2 = await createTestFile('big2.txt', 'y'.repeat(100))
      await editor.invoke({ command: 'str_replace', path: p1, old_str: 'x', new_str: 'X', replace_all: true }, context)
      await editor.invoke({ command: 'str_replace', path: p2, old_str: 'y', new_str: 'Y', replace_all: true }, context)
      await expect(editor.invoke({ command: 'undo_edit', path: p1 }, context)).rejects.toThrow('No undo history')
      await editor.invoke({ command: 'undo_edit', path: p2 }, context)
      expect(await fs.readFile(p2, 'utf-8')).toBe('y'.repeat(100))
    })
  })

  describe('str_replace replace_all opt-in', () => {
    it('rejects an ambiguous match without replace_all', async () => {
      const filePath = await createTestFile('dup.txt', 'DUP\nfoo\nDUP\nbar\nDUP\n')
      await expect(
        fileEditor.invoke({ command: 'str_replace', path: filePath, old_str: 'DUP', new_str: 'X' }, context)
      ).rejects.toThrow('replace_all')
    })

    it('replaces every occurrence when replace_all is true', async () => {
      const filePath = await createTestFile('dup.txt', 'DUP\nfoo\nDUP\nbar\nDUP\n')
      const result = await fileEditor.invoke(
        { command: 'str_replace', path: filePath, old_str: 'DUP', new_str: 'X', replace_all: true },
        context
      )
      expect(result).toContain('3 occurrences replaced')
      expect(await fs.readFile(filePath, 'utf-8')).toBe('X\nfoo\nX\nbar\nX\n')
    })
  })

  describe('find_line command', () => {
    it('returns every match and a snippet around the first one', async () => {
      const filePath = await createTestFile('test.txt', 'alpha\nbeta\ngamma\nbeta again\n')
      const result = await fileEditor.invoke({ command: 'find_line', path: filePath, search_text: 'beta' }, context)
      expect(result).toContain('[2,4]')
      expect(result).toContain('gamma')
    })

    it('returns an empty report when nothing matches', async () => {
      const filePath = await createTestFile('test.txt', 'alpha\n')
      const result = await fileEditor.invoke({ command: 'find_line', path: filePath, search_text: 'MISSING' }, context)
      expect(result).toContain('No matches')
      expect(result).toContain('MISSING')
    })

    it('matches across whitespace when fuzzy is true', async () => {
      const filePath = await createTestFile('test.txt', 'def   my_function ( ):\n    pass\n')
      const result = await fileEditor.invoke(
        { command: 'find_line', path: filePath, search_text: 'def my_function', fuzzy: true },
        context
      )
      expect(result).toContain('[1]')
    })

    it('truncates when hits exceed the cap', async () => {
      const filePath = await createTestFile('many.txt', 'hit line\n'.repeat(300))
      const result = await fileEditor.invoke({ command: 'find_line', path: filePath, search_text: 'hit' }, context)
      expect(result).toContain('truncated')
    })

    it('fuzzy search is linear on pathological input', async () => {
      // Regression: an earlier implementation joined escaped tokens with a
      // regex `.*` chain, which backtracks catastrophically on a long single
      // line and blocks the event loop (see #3394). Wrap in Promise.race
      // against a 2s timer to fail loudly if that behavior returns.
      const filePath = await createTestFile('long.txt', `${'a'.repeat(500)}\n`)
      const search = fileEditor.invoke(
        { command: 'find_line', path: filePath, search_text: 'a a a b', fuzzy: true },
        context
      )
      const bounded = Promise.race([
        search,
        new Promise<never>((_, reject) =>
          globalThis.setTimeout(() => reject(new Error('fuzzy search timed out')), 2000)
        ),
      ])
      const result = await bounded
      expect(result).toContain('No matches')
    })
  })

  describe('undo_edit command', () => {
    it('reverts a str_replace edit', async () => {
      const editor = makeFileEditor()
      const filePath = await createTestFile('test.txt', 'hello\n')
      await editor.invoke({ command: 'str_replace', path: filePath, old_str: 'hello', new_str: 'goodbye' }, context)
      expect(await fs.readFile(filePath, 'utf-8')).toBe('goodbye\n')
      await editor.invoke({ command: 'undo_edit', path: filePath }, context)
      expect(await fs.readFile(filePath, 'utf-8')).toBe('hello\n')
    })

    it('reverts an insert edit', async () => {
      const editor = makeFileEditor()
      const filePath = await createTestFile('test.txt', 'one\ntwo\n')
      await editor.invoke({ command: 'insert', path: filePath, insert_line: 1, new_str: 'between' }, context)
      await editor.invoke({ command: 'undo_edit', path: filePath }, context)
      expect(await fs.readFile(filePath, 'utf-8')).toBe('one\ntwo\n')
    })

    it('throws when no history exists', async () => {
      const filePath = await createTestFile('test.txt', 'content\n')
      await expect(fileEditor.invoke({ command: 'undo_edit', path: filePath }, context)).rejects.toThrow(
        'No undo history'
      )
    })

    it('survives across an agent.appState roundtrip', async () => {
      // Undo history lives in agent.appState so a session manager can persist
      // it. Simulate a rehydrated agent by copying the first agent's
      // serialized state into a fresh one and confirm undo still restores the
      // pre-edit content.
      const filePath = await createTestFile('test.txt', 'original\n')
      const editor = makeFileEditor()

      const firstAgent = createMockAgent()
      const firstContext: ToolContext = {
        toolUse: { name: 'fileEditor', toolUseId: 'first', input: {} },
        agent: firstAgent,
        invocationState: {},
        interrupt: () => {
          throw new Error('interrupt not available in mock context')
        },
        cancelSignal: new AbortController().signal,
      }
      await editor.invoke(
        { command: 'str_replace', path: filePath, old_str: 'original', new_str: 'edited' },
        firstContext
      )
      const serialized = firstAgent.appState.getAll()
      expect(Object.keys(serialized).length).toBeGreaterThan(0)

      const rehydrated = createMockAgent({ appState: serialized })
      const rehydratedContext: ToolContext = {
        toolUse: { name: 'fileEditor', toolUseId: 'second', input: {} },
        agent: rehydrated,
        invocationState: {},
        interrupt: () => {
          throw new Error('interrupt not available in mock context')
        },
        cancelSignal: new AbortController().signal,
      }
      await editor.invoke({ command: 'undo_edit', path: filePath }, rehydratedContext)
      expect(await fs.readFile(filePath, 'utf-8')).toBe('original\n')
    })

    it('scopes history per calling agent within one editor instance', async () => {
      // Guards #3235: two agents sharing one editor factory must not see each
      // other's undo history, so agent B cannot restore agent A's snapshot
      // over B's file.
      const fileA = await createTestFile('a.txt', 'A-original\n')
      const fileB = await createTestFile('b.txt', 'B-original\n')
      const shared = makeFileEditor()

      const agentA = createMockAgent()
      const agentB = createMockAgent()
      const contextA: ToolContext = {
        toolUse: { name: 'fileEditor', toolUseId: 'a', input: {} },
        agent: agentA,
        invocationState: {},
        interrupt: () => {
          throw new Error('interrupt not available in mock context')
        },
        cancelSignal: new AbortController().signal,
      }
      const contextB: ToolContext = {
        toolUse: { name: 'fileEditor', toolUseId: 'b', input: {} },
        agent: agentB,
        invocationState: {},
        interrupt: () => {
          throw new Error('interrupt not available in mock context')
        },
        cancelSignal: new AbortController().signal,
      }

      await shared.invoke(
        { command: 'str_replace', path: fileA, old_str: 'A-original', new_str: 'A-changed' },
        contextA
      )
      await shared.invoke(
        { command: 'str_replace', path: fileB, old_str: 'B-original', new_str: 'B-changed' },
        contextB
      )

      await expect(shared.invoke({ command: 'undo_edit', path: fileA }, contextB)).rejects.toThrow('No undo history')
      await shared.invoke({ command: 'undo_edit', path: fileB }, contextB)
      expect(await fs.readFile(fileA, 'utf-8')).toBe('A-changed\n')
      expect(await fs.readFile(fileB, 'utf-8')).toBe('B-original\n')
    })

    it('does not overwrite a valid snapshot when a subsequent write fails', async () => {
      // Guards #3235: a write failure must not shadow the still-valid earlier
      // snapshot. undo_edit after a failed edit restores what was on disk
      // before the last successful write, not the current-but-unwritten content.
      const editor = makeFileEditor()
      const filePath = await createTestFile('test.txt', 'original\n')

      await editor.invoke({ command: 'str_replace', path: filePath, old_str: 'original', new_str: 'first' }, context)
      expect(await fs.readFile(filePath, 'utf-8')).toBe('first\n')

      // Make the file read-only so the next write fails; restore afterwards.
      await fs.chmod(filePath, 0o444)
      await expect(
        editor.invoke({ command: 'str_replace', path: filePath, old_str: 'first', new_str: 'second' }, context)
      ).rejects.toThrow()
      await fs.chmod(filePath, 0o644)

      // Original snapshot survived; the failed second edit did not shadow it.
      await editor.invoke({ command: 'undo_edit', path: filePath }, context)
      expect(await fs.readFile(filePath, 'utf-8')).toBe('original\n')
    })

    it('keeps the undo entry when a restoring write fails so it can be retried', async () => {
      // Guards #3235: a failed undo write must keep the entry in history so
      // the caller can retry.
      const editor = makeFileEditor()
      const filePath = await createTestFile('test.txt', 'original\n')

      await editor.invoke({ command: 'str_replace', path: filePath, old_str: 'original', new_str: 'edited' }, context)
      expect(await fs.readFile(filePath, 'utf-8')).toBe('edited\n')

      await fs.chmod(filePath, 0o444)
      await expect(editor.invoke({ command: 'undo_edit', path: filePath }, context)).rejects.toThrow()
      await fs.chmod(filePath, 0o644)

      await editor.invoke({ command: 'undo_edit', path: filePath }, context)
      expect(await fs.readFile(filePath, 'utf-8')).toBe('original\n')
    })
  })

  describe('root confinement', () => {
    it('rejects an absolute path outside the configured root', async () => {
      const rootDir = path.join(testDir, 'workspace')
      const outside = path.join(testDir, 'outside.txt')
      await fs.mkdir(rootDir)
      await fs.writeFile(outside, 'secret')
      const confined = makeFileEditor({ root: rootDir })
      await expect(confined.invoke({ command: 'view', path: outside }, context)).rejects.toThrow(
        'outside the configured root'
      )
    })

    it('rejects a `..` traversal that escapes root after normalization', async () => {
      const rootDir = path.join(testDir, 'workspace')
      await fs.mkdir(rootDir)
      const confined = makeFileEditor({ root: rootDir })
      await expect(confined.invoke({ command: 'view', path: `${rootDir}/../outside.txt` }, context)).rejects.toThrow(
        'outside the configured root'
      )
    })

    it('rejects a sibling that shares the root prefix', async () => {
      const rootDir = path.join(testDir, 'ws')
      const sibling = path.join(testDir, 'ws-neighbor')
      await fs.mkdir(rootDir)
      await fs.mkdir(sibling)
      await fs.writeFile(path.join(sibling, 'file.txt'), 'content')
      const confined = makeFileEditor({ root: rootDir })
      await expect(confined.invoke({ command: 'view', path: path.join(sibling, 'file.txt') }, context)).rejects.toThrow(
        'outside the configured root'
      )
    })

    it('allows a path inside the root', async () => {
      const rootDir = path.join(testDir, 'workspace')
      await fs.mkdir(rootDir)
      const target = path.join(rootDir, 'ok.txt')
      await fs.writeFile(target, 'hello')
      const confined = makeFileEditor({ root: rootDir })
      const result = await confined.invoke({ command: 'view', path: target }, context)
      expect(result).toContain('hello')
    })

    it('throws at construction if root is not absolute', () => {
      expect(() => makeFileEditor({ root: 'relative/root' })).toThrow('absolute path')
    })

    it('defers symlink semantics to the sandbox', async () => {
      // The editor enforces lexical confinement only: whether a symlink inside
      // root resolves outside root is a sandbox concern. NotASandbox has no
      // isolation and follows the link; a real isolating sandbox would confine
      // resolution to its own filesystem.
      const rootDir = path.join(testDir, 'workspace')
      await fs.mkdir(rootDir)
      const secret = path.join(testDir, 'secret.txt')
      await fs.writeFile(secret, 'top secret')
      const link = path.join(rootDir, 'escape.txt')
      await fs.symlink(secret, link)
      const confined = makeFileEditor({ root: rootDir })
      const result = await confined.invoke({ command: 'view', path: link }, context)
      expect(result).toContain('top secret')
    })

    it('allows a symlink inside root that points to a file also inside root', async () => {
      const rootDir = path.join(testDir, 'workspace')
      await fs.mkdir(rootDir)
      const target = path.join(rootDir, 'real.txt')
      await fs.writeFile(target, 'inside content')
      const link = path.join(rootDir, 'alias.txt')
      await fs.symlink(target, link)
      const confined = makeFileEditor({ root: rootDir })
      const result = await confined.invoke({ command: 'view', path: link }, context)
      expect(result).toContain('inside content')
    })

    it.skipIf(process.platform === 'win32')('allows a path when root is the filesystem root', async () => {
      // POSIX-only: stripTrailingSep preserves `/`, so a naive `r + sep` check
      // would produce `//` and reject every valid in-root path. Guard against
      // regressing that edge case. Windows treats each drive letter as its
      // own root; the analogous case there (`root: 'C:\\'`) is covered by the
      // trailing-separator branch in isInsideRoot the same way.
      const filePath = await createTestFile('at-fs-root.txt', 'content')
      const confined = makeFileEditor({ root: '/' })
      const result = await confined.invoke({ command: 'view', path: filePath }, context)
      expect(result).toContain('content')
    })
  })

  describe('edge cases', () => {
    it('handles files with special characters in content', async () => {
      const content = 'Special chars: @#$%^&*()_+-={}[]|:;"<>,.?/~`'
      const filePath = await createTestFile('special.txt', content)
      const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
      expect(result).toContain('Special chars:')
    })

    it('handles files with unicode characters', async () => {
      const content = '你好世界\n🚀 Emoji test\nΣ Greek letters'
      const filePath = await createTestFile('unicode.txt', content)
      const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
      expect(result).toContain('你好世界')
      expect(result).toContain('🚀')
    })

    it('handles files with tabs (expands tabs)', async () => {
      const content = 'Line 1\tTab\tSeparated'
      const filePath = await createTestFile('tabs.txt', content)
      const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
      // Tabs should be expanded to spaces
      expect(result).not.toContain('\t')
    })
  })
})

describe.skipIf(process.platform === 'win32')('fileEditor tool (sandbox path)', () => {
  let testDir: string
  let context: ToolContext

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), 'file-editor-sandbox-test-'))
    const sandbox = new TestSandbox(testDir)
    const agent = createMockAgent({ extra: { sandbox } as any })
    context = {
      toolUse: { name: 'fileEditor', toolUseId: 'test-id', input: {} },
      agent,
      invocationState: {},
      cancelSignal: agent.cancelSignal,
      interrupt: () => {
        throw new Error('interrupt not available in mock context')
      },
    }
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it('views a file through the sandbox', async () => {
    const filePath = path.join(testDir, 'hello.txt')
    await fs.writeFile(filePath, 'line 1\nline 2\n')
    const result = await fileEditor.invoke({ command: 'view', path: filePath }, context)
    expect(result).toContain('line 1')
    expect(result).toContain('line 2')
  })

  it('creates a file through the sandbox', async () => {
    const filePath = path.join(testDir, 'new.txt')
    await fileEditor.invoke({ command: 'create', path: filePath, file_text: 'created' }, context)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('created')
  })

  it('performs str_replace through the sandbox', async () => {
    const filePath = path.join(testDir, 'edit.txt')
    await fs.writeFile(filePath, 'hello world')
    await fileEditor.invoke({ command: 'str_replace', path: filePath, old_str: 'world', new_str: 'sandbox' }, context)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('hello sandbox')
  })

  it('inserts a line through the sandbox', async () => {
    const filePath = path.join(testDir, 'insert.txt')
    await fs.writeFile(filePath, 'line 1\nline 3\n')
    await fileEditor.invoke({ command: 'insert', path: filePath, insert_line: 1, new_str: 'line 2' }, context)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('line 1\nline 2\nline 3\n')
  })

  it('reports non-existent path', async () => {
    const filePath = path.join(testDir, 'nope.txt')
    await expect(fileEditor.invoke({ command: 'view', path: filePath }, context)).rejects.toThrow('does not exist')
  })

  it('propagates non-not-found listFiles errors instead of reporting non-existence', async () => {
    const sandbox = new TestSandbox(testDir)
    sandbox.listFiles = async () => {
      throw new Error('EACCES: permission denied')
    }
    const agent = createMockAgent({ extra: { sandbox } as any })
    const errContext: ToolContext = {
      toolUse: { name: 'fileEditor', toolUseId: 'test-id', input: {} },
      agent,
      invocationState: {},
      cancelSignal: agent.cancelSignal,
      interrupt: () => {
        throw new Error('interrupt not available in mock context')
      },
    }
    const promise = fileEditor.invoke({ command: 'view', path: path.join(testDir, 'x.txt') }, errContext)
    await expect(promise).rejects.toThrow('permission denied')
  })

  it('detects directory via sandbox listFiles', async () => {
    const dirPath = path.join(testDir, 'subdir')
    await fs.mkdir(dirPath)
    await fs.writeFile(path.join(dirPath, 'a.txt'), 'a')
    const result = await fileEditor.invoke({ command: 'view', path: dirPath }, context)
    expect(result).toContain('a.txt')
  })

  it('handles trailing slash on file path', async () => {
    const filePath = path.join(testDir, 'trailing.txt')
    await fs.writeFile(filePath, 'content here')
    const result = await fileEditor.invoke({ command: 'view', path: `${filePath}/` }, context)
    expect(result).toContain('content here')
  })
})
