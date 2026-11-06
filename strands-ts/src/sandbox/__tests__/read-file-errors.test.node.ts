import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { TestSandbox } from '../../__fixtures__/test-sandbox.node.js'
import { NotASandboxLocalEnvironment } from '../not-a-sandbox-local-environment.js'
import { SandboxIsADirectoryError, SandboxPathNotFoundError, SandboxPermissionError } from '../errors.js'
import type { Sandbox } from '../base.js'

const TEST_DIR = path.join(os.tmpdir(), 'strands-test-read-file-errors')
const IS_ROOT = process.getuid?.() === 0

// Both backends must throw the same typed errors so `instanceof` works whichever sandbox is configured.
describe.skipIf(process.platform === 'win32').each([
  { backend: 'NotASandboxLocalEnvironment', create: (): Sandbox => new NotASandboxLocalEnvironment() },
  { backend: 'PosixShellSandbox', create: (): Sandbox => new TestSandbox(TEST_DIR) },
])('$backend readFile errors', ({ create }) => {
  let sandbox: Sandbox

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
    fs.mkdirSync(TEST_DIR, { recursive: true })
    fs.writeFileSync(`${TEST_DIR}/file.txt`, 'x')
    sandbox = create()
  })

  afterEach(() => {
    fs.chmodSync(TEST_DIR, 0o700)
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('throws SandboxPathNotFoundError for a missing file', async () => {
    const target = `${TEST_DIR}/nope.txt`
    await expect(sandbox.readFile(target)).rejects.toStrictEqual(new SandboxPathNotFoundError(target))
  })

  it('throws SandboxPathNotFoundError when an ancestor is a file', async () => {
    const target = `${TEST_DIR}/file.txt/child.txt`
    await expect(sandbox.readFile(target)).rejects.toStrictEqual(new SandboxPathNotFoundError(target))
  })

  it('throws SandboxIsADirectoryError for a directory', async () => {
    await expect(sandbox.readFile(TEST_DIR)).rejects.toStrictEqual(new SandboxIsADirectoryError(TEST_DIR))
  })

  it.skipIf(IS_ROOT)('throws SandboxPermissionError for an unreadable file', async () => {
    const target = `${TEST_DIR}/file.txt`
    fs.chmodSync(target, 0o200)
    await expect(sandbox.readFile(target)).rejects.toStrictEqual(new SandboxPermissionError(target))
  })

  it.skipIf(IS_ROOT)('throws SandboxPermissionError under an unsearchable directory', async () => {
    fs.mkdirSync(`${TEST_DIR}/locked/inner`, { recursive: true })
    fs.writeFileSync(`${TEST_DIR}/locked/inner/secret.txt`, 'x')
    fs.chmodSync(`${TEST_DIR}/locked`, 0o600)
    const target = `${TEST_DIR}/locked/inner/secret.txt`
    try {
      await expect(sandbox.readFile(target)).rejects.toStrictEqual(new SandboxPermissionError(target))
    } finally {
      fs.chmodSync(`${TEST_DIR}/locked`, 0o700)
    }
  })
})
