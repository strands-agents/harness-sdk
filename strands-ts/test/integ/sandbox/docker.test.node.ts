import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawnSync } from 'child_process'
import { DockerSandbox } from '../../../src/sandbox/docker.js'

// Unique suffix so concurrent runs (CI matrix, or local + CI) don't collide on the container name.
const CONTAINER_NAME = `strands-integ-docker-sandbox-${Math.random().toString(16).slice(2, 8)}`

function dockerAvailable(): boolean {
  if (process.platform === 'win32') return false
  return spawnSync('docker', ['info'], { stdio: 'pipe' }).status === 0
}

describe.skipIf(!dockerAvailable())('DockerSandbox (integration)', () => {
  beforeAll(() => {
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'pipe' })
    // alpine (busybox) is tiny and ships sh + base64, all these tests need; executeCode runs via sh.
    execSync(`docker run -d --name ${CONTAINER_NAME} alpine:latest tail -f /dev/null`, { stdio: 'pipe' })
  })

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'pipe' })
  })

  it('runs commands and captures stdout, stderr, and exit code', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME })

    const result = await sandbox.execute('echo hello && echo err >&2')
    expect(result).toStrictEqual({
      type: 'executionResult',
      exitCode: 0,
      stdout: 'hello\n',
      stderr: 'err\n',
      outputFiles: [],
    })

    const failed = await sandbox.execute('exit 42')
    expect(failed).toStrictEqual({
      type: 'executionResult',
      exitCode: 42,
      stdout: '',
      stderr: '',
      outputFiles: [],
    })
  })

  it('runs code via executeCode', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME })

    const result = await sandbox.executeCode('echo $((6 * 7))', 'sh')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('42\n')
  })

  it('round-trips text and binary files', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME })

    await sandbox.writeText('greeting.txt', 'hello docker')
    expect(await sandbox.readText('greeting.txt')).toBe('hello docker')

    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255])
    await sandbox.writeFile('binary.bin', bytes)
    expect(Array.from(await sandbox.readFile('binary.bin'))).toStrictEqual(Array.from(bytes))
  })

  it('lists and removes files', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME })

    await sandbox.writeText('a.txt', 'a')
    await sandbox.writeText('b.txt', 'b')

    const names = (await sandbox.listFiles('.')).map((f) => f.name)
    expect(names).toContain('a.txt')
    expect(names).toContain('b.txt')

    await sandbox.removeFile('a.txt')
    await expect(sandbox.readFile('a.txt')).rejects.toThrow()
  })

  it('respects custom workingDir', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME, workingDir: '/opt' })

    const result = await sandbox.execute('pwd')
    expect(result.stdout.trim()).toBe('/opt')
  })

  it('respects per-command cwd override', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME })

    const result = await sandbox.execute('pwd', { cwd: '/usr' })
    expect(result.stdout.trim()).toBe('/usr')
  })

  it('kills command on timeout', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME })

    await expect(sandbox.execute('sleep 60', { timeout: 0.5 })).rejects.toThrow('timed out')
  })

  it('kills command on abort signal', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME })
    const controller = new AbortController()
    const promise = sandbox.execute('sleep 60', { signal: controller.signal })
    setTimeout(() => controller.abort(), 100)

    await expect(promise).rejects.toThrow('aborted')
  })

  it('passes env vars to the command', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME })

    const result = await sandbox.execute('echo $MY_VAR', { env: { MY_VAR: 'hello-from-env' } })
    expect(result.stdout.trim()).toBe('hello-from-env')
  })

  it('passes env values with shell metacharacters literally, without expansion', async () => {
    const sandbox = new DockerSandbox({ container: CONTAINER_NAME })

    // `-e KEY=VALUE` is argv, not shell input, so Docker stores the value verbatim.
    // `printenv` reads the variable without a shell touching the value, isolating the
    // Docker layer: any expansion of `$(whoami)`/`$HOME` here would be a real bug.
    const value = '$(whoami) $HOME `id`'
    const result = await sandbox.execute('printenv MY_VAR', { env: { MY_VAR: value } })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(value)
  })

  it('returns error for non-existent container', async () => {
    const sandbox = new DockerSandbox({ container: 'nonexistent123' })

    const result = await sandbox.execute('echo hi')
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/No such container/)
  })
})
