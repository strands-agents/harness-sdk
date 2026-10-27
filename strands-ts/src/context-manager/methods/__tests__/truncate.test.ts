import { describe, it, expect } from 'vitest'
import { truncateToolResultBlock } from '../truncate.js'
import { TextBlock, ToolResultBlock } from '../../../types/messages.js'

const BIG = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n')

describe('truncateToolResultBlock with split (#4741)', () => {
  it('previews the parent with a marker, then the field lines', () => {
    const content = [new TextBlock(JSON.stringify({ output: BIG, error: '', exit_code: 0 }))]
    const block = new ToolResultBlock({ toolUseId: 'tu', status: 'success', content })
    const preview = (truncateToolResultBlock(block, { previewTokens: 100 }, true).content[0] as TextBlock).text
    expect(
      preview.startsWith(
        '[Truncated: 1 block, ~4,752 tokens]\n\n' +
          '{"output":"[ref: fields/tu_0/output (2,000 lines, 18,892 chars)]","error":"","exit_code":0}\n' +
          '[fields/tu_0/output]\nline 1\nline 2\n'
      )
    ).toBe(true)
    expect(preview.endsWith('\nline 1999\nline 2000')).toBe(true)
    expect(preview).not.toContain('\\n')
  })

  it('previews the serialized text when not splitting', () => {
    const content = [new TextBlock(JSON.stringify({ output: BIG, error: '', exit_code: 0 }))]
    const block = new ToolResultBlock({ toolUseId: 'tu', status: 'success', content })
    const preview = (truncateToolResultBlock(block, { previewTokens: 100 }).content[0] as TextBlock).text
    expect(preview).not.toContain('fields/')
    expect(preview).toContain('{"output":"line 1\\nline 2')
  })

  it('puts all block markers before the field bodies', () => {
    const block = new ToolResultBlock({
      toolUseId: 'tu',
      status: 'success',
      content: [new TextBlock(BIG), new TextBlock(BIG)],
    })
    const preview = (truncateToolResultBlock(block, { previewTokens: 100 }, true).content[0] as TextBlock).text
    expect(
      preview.startsWith(
        '[Truncated: 2 blocks, ~9,482 tokens]\n\n' +
          '[ref: fields/tu_0/text (2,000 lines, 18,892 chars)]\n' +
          '[ref: fields/tu_1/text (2,000 lines, 18,892 chars)]\n' +
          '[fields/tu_0/text]\nline 1\n'
      )
    ).toBe(true)
  })
})
