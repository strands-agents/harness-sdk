import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { defineHarnessAgentConfig, type HarnessAgentConfig, type HarnessModuleReference } from '@strands-agents/harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { writeAgentProject } from '../../src/tui/project/export.js'
import { resolveSkillPaths } from '../../src/tui/skills.js'
import { PLATFORM_CASE } from './catalog.js'

const run = promisify(execFile)
const bin = join(process.cwd(), 'dist', 'src', 'main.js')
let root: string
let archive: string
let home: string
let mcpConfig: string

describe('cross-platform exported agent E2E', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'strands-platform-integration-'))
    home = join(root, 'home')
    await mkdir(home)
    archive = await createExportedAgent('https://skills.example.test/SKILL.md')
    mcpConfig = join(root, 'mcp.json')
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          platform: {
            command: process.execPath,
            args: [resolve(import.meta.dirname, '..', 'fixtures', 'platform-integration-mcp.mjs')],
          },
        },
      })
    )
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
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
    const output = await cli('invoke the MCP probe', '--mcp-config', mcpConfig)
    expect(output).toContain('platform-mcp-ok')
    const pid = Number(output.match(/"pid":(\d+)/u)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(processRunning(pid)).toBe(false)
  })

  it(PLATFORM_CASE.session.testName, async () => {
    await cli('remember platform-alpha', '--session-id', 'platform-resume')
    const output = await cli('recall platform-beta', '--session-id', 'platform-resume')
    expect(output).toContain('HISTORY=remember platform-alpha|recall platform-beta')
  })
})

async function createExportedAgent(skillUrl: string): Promise<string> {
  const model = await fixture('platform-integration-model.ts')
  const localSkill = join(root, 'skills', 'local')
  await mkdir(localSkill, { recursive: true })
  await writeFile(
    join(localSkill, 'SKILL.md'),
    '---\nname: local-platform-skill\ndescription: Local platform integration marker.\n---\nUse local-platform-skill.\n'
  )
  const modelReference: HarnessModuleReference = {
    kind: 'model',
    module: './platform-integration-model.ts',
    export: 'model',
    language: 'typescript',
    files: ['./platform-integration-model.ts'],
  }
  const skills = [skillUrl, './skills']
  const profile: HarnessAgentConfig = defineHarnessAgentConfig({
    name: 'Platform integration agent',
    model: 'fixture/platform-integration',
    modelModule: modelReference,
    builtinTools: [],
    builtinPlugins: [],
    memory: false,
    session: { dir: './state/sessions' },
    skills,
  })
  await writeFile(join(root, 'platform-integration-model.ts'), model)
  const destination = join(root, 'platform-agent.zip')
  await writeAgentProject(profile, 'typescript', resolveSkillPaths(skills, root, false), destination, root)
  return destination
}

async function cli(prompt: string, ...args: string[]): Promise<string> {
  const result = await run(process.execPath, [bin, '--agent', archive, '--print', prompt, ...args], {
    cwd: root,
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${
        pathToFileURL(resolve(import.meta.dirname, '..', 'fixtures', 'platform-integration-fetch.mjs')).href
      }`.trim(),
      USERPROFILE: home,
    },
  })
  return `${result.stdout}\n${result.stderr}`
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
