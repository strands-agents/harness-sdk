import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { defineHarnessAgentConfig } from '@strands-agents/harness'
import { describe, expect, it } from 'vitest'

import { writeAgentProject } from '../../src/tui/project/export.js'
import { E2E_CASE } from './catalog.js'

// Requires AWS credentials and a built CLI; runs separately via npm run test:integ.
const run = promisify(execFile)
const BIN = join(process.cwd(), 'dist/src/main.js')
const INTEG_MODEL = process.env.STRANDS_INTEG_MODEL ?? 'bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0'

describe('strands CLI e2e', () => {
  it(E2E_CASE.exportedAgent.testName, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'strands-cli-export-integ-'))
    const home = mkdtempSync(join(tmpdir(), 'strands-cli-export-home-'))
    try {
      const archive = join(cwd, 'agent.zip')
      await writeAgentProject(
        defineHarnessAgentConfig({
          name: 'Live exported agent',
          model: INTEG_MODEL,
          effort: 'off',
          builtinTools: [],
          builtinPlugins: [],
          caching: false,
          contextManager: false,
          skills: false,
          memory: false,
          session: false,
        }),
        'typescript',
        [],
        archive,
        cwd
      )
      const result = await run(
        'node',
        [BIN, '--agent', archive, '--print', 'Reply with exactly: LIVE_EXPORTED_AGENT_OK'],
        { cwd, timeout: 180_000, env: { ...process.env, HOME: home } }
      )
      expect(`${result.stdout}\n${result.stderr}`).toContain('LIVE_EXPORTED_AGENT_OK')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it(E2E_CASE.toolTurn.testName, async () => {
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
