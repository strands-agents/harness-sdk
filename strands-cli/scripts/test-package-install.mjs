#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { URL, fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const npm = process.env.npm_execpath
if (!npm) {
  throw new Error('Run this check with npm run test:package-install.')
}

async function run(args, cwd, env = process.env) {
  return execFileAsync(process.execPath, args, {
    cwd,
    env,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
}

const { stdout: packOutput } = await run([npm, 'pack', '--silent', '--json'], packageRoot)
const [{ filename }] = JSON.parse(packOutput)
const tarball = resolve(packageRoot, filename)
const installRoot = await mkdtemp(join(tmpdir(), 'strands-cli-package-'))
let requests = 0
const server = createServer((_request, response) => {
  requests += 1
  response.writeHead(200, { 'Content-Type': 'text/plain' })
  response.end('__FETCH_TOOL_OK__')
})

try {
  await run([npm, 'init', '--yes'], installRoot)
  await run([npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], installRoot)

  const bin = join(installRoot, 'node_modules', '@strands-agents', 'cli', 'bin', 'strands.js')
  const { stdout } = await run([bin, '--help'], installRoot)
  if (!stdout.includes('Chat with a Strands harness agent')) {
    throw new Error('installed strands binary did not print its help text')
  }

  const installedRoot = join(installRoot, 'node_modules', '@strands-agents', 'cli')
  const { resolveVoiceSidecarPath } = await import(
    pathToFileURL(join(installedRoot, 'dist', 'src', 'agent', 'voice.js')).href
  )
  const bundledSidecar = resolveVoiceSidecarPath()
  if (
    (await realpath(bundledSidecar)) !== (await realpath(join(installedRoot, 'src', 'agent', 'voice-sidecar.py'))) ||
    (await readFile(bundledSidecar, 'utf8')) !==
      (await readFile(join(packageRoot, 'src', 'agent', 'voice-sidecar.py'), 'utf8'))
  ) {
    throw new Error('installed voice runtime did not resolve the bundled sidecar')
  }

  const { CliConfigStore } = await import(pathToFileURL(join(installedRoot, 'dist/src/config/store.js')).href)
  const home = join(installRoot, 'home')
  const workspace = join(installRoot, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'package.json'), '{"type":"module"}\n')
  await copyFile(
    join(packageRoot, 'test/fixtures/platform-integration-model.ts'),
    join(workspace, 'platform-integration-model.ts')
  )
  const config = await CliConfigStore.load(join(home, '.strands', 'cli.toml'))
  await config.saveSetup({
    providers: ['bedrock'],
    profile: {
      ...config.snapshot().profile,
      model: 'fixture/platform-integration',
      modelModule: {
        kind: 'model',
        module: './platform-integration-model.ts',
        export: 'model',
        language: 'typescript',
        files: ['./platform-integration-model.ts'],
      },
      builtinTools: ['read', 'write', 'edit', 'shell', 'web_fetch'],
      session: false,
      memory: false,
      skills: false,
    },
    profileBaseDir: workspace,
    permissionMode: 'bypassPermissions',
    providerEnvironment: {},
    settings: { animations: false, agentMessaging: false, mcpDiscovery: false, skillDiscovery: false },
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    STRANDS_CLI_TELEMETRY: 'off',
    STRANDS_CLI_TEST_FETCH_URL: `http://127.0.0.1:${server.address().port}/probe`,
  }
  const probeFile = join(workspace, 'builtin tool probe.txt')
  const printed = await run([bin, '-p', 'exercise built-in tools'], workspace, env)
  assert.ok(printed.stdout.includes('BUILTIN_TOOLS_OK'), printed.stdout + printed.stderr)
  assert.equal(await readFile(probeFile, 'utf8'), 'after edit\n')
  await rm(probeFile)

  const terminal = await run(
    [join(packageRoot, 'test/fixtures/tui-integration-driver.mjs'), process.execPath, bin],
    workspace,
    { ...env, STRANDS_CLI_TEST_SCENARIO: 'builtin-tools', STRANDS_CLI_TEST_EXPORT_PATH: join(workspace, 'unused.zip') }
  )
  const result = JSON.parse(terminal.stdout)
  assert.equal(result.returnCode, 0, terminal.stderr)
  assert.ok(result.screens.join('\n').includes('BUILTIN_TOOLS_OK'))
  assert.equal(await readFile(probeFile, 'utf8'), 'after edit\n')
  assert.equal(requests, 2, 'both installed run modes must fetch through the real sandbox')

  process.stdout.write(`PASS packed install · ${process.platform} · ${filename}\n`)
} finally {
  await new Promise((resolve) => server.close(resolve))
  await rm(installRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  if (process.env.STRANDS_CLI_KEEP_TARBALL !== 'true') {
    await rm(tarball, { force: true })
  }
}
