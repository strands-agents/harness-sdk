import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { defineHarnessAgentConfig, type HarnessAgentConfig, type HarnessModuleReference } from '@strands-agents/harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CliConfigStore } from '../../src/tui/config.js'
import { writeAgentProject } from '../../src/tui/project/export.js'
import { resolveSkillPaths } from '../../src/tui/skills.js'
import { sanitizeTerminalText } from '../../src/tui/terminal/sanitize.js'
import { expectRestoredTerminal, runTuiCommand } from '../tui-integration/harness.js'
import { PLATFORM_CASE } from './catalog.js'

const run = promisify(execFile)
const bin = join(process.cwd(), 'dist', 'src', 'main.js')
let root: string
let archive: string
let home: string
let profile: HarnessAgentConfig

describe('cross-platform exported agent E2E', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'strands-platform-integration-'))
    home = join(root, 'home')
    await mkdir(home)
    profile = await createPlatformProfile('https://skills.example.test/SKILL.md')
    archive = await exportProfile(profile, 'platform-agent.zip')
    const config = await CliConfigStore.load(join(home, '.strands', 'cli', 'config.json'))
    await config.saveSetup({
      providers: ['bedrock'],
      profile,
      profileBaseDir: root,
      permissionMode: 'bypassPermissions',
      providerEnvironment: {},
      settings: { animations: false, agentMessaging: false, mcpDiscovery: false, skillDiscovery: false },
    })
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(PLATFORM_CASE.lifecycle.testName, async () => {
    const firstArchive = join(root, 'lifecycle-first.zip')
    const first = await runTuiCommand({
      scenario: 'lifecycle-profile',
      command: [process.execPath, bin],
      cwd: root,
      exportPath: firstArchive,
      env: cliEnvironment(),
      timeout: 40_000,
    })
    const firstOutput = sanitizeTerminalText(first.output)
    expect(first.returnCode).toBe(0)
    expect(firstOutput).toMatch(/LOCAL_SKILL=true.*REMOTE_SKILL=true/u)
    expect(first.exportSaved).toBe(true)
    expectRestoredTerminal(first)

    const secondArchive = join(root, 'lifecycle-second.zip')
    const second = await runTuiCommand({
      scenario: 'lifecycle-project',
      command: [process.execPath, bin, '--agent', firstArchive],
      cwd: root,
      exportPath: secondArchive,
      env: cliEnvironment(),
      timeout: 40_000,
    })
    const secondOutput = sanitizeTerminalText(second.output)
    expect(second.returnCode).toBe(0)
    expect(secondOutput).toContain('platform-mcp-ok')
    expectMcpStopped(secondOutput)
    expect(second.exportSaved).toBe(true)
    expectRestoredTerminal(second)

    const finalOutput = await cliFor(secondArchive, 'invoke the MCP probe after re-import')
    expect(finalOutput).toContain('platform-mcp-ok')
    expectMcpStopped(finalOutput)
  })

  it(PLATFORM_CASE.exportedAgent.testName, async () => {
    const output = await cli('report capabilities')
    expect(output).toContain('HISTORY=report capabilities')
  })

  it(PLATFORM_CASE.skills.testName, async () => {
    const output = await cli('report capabilities')
    expect(output).toMatch(/LOCAL_SKILL=true.*REMOTE_SKILL=true/u)
  })

  it(PLATFORM_CASE.mcp.testName, async () => {
    const output = await cli('invoke the MCP probe')
    expect(output).toContain('platform-mcp-ok')
    expectMcpStopped(output)
  })

  it(PLATFORM_CASE.session.testName, async () => {
    await cli('remember platform-alpha', '--session-id', 'platform-resume')
    const output = await cli('recall platform-beta', '--session-id', 'platform-resume')
    expect(output).toContain('HISTORY=remember platform-alpha|recall platform-beta')
  })
})

async function createPlatformProfile(skillUrl: string): Promise<HarnessAgentConfig> {
  const model = await fixture('platform-integration-model.ts')
  const mcpServer = await fixture('platform-integration-mcp.mjs')
  const localSkill = join(root, 'skills', 'local')
  await mkdir(localSkill, { recursive: true })
  await writeFile(
    join(localSkill, 'SKILL.md'),
    '---\nname: local-platform-skill\ndescription: Local platform integration marker.\n---\nUse local-platform-skill.\n'
  )
  await writeFile(join(root, 'platform-integration-model.ts'), model)
  await writeFile(join(root, 'platform-integration-mcp.mjs'), mcpServer)
  const modelReference: HarnessModuleReference = {
    kind: 'model',
    module: './platform-integration-model.ts',
    export: 'model',
    language: 'typescript',
    files: ['./platform-integration-model.ts'],
  }
  const skills = [skillUrl, './skills']
  return defineHarnessAgentConfig({
    name: 'Platform integration agent',
    model: 'fixture/platform-integration',
    modelModule: modelReference,
    builtinTools: [],
    builtinPlugins: [],
    mcpServers: {
      platform: {
        command: 'node',
        args: ['./platform-integration-mcp.mjs'],
        files: ['./platform-integration-mcp.mjs'],
      },
    },
    memory: false,
    session: { dir: './state/sessions' },
    skills,
  })
}

async function exportProfile(profile: HarnessAgentConfig, name: string): Promise<string> {
  const skills = Array.isArray(profile.skills) ? profile.skills : []
  const destination = join(root, name)
  await writeAgentProject(profile, 'typescript', resolveSkillPaths(skills, root, false), destination, root)
  return destination
}

async function cliFor(agent: string, prompt: string, ...args: string[]): Promise<string> {
  const result = await run(process.execPath, [bin, '--agent', agent, '--print', prompt, ...args], {
    cwd: root,
    timeout: 30_000,
    env: { ...process.env, ...cliEnvironment() },
  })
  return `${result.stdout}\n${result.stderr}`
}

function cliEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: home,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${
      pathToFileURL(resolve(import.meta.dirname, '..', 'fixtures', 'platform-integration-fetch.mjs')).href
    }`.trim(),
    USERPROFILE: home,
  }
}

function expectMcpStopped(output: string): void {
  const pid = Number(output.match(/"pid":(\d+)/u)?.[1])
  expect(pid).toBeGreaterThan(0)
  expect(processRunning(pid)).toBe(false)
}

async function cli(prompt: string, ...args: string[]): Promise<string> {
  return cliFor(archive, prompt, ...args)
}

async function fixture(name: string): Promise<string> {
  return readFile(resolve(import.meta.dirname, '..', 'fixtures', name), 'utf8')
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
