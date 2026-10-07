#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { URL, fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

async function run(command, args, cwd) {
  return execFileAsync(command, args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
}

const { stdout: packOutput } = await run(npm, ['pack', '--silent', '--json'], packageRoot)
const [{ filename }] = JSON.parse(packOutput)
const tarball = resolve(packageRoot, filename)
const installRoot = await mkdtemp(join(tmpdir(), 'strands-cli-package-'))

try {
  await run(npm, ['init', '--yes'], installRoot)
  await run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], installRoot)

  const bin = join(installRoot, 'node_modules', '@strands-agents', 'cli', 'bin', 'strands.js')
  const { stdout } = await run(process.execPath, [bin, '--help'], installRoot)
  if (!stdout.includes('Chat with a Strands harness agent')) {
    throw new Error('installed strands binary did not print its help text')
  }

  process.stdout.write(`PASS packed install · ${process.platform} · ${filename}\n`)
} finally {
  await rm(installRoot, { recursive: true, force: true })
  if (process.env.STRANDS_CLI_KEEP_TARBALL !== 'true') {
    await rm(tarball, { force: true })
  }
}
