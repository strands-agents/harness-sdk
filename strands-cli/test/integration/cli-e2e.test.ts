import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

// Requires AWS credentials and a built CLI; runs separately via npm run test:integ.
const run = promisify(execFile)
const BIN = join(process.cwd(), 'dist/src/main.js')
const INTEG_MODEL = process.env.STRANDS_INTEG_MODEL ?? 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0'

describe('strands CLI e2e', () => {
  it('runs a one-shot turn that creates a file via a tool', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'strands-cli-integ-'))
    // Keep ambient MCP servers out of the live agent's tool set.
    const home = mkdtempSync(join(tmpdir(), 'strands-cli-home-'))
    await run(
      'node',
      [
        BIN,
        '-p',
        'Use the shell tool to create a file named out.txt in the current directory containing exactly the text: hello. Do nothing else.',
        '--model',
        INTEG_MODEL,
        '--effort',
        'off',
      ],
      { cwd, timeout: 120_000, env: { ...process.env, HOME: home } }
    )
    const out = join(cwd, 'out.txt')
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, 'utf8')).toContain('hello')
  })
})
