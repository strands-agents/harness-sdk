import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileEditor } from '../file-editor.js'
import type { ToolContext } from '../../../index.js'
import { StateStore } from '../../../state-store.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { TestSandbox } from '../../../__fixtures__/test-sandbox.node.js'
import { promises as fs, mkdtempSync } from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'

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

      it('throws on path traversal with absolute path', async () => {
        await expect(fileEditor.invoke({ command: 'view', path: '/tmp/../etc/passwd' }, context)).rejects.toThrow(
          'path traversal'
        )
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

      it('preserves binary-like content outside the edit', async () => {
        const content = 'normal\n\x00\x01\x02\n\ttabbed\nnormal again\n'
        const filePath = await createTestFile('binary.txt', content)
        await fileEditor.invoke(
          { command: 'str_replace', path: filePath, old_str: 'normal again', new_str: 'done' },
          context
        )
        const updated = await fs.readFile(filePath, 'utf-8')
        expect(updated).toBe('normal\n\x00\x01\x02\n\ttabbed\ndone\n')
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
    it('throws when file exceeds default size limit', async () => {
      // Create a file larger than 1MB
      const largeContent = 'x'.repeat(1048577) // 1MB + 1 byte
      const filePath = await createTestFile('large.txt', largeContent)

      await expect(fileEditor.invoke({ command: 'view', path: filePath }, context)).rejects.toThrow('exceeds')
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
