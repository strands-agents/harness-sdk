import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildAgent, toolAttempted, toolResultContains, toolSucceeded } from './harness.js'

// The agent's sandbox resolves file/shell ops against the process cwd, so each test runs in its own
// temp directory (restored afterward). The integration config runs files serially, so the chdir is safe.
// Prompts tell the agent plainly it's being tested and which tools to use; assertions read the
// conversation to confirm each tool ran (or, for non-tool features, read the answer). The built-in
// tools are exercised in a single turn rather than one live invocation per tool; only features that
// need a differently-configured agent (interventions, sessions, environment) get their own test.
const TESTING = 'You are an automated integration test. Do exactly what is asked and nothing else.'

// For the multi-step tool test: the agent tends to batch parallel tool calls and quietly drop the
// ones that feel trivial (reading a file, say). This is a test whose whole point is that every tool
// fires, so the system prompt spells out that no step may be skipped, merged, or substituted.
const TEST_INSTRUCTIONS =
  'You are running inside an automated integration test whose only purpose is to confirm that every ' +
  'tool works. You MUST complete every numbered step, one at a time and in order. You may NOT skip a ' +
  'step, combine or batch steps into parallel tool calls, or substitute one tool for another (do not ' +
  "use one tool to do another step's job). For each step, call the exact tool it names, wait for the " +
  "result, then move on. Do nothing that isn't asked."

describe('e2e', () => {
  let cwd: string
  let previous: string

  beforeEach(() => {
    previous = process.cwd()
    cwd = mkdtempSync(join(tmpdir(), 'strands-integ-'))
    process.chdir(cwd)
  })

  afterEach(() => {
    process.chdir(previous)
  })

  it('uses the shell tool', async () => {
    // Shell is tested on its own so it isn't in the combined agent below: with shell available the
    // model substitutes it (`cat`/redirect) for the read/write/edit tools, which we want to force.
    const agent = await buildAgent()
    const result = await agent.invoke(`${TESTING} Use the shell tool to run \`echo hi\` and report its output.`)
    expect(toolSucceeded(agent, 'shell')).toBe(true)
    expect(result.toString()).toContain('hi')
  })

  it('uses the file/web tools, the todos plugin, and the subagent in one turn', async () => {
    const dataPath = join(cwd, 'data.txt')
    const outputPath = join(cwd, 'out.txt')
    const editPath = join(cwd, 'edit.txt')
    writeFileSync(dataPath, 'The secret code is 4271.\n')
    writeFileSync(editPath, 'alpha\n')
    // Shell is left out so the file tools are the only way to satisfy the read/write/edit steps.
    const agent = await buildAgent({
      builtinTools: ['read', 'write', 'edit', 'web_fetch', 'subagent'],
      builtinPlugins: ['todos', 'environment'],
      instructions: TEST_INSTRUCTIONS,
    })
    // Ensure everyTurn injection and background delivery are exercised together.
    agent.appState.set('todos', [
      {
        content: 'Track the delegated calculation',
        activeForm: 'Tracking the delegated calculation',
        status: 'in_progress',
      },
    ])
    // Keep both default plugins enabled while explicit paths make file-tool selection independent of
    // whether the model uses the injected environment context to resolve relative names.
    const result = await agent.invoke(
      'This is an automated integration test. There are 6 steps below. You MUST perform every single ' +
        'one, in order, each with its own separate tool call — do not skip any, do not do them in ' +
        'parallel, do not use a different tool than the one named. After all 6, stop.\n' +
        `Step 1 — call the \`read\` tool on ${dataPath}, then tell me the secret code it contains.\n` +
        `Step 2 — call the \`write\` tool to create ${outputPath} whose entire contents are that secret code.\n` +
        `Step 3 — call the \`edit\` tool to replace alpha with omega in ${editPath}.\n` +
        'Step 4 — call the `web_fetch` tool on https://example.com and report its title.\n' +
        'Step 5 — call the `todo_write` tool to record a two-item todo list.\n' +
        'Step 6 — call the `subagent` tool, asking it to compute 111 + 222, and report the result.\n' +
        'That is all 6 steps. Each of the 6 tools must be called exactly once.'
    )
    for (const name of ['read', 'write', 'edit', 'web_fetch', 'todo_write', 'subagent']) {
      expect(toolSucceeded(agent, name), `${name} was not used successfully`).toBe(true)
    }
    // Beyond "the tool ran", assert each tool's effect: read returned the file's contents, the
    // the subagent's delivered answer reached the parent (it runs in the background, so the value
    // lands in the final result, not the immediate tool result), and write/edit landed on disk.
    expect(toolResultContains(agent, 'read', '4271')).toBe(true)
    expect(result.toString()).toContain('333')
    expect(readFileSync(outputPath, 'utf8')).toContain('4271')
    expect(readFileSync(editPath, 'utf8')).toContain('omega')
  })

  it('uses the file/web tools and the subagent in one turn (no todos)', async () => {
    const dataPath = join(cwd, 'data.txt')
    const outputPath = join(cwd, 'out.txt')
    const editPath = join(cwd, 'edit.txt')
    writeFileSync(dataPath, 'The secret code is 4271.\n')
    writeFileSync(editPath, 'alpha\n')
    // The same tools as the combined test above, minus the todos plugin, separately cover the
    // non-injection path. Shell is left out so the file tools are the only way to satisfy these steps.
    const agent = await buildAgent({
      builtinTools: ['read', 'write', 'edit', 'web_fetch', 'subagent'],
      builtinPlugins: ['environment'],
      instructions: TEST_INSTRUCTIONS,
    })
    const result = await agent.invoke(
      'This is an automated integration test. There are 5 steps below. You MUST perform every single ' +
        'one, in order, each with its own separate tool call — do not skip any, do not do them in ' +
        'parallel, do not use a different tool than the one named. After all 5, stop.\n' +
        `Step 1 — call the \`read\` tool on ${dataPath}, then tell me the secret code it contains.\n` +
        `Step 2 — call the \`write\` tool to create ${outputPath} whose entire contents are that secret code.\n` +
        `Step 3 — call the \`edit\` tool to replace alpha with omega in ${editPath}.\n` +
        'Step 4 — call the `web_fetch` tool on https://example.com and report its title.\n' +
        'Step 5 — call the `subagent` tool, asking it to compute 111 + 222, and report the result.\n' +
        'That is all 5 steps. Each of the 5 tools must be called exactly once.'
    )
    for (const name of ['read', 'write', 'edit', 'web_fetch', 'subagent']) {
      expect(toolSucceeded(agent, name), `${name} was not used successfully`).toBe(true)
    }
    // read fed write, and the subagent's delivered answer reached the parent (background-run, so it
    // lands in the final result), with write/edit on disk carrying the read value through.
    expect(toolResultContains(agent, 'read', '4271')).toBe(true)
    expect(result.toString()).toContain('333')
    expect(readFileSync(outputPath, 'utf8')).toContain('4271')
    expect(readFileSync(editPath, 'utf8')).toContain('omega')
  })

  it('uses the todo_write tool from the todos plugin', async () => {
    const agent = await buildAgent({ builtinPlugins: ['todos'] })
    await agent.invoke(`${TESTING} Use the todo_write tool to record a two-item todo list.`)
    expect(toolSucceeded(agent, 'todo_write')).toBe(true)
  })

  it('injects the environment context (project AGENTS.md)', async () => {
    // With no tools, the only way the agent can know this marker is the environment plugin injecting
    // the working directory's AGENTS.md into the turn.
    writeFileSync(join(cwd, 'AGENTS.md'), 'Project note: the integration codeword is ZEBRAFISH.\n')
    const agent = await buildAgent({ builtinTools: [], builtinPlugins: ['environment'] })
    const result = await agent.invoke(`${TESTING} What is the integration codeword mentioned in this project?`)
    expect(result.toString()).toContain('ZEBRAFISH')
  })

  it('blocks a denied tool call via interventions', async () => {
    const deny = new HumanInTheLoop({ ask: async () => false })
    const agent = await buildAgent({ interventions: [deny] })
    const blocked = join(cwd, 'blocked.txt')
    await agent.invoke(`${TESTING} Use the write tool to create the file ${blocked} containing: nope.`)
    // The write must be attempted (so we know the gate ran, not that the model skipped it) but denied.
    expect(toolAttempted(agent, 'write')).toBe(true)
    expect(toolSucceeded(agent, 'write')).toBe(false)
    expect(existsSync(blocked)).toBe(false)
  })

  it('allows an approved tool call via interventions', async () => {
    const allow = new HumanInTheLoop({ ask: async () => true })
    const agent = await buildAgent({ interventions: [allow] })
    const allowed = join(cwd, 'allowed.txt')
    await agent.invoke(`${TESTING} Use the write tool to create the file ${allowed} containing: yes.`)
    expect(toolSucceeded(agent, 'write')).toBe(true)
    expect(existsSync(allowed)).toBe(true)
  })

  it('persists sessions across agents', async () => {
    const first = await buildAgent({ session: { id: 'integ-session' } })
    await first.invoke(`${TESTING} Remember this codeword for later: MARMALADE. Just acknowledge.`)
    const second = await buildAgent({ session: { id: 'integ-session' } })
    const result = await second.invoke(`${TESTING} What codeword did I ask you to remember?`)
    expect(result.toString()).toContain('MARMALADE')
  })

  it('persists a session with a minted id', async () => {
    // The default-on behavior: a session with no id mints an 8-hex one and writes its snapshot under
    // sessionDir after a single turn. The snapshot on disk is the deterministic side effect.
    const sessionDir = join(cwd, 'sessions')
    const agent = await buildAgent({ session: { dir: sessionDir } })
    await agent.invoke(`${TESTING} Say hi in one word.`)
    const entries = readdirSync(sessionDir, { recursive: true, withFileTypes: true })
    expect(entries.some((entry) => entry.isFile() && entry.name === 'snapshot_latest.json')).toBe(true)
    const minted = entries.filter((entry) => entry.isDirectory() && /^[0-9a-f]{8}$/.test(entry.name))
    expect(minted).toHaveLength(1)
  })

  it('persists memory across agents (fresh conversation, no session)', async () => {
    // Memory is independent of sessions: a fresh agent with no shared session, only the same memory
    // dir, recalls a durable fact. Extraction runs on a 5-turn interval, so flush() forces the write
    // rather than driving five turns; the .md file on disk is the deterministic side effect.
    const memoryDir = join(cwd, 'memory')
    const first = await buildAgent({ memory: { dir: memoryDir } })
    await first.invoke(`${TESTING} Remember this durable fact about me: my favorite fruit is TANGERINE.`)
    await first.memoryManager?.flush()
    const distilled = readdirSync(memoryDir)
      .filter((file) => file.endsWith('.md'))
      .map((file) => readFileSync(join(memoryDir, file), 'utf8'))
      .join('\n')
    expect(distilled).toContain('TANGERINE')

    const second = await buildAgent({ memory: { dir: memoryDir } })
    const result = await second.invoke(`${TESTING} What is my favorite fruit?`)
    expect(result.toString()).toContain('TANGERINE')
  })
})
