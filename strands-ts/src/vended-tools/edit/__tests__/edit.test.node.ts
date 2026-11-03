import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { edit, makeEdit, DEFAULT_EDIT_DESCRIPTION } from '../index.js'
import type { ToolContext } from '../../../index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { Sandbox } from '../../../sandbox/base.js'
import { NotASandboxLocalEnvironment } from '../../../sandbox/not-a-sandbox-local-environment.js'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'

const POSIX_ONLY = process.platform !== 'win32'

// Errors surface as rejections from `invoke`; the error→status wrapping only
// happens through the tool's `stream` path.
describe('edit tool', () => {
  let testDir: string
  let context: ToolContext

  const createContext = (agent = createMockAgent()): ToolContext => ({
    toolUse: { name: 'edit', toolUseId: 'test-id', input: {} },
    agent,
    invocationState: {},
    cancelSignal: agent.cancelSignal,
    interrupt: () => {
      throw new Error('interrupt not available in mock context')
    },
  })

  const writeFile = async (content: string): Promise<string> => {
    const filePath = path.join(testDir, 'f.txt')
    await fs.writeFile(filePath, content, 'utf-8')
    return filePath
  }

  const readFile = (filePath: string): Promise<string> => fs.readFile(filePath, 'utf-8')

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'edit-test-'))
    context = createContext()
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true })
  })

  describe.skipIf(!POSIX_ONLY)('str replace', () => {
    const editTool = makeEdit(new NotASandboxLocalEnvironment())

    it('replaces a unique match', async () => {
      const filePath = await writeFile('alpha\nbeta\ngamma')
      const result = await editTool.invoke({ path: filePath, old_str: 'beta', new_str: 'BETA' }, context)
      expect(result).toBe(`Edited ${filePath}.`)
      expect(await readFile(filePath)).toBe('alpha\nBETA\ngamma')
    })

    it('rejects an empty old_str', async () => {
      // An empty old_str would otherwise match at every character boundary
      // and surface as a confusing "appears N times" error. Reject up front.
      const filePath = await writeFile('alpha')
      await expect(editTool.invoke({ path: filePath, old_str: '', new_str: 'x' }, context)).rejects.toThrow(
        'old_str must not be empty'
      )
    })

    it('rejects a missing match', async () => {
      const filePath = await writeFile('alpha\nbeta')
      await expect(editTool.invoke({ path: filePath, old_str: 'zeta', new_str: 'x' }, context)).rejects.toThrow(
        'did not appear verbatim'
      )
    })

    it('rejects an ambiguous match and leaves the file untouched', async () => {
      const filePath = await writeFile('foo\nfoo\nfoo')
      await expect(editTool.invoke({ path: filePath, old_str: 'foo', new_str: 'bar' }, context)).rejects.toThrow(
        'appears 3 times'
      )
      expect(await readFile(filePath)).toBe('foo\nfoo\nfoo')
    })

    it('deletes the match when new_str is empty', async () => {
      const filePath = await writeFile('keep\nremove-me\nkeep')
      await editTool.invoke({ path: filePath, old_str: 'remove-me\n', new_str: '' }, context)
      expect(await readFile(filePath)).toBe('keep\nkeep')
    })

    it('replaces a multiline old_str', async () => {
      const filePath = await writeFile('a\nb\nc\nd')
      await editTool.invoke({ path: filePath, old_str: 'b\nc', new_str: 'B\nC\nC2' }, context)
      expect(await readFile(filePath)).toBe('a\nB\nC\nC2\nd')
    })

    it('inserts replacement patterns in new_str literally', async () => {
      const filePath = await writeFile('x = 1')
      await editTool.invoke({ path: filePath, old_str: '1', new_str: '$& $1 $$' }, context)
      expect(await readFile(filePath)).toBe('x = $& $1 $$')
    })

    it('matches a multiline LF old_str in a CRLF file and writes CRLF back', async () => {
      // Models write `\n`; the file's CRLF endings must still match, and the
      // replacement must come back with CRLF too.
      const filePath = await writeFile('a\r\nb\r\nc\r\n')
      await editTool.invoke({ path: filePath, old_str: 'a\nb', new_str: 'x\ny' }, context)
      expect(await readFile(filePath)).toBe('x\r\ny\r\nc\r\n')
    })

    it('matches a CRLF old_str in a CRLF file', async () => {
      const filePath = await writeFile('a\r\nb\r\nc\r\n')
      await editTool.invoke({ path: filePath, old_str: 'a\r\nb', new_str: 'x\r\ny' }, context)
      expect(await readFile(filePath)).toBe('x\r\ny\r\nc\r\n')
    })

    it('keeps a CRLF file intact on a single-line edit', async () => {
      const filePath = await writeFile('a\r\nb\r\nc\r\n')
      await editTool.invoke({ path: filePath, old_str: 'b', new_str: 'x\ny' }, context)
      expect(await readFile(filePath)).toBe('a\r\nx\r\ny\r\nc\r\n')
    })

    it('does not rewrite an LF file when old_str uses CRLF', async () => {
      const filePath = await writeFile('a\nb\nc\n')
      await editTool.invoke({ path: filePath, old_str: 'a\r\nb', new_str: 'x\r\ny' }, context)
      expect(await readFile(filePath)).toBe('x\ny\nc\n')
    })

    it('prefers the verbatim match in a file with mixed line endings', async () => {
      const filePath = await writeFile('foo\nbar\n---\nfoo\r\nbar\n')
      await editTool.invoke({ path: filePath, old_str: 'foo\nbar', new_str: 'X' }, context)
      expect(await readFile(filePath)).toBe('X\n---\nfoo\r\nbar\n')
    })

    it('uses the dominant line ending for a single-line edit', async () => {
      // One stray CRLF must not turn a mostly-LF file's new lines into CRLF.
      const filePath = await writeFile('a\nb\nc\r\nd\n')
      await editTool.invoke({ path: filePath, old_str: 'b', new_str: 'x\ny' }, context)
      expect(await readFile(filePath)).toBe('a\nx\ny\nc\r\nd\n')
    })

    it('handles a large multiline old_str in a CRLF file', async () => {
      const lines = [...Array.from({ length: 5000 }, (_, i) => `line ${i}`), 'x'.repeat(40_000)]
      const filePath = await writeFile('head\r\n' + lines.join('\r\n') + '\r\n')
      await editTool.invoke({ path: filePath, old_str: lines.join('\n'), new_str: 'body' }, context)
      expect(await readFile(filePath)).toBe('head\r\nbody\r\n')
    })
  })

  // The validator's full semantics are covered in `../../__tests__/paths.test.ts`;
  // this confirms the delegation: a rejected path throws before any sandbox call.
  describe('path validation', () => {
    it('rejects a relative path', async () => {
      await expect(edit.invoke({ path: 'relative.txt', old_str: 'a', new_str: 'b' }, context)).rejects.toThrow(
        'not absolute'
      )
    })
  })

  describe('options', () => {
    it('defaults to the edit name and description', () => {
      expect(edit.name).toBe('edit')
      expect(edit.description).toBe(DEFAULT_EDIT_DESCRIPTION)
    })

    it('applies name and description overrides without a sandbox', () => {
      const custom = makeEdit({ name: 'my_edit', description: 'Custom edit.' })
      expect(custom.name).toBe('my_edit')
      expect(custom.description).toBe('Custom edit.')
    })

    it('applies overrides when a sandbox is bound', () => {
      const custom = makeEdit(new NotASandboxLocalEnvironment(), { name: 'sandbox_edit' })
      expect(custom.name).toBe('sandbox_edit')
      expect(custom.description).toBe(DEFAULT_EDIT_DESCRIPTION)
    })
  })

  describe.skipIf(!POSIX_ONLY)('sandbox binding', () => {
    it('uses the bound sandbox over the agent sandbox', async () => {
      const boundTool = makeEdit(new NotASandboxLocalEnvironment())
      const explodingSandbox = {
        readText: async () => {
          throw new Error('agent sandbox used despite bound sandbox')
        },
        writeText: async () => {
          throw new Error('agent sandbox used despite bound sandbox')
        },
      }
      const agent = createMockAgent({ extra: { sandbox: explodingSandbox as unknown as Sandbox } })

      const filePath = await writeFile('x')
      await boundTool.invoke({ path: filePath, old_str: 'x', new_str: 'y' }, createContext(agent))
      expect(await readFile(filePath)).toBe('y')
    })

    it('default edit reads the agent sandbox', async () => {
      const filePath = await writeFile('hello')
      await edit.invoke({ path: filePath, old_str: 'hello', new_str: 'world' }, context)
      expect(await readFile(filePath)).toBe('world')
    })
  })
})
