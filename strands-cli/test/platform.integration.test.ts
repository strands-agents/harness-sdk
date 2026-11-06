import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { defineHarnessAgentConfig, type HarnessAgentConfig, type HarnessModuleReference } from '@strands-agents/harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'

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

  it.each(['fresh', 'interrupted'])('serializes concurrent imports after a %s installation', async (state) => {
    const concurrentHome = join(root, `concurrent-${state}`)
    await mkdir(concurrentHome)
    const path = join(root, 'concurrent.zip')
    const files = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`wrapper/project/files/${index}.txt`, strToU8('source')])
    )
    await writeFile(
      path,
      zipSync({
        ...files,
        'wrapper/project/agent.ts': strToU8('export const agent = {}'),
        'wrapper/project/package.json': strToU8(
          JSON.stringify({ private: true, scripts: { postinstall: 'node install.cjs' } })
        ),
        'wrapper/project/install.cjs': strToU8(`
          const fs = require('node:fs')
          const path = require('node:path')
          fs.mkdirSync('install-active')
          fs.appendFileSync('installation-count', 'installed\\n')
          fs.writeFileSync(path.join(process.env.STRANDS_TEST_BARRIER, 'install-started'), process.cwd())
          const deadline = Date.now() + 15000
          const timer = setInterval(() => {
            if (fs.existsSync(path.join(process.env.STRANDS_TEST_BARRIER, 'release'))) {
              fs.mkdirSync('node_modules', { recursive: true })
              fs.rmdirSync('install-active')
              clearInterval(timer)
            } else if (Date.now() > deadline) {
              process.exit(1)
            }
          }, 100)
        `),
      })
    )
    const module = pathToFileURL(join(process.cwd(), 'dist/src/project/archive.js')).href
    const script = `
      import { writeFileSync } from 'node:fs'
      import { join } from 'node:path'
      import { extractAgentArchive, prepareArchiveDependencies } from ${JSON.stringify(module)}
      const root = extractAgentArchive(${JSON.stringify(path)})
      writeFileSync(join(process.env.STRANDS_TEST_BARRIER, 'ready-' + process.argv[1]), '')
      await prepareArchiveDependencies(root, 'typescript')
      console.log(extractAgentArchive(${JSON.stringify(path)}))
    `
    const options = {
      env: { ...process.env, ...cliEnvironment(concurrentHome), STRANDS_TEST_BARRIER: concurrentHome },
      timeout: 30_000,
    }
    let interrupted: Promise<unknown> | undefined
    if (state === 'interrupted') {
      const running = run(process.execPath, ['--input-type=module', '-e', script, 'interrupted'], options)
      interrupted = running.catch(() => undefined)
      await expect.poll(() => existsSync(join(concurrentHome, 'install-started')), { timeout: 15_000 }).toBe(true)
      const exited = once(running.child, 'exit')
      running.child.kill('SIGKILL')
      await exited
    }
    let settled = 0
    let failure: unknown
    const imports = [0, 1, 2].map((index) =>
      run(process.execPath, ['--input-type=module', '-e', script, String(index)], options)
        .catch((error: unknown) => {
          failure ??= error
          throw error
        })
        .finally(() => {
          settled++
        })
    )
    const finished = Promise.allSettled(imports)
    try {
      await expect
        .poll(() => [0, 1, 2].every((index) => existsSync(join(concurrentHome, `ready-${index}`))), { timeout: 15_000 })
        .toBe(true)
      await expect.poll(() => existsSync(join(concurrentHome, 'install-started')), { timeout: 15_000 }).toBe(true)
      await delay(1_000)
      if (failure) throw failure
      expect(settled).toBe(0)
      const installing = await readFile(join(concurrentHome, 'install-started'), 'utf8')
      expect(await readFile(join(installing, 'installation-count'), 'utf8')).toBe('installed\n')
    } finally {
      await writeFile(join(concurrentHome, 'release'), '')
      await finished
      await interrupted
    }
    const results = await finished
    const directories = results.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value.stdout.trim()
    })
    expect(new Set(directories).size).toBe(1)
    expect(await readFile(join(directories[0]!, 'installation-count'), 'utf8')).toBe(
      'installed\n'.repeat(state === 'interrupted' ? 2 : 1)
    )
    const cache = join(concurrentHome, '.strands', 'cli', 'cache', 'agents')
    expect(
      (await readdir(cache)).filter((name) => name.includes('.dependencies.lock') || name.startsWith('.extract-'))
    ).toEqual([])
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
