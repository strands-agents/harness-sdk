import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { defineHarnessAgentConfig, type HarnessAgentConfig, type HarnessModuleReference } from '@strands-agents/harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CliConfigStore } from '../src/config/store.js'
import { readProjectArchive } from '../src/project/archive.js'
import { writeAgentProject } from '../src/project/export.js'
import type { AgentProjectLanguage } from '../src/project/import.js'
import { resolveSkillPaths } from '../src/agent/skills.js'
import { expectRestoredTerminal, runTuiCommand } from './fixtures/terminal-harness.js'

const run = promisify(execFile)
const bin = join(process.cwd(), 'dist', 'src', 'main.js')
let root: string
let archive: string
let home: string
let pythonArchive: string
let pythonStubs: string
let setupHome: string

describe('cross-platform exported agent E2E', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'strands-platform-integration-'))
    home = join(root, 'home')
    setupHome = join(root, 'setup-home')
    pythonStubs = join(root, 'python-stubs')
    await Promise.all([mkdir(home), mkdir(setupHome), mkdir(pythonStubs)])
    const setupConfig = await CliConfigStore.load(join(setupHome, '.strands', 'cli.toml'))
    await setupConfig.setSettings({ animations: false })
    await copyFile(
      resolve(import.meta.dirname, './', 'fixtures', 'platform-integration-sitecustomize.py'),
      join(pythonStubs, 'sitecustomize.py')
    )
    const profile = await createPlatformProfile('typescript')
    archive = await exportProfile(profile, 'platform-agent.zip')
    const exportedPythonProfile = await createPlatformProfile('python')
    pythonArchive = await exportProfile(exportedPythonProfile, 'platform-python-agent.zip', 'python')
    const config = await CliConfigStore.load(join(home, '.strands', 'cli.toml'))
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

  it('uses an agent across repeated export and import boundaries', { timeout: 480_000 }, async () => {
    const firstArchive = join(root, 'lifecycle-first.zip')
    const first = await runTuiCommand({
      scenario: 'lifecycle-profile',
      command: [process.execPath, bin],
      cwd: root,
      exportPath: firstArchive,
      env: cliEnvironment(),
      timeout: 90_000,
    })
    const firstOutput = first.screens.join('\n')
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
      timeout: 240_000,
    })
    const secondOutput = second.screens.join('\n')
    expect(second.returnCode).toBe(0)
    expect(secondOutput).toContain('platform-mcp-ok')
    expectMcpStopped(secondOutput)
    expect(second.exportSaved).toBe(true)
    expectRestoredTerminal(second)

    const finalOutput = await cliFor(secondArchive, 'invoke the MCP probe after re-import')
    expect(finalOutput).toContain('platform-mcp-ok')
    expectMcpStopped(finalOutput)
  })

  it('uses an exported Python agent across repeated import boundaries', { timeout: 480_000 }, async () => {
    const secondArchive = join(root, 'lifecycle-python-second.zip')
    const result = await runTuiCommand({
      scenario: 'lifecycle-project',
      command: [process.execPath, bin, '--agent', pythonArchive],
      cwd: root,
      exportPath: secondArchive,
      exportLanguage: 'python',
      // Windows pip can resolve its default cache relative to the imported project.
      env: { ...cliEnvironment(), PIP_CACHE_DIR: 'pip/cache' },
      timeout: 240_000,
    })
    const output = result.screens.join('\n')
    expect(result.returnCode).toBe(0)
    expect(output).toMatch(/LOCAL_SKILL=true.*REMOTE_SKILL=true/u)
    expect(output).toContain('platform-mcp-ok')
    expectMcpStopped(output)
    expect(result.exportSaved).toBe(true)
    expectRestoredTerminal(result)
    const entries = [...readProjectArchive(await readFile(secondArchive)).keys()]
    expect(entries.filter((path) => path.startsWith('pip/cache/'))).toEqual([])

    const finalOutput = await cliFor(secondArchive, 'invoke the MCP probe after re-import')
    expect(finalOutput).toContain('platform-mcp-ok')
    expectMcpStopped(finalOutput)
  })

  it('imports an agent through setup before using and re-exporting it', { timeout: 480_000 }, async () => {
    const exported = join(root, 'setup-imported-agent.zip')
    const result = await runTuiCommand({
      scenario: 'lifecycle-setup-import',
      command: [process.execPath, bin, '--setup'],
      cwd: root,
      exportPath: exported,
      importPath: archive,
      env: cliEnvironment(setupHome),
      timeout: 240_000,
    })
    const output = result.screens.join('\n')
    expect(result.returnCode).toBe(0)
    expect(output).toMatch(/LOCAL_SKILL=true.*REMOTE_SKILL=true/u)
    expect(output).toContain('platform-mcp-ok')
    expectMcpStopped(output)
    expect(result.exportSaved).toBe(true)
    expectRestoredTerminal(result)

    const setupConfig = await CliConfigStore.load(join(setupHome, '.strands', 'cli.toml'))
    expect(setupConfig.snapshot().agentProject).toMatch(/agent[/\\]agent\.ts$/u)
    const finalOutput = await cliFor(exported, 'invoke the MCP probe after setup re-import')
    expect(finalOutput).toContain('platform-mcp-ok')
    expectMcpStopped(finalOutput)
  })

  it('reports save and archive failures without leaving artifacts', async () => {
    const parentFile = join(root, 'not-a-directory')
    await writeFile(parentFile, 'occupied')
    const invalidDestination = join(parentFile, 'agent.zip')
    const save = await runTuiCommand({
      scenario: 'export-failure',
      command: [process.execPath, bin],
      cwd: root,
      exportPath: invalidDestination,
      env: cliEnvironment(),
    })
    expect(save.returnCode).toBe(0)
    expect(save.exportSaved).toBe(false)
    expect(save.screens.join('\n')).toContain('file already exists')
    expectRestoredTerminal(save)

    const corrupt = join(root, 'corrupt-agent.zip')
    await writeFile(corrupt, 'not a ZIP')
    const cacheBefore = await cachedAgentEntries()
    const failure = await cliFailure(corrupt)
    expect(failure.code).not.toBe(0)
    expect(failure.output).toMatch(/invalid zip|central directory/iu)
    expect(await cachedAgentEntries()).toEqual(cacheBefore)
  })
  it('resumes an exported agent session across CLI processes', { timeout: 480_000 }, async () => {
    await cli('remember platform-alpha', '--session-id', 'platform-resume')
    const output = await cli('recall platform-beta', '--session-id', 'platform-resume')
    expect(output).toContain('HISTORY=remember platform-alpha|recall platform-beta')
  })
})

async function createPlatformProfile(language: AgentProjectLanguage): Promise<HarnessAgentConfig> {
  const modelFile = `platform-integration-model.${language === 'python' ? 'py' : 'ts'}`
  const model = await fixture(modelFile)
  const mcpServer = await fixture('platform-integration-mcp.mjs')
  const localSkill = join(root, 'skills', 'local')
  await mkdir(localSkill, { recursive: true })
  await writeFile(
    join(localSkill, 'SKILL.md'),
    '---\nname: local-platform-skill\ndescription: Local platform integration marker.\n---\nUse local-platform-skill.\n'
  )
  await writeFile(join(root, modelFile), model)
  await writeFile(join(root, 'platform-integration-mcp.mjs'), mcpServer)
  const modelReference: HarnessModuleReference = {
    kind: 'model',
    module: `./${modelFile}`,
    export: 'model',
    language,
    files: [`./${modelFile}`],
  }
  return defineHarnessAgentConfig({
    name: `Platform ${language} integration agent`,
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
    session: language === 'typescript' ? { dir: './state/sessions' } : false,
    skills: ['https://skills.example.test/SKILL.md', './skills'],
  })
}

async function exportProfile(
  profile: HarnessAgentConfig,
  name: string,
  language: AgentProjectLanguage = 'typescript'
): Promise<string> {
  const skills = Array.isArray(profile.skills) ? profile.skills : []
  const destination = join(root, name)
  await writeAgentProject(profile, language, resolveSkillPaths(skills, root, false), destination, root)
  return destination
}

async function cliFor(agent: string, prompt: string, ...args: string[]): Promise<string> {
  const result = await run(process.execPath, [bin, '--agent', agent, '--print', prompt, ...args], {
    cwd: root,
    timeout: 240_000,
    env: { ...process.env, ...cliEnvironment() },
  })
  return `${result.stdout}\n${result.stderr}`
}

function cliEnvironment(targetHome = home): NodeJS.ProcessEnv {
  return {
    AWS_EC2_METADATA_DISABLED: 'true',
    HOME: targetHome,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${
      pathToFileURL(resolve(import.meta.dirname, './', 'fixtures', 'platform-integration-fetch.mjs')).href
    }`.trim(),
    PYTHONPYCACHEPREFIX: join(targetHome, 'python-cache'),
    PYTHONPATH: pythonStubs,
    USERPROFILE: targetHome,
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
  return readFile(resolve(import.meta.dirname, './', 'fixtures', name), 'utf8')
}

async function cachedAgentEntries(): Promise<string[]> {
  try {
    return (await readdir(join(home, '.strands', 'cli', 'cache', 'agents'))).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function cliFailure(agent: string): Promise<{ code: number | string; output: string }> {
  try {
    await run(process.execPath, [bin, '--agent', agent, '--print', 'unused'], {
      cwd: root,
      timeout: 30_000,
      env: { ...process.env, ...cliEnvironment() },
    })
  } catch (error) {
    const failure = error as Error & { code?: number | string; stderr?: string; stdout?: string }
    if (failure.code !== undefined) {
      return { code: failure.code, output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}` }
    }
    throw error
  }
  throw new Error('Expected the CLI to reject the corrupt archive.')
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
