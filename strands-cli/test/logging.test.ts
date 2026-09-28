import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createFileLogger, resolveLogConfig } from '../src/logging.js'

describe('resolveLogConfig', () => {
  it('leaves logging off until it is opted into', () => {
    expect(resolveLogConfig({}).enabled).toBe(false)
    expect(resolveLogConfig({ STRANDS_CLI_LOG: '  ' }).enabled).toBe(false)
  })

  it('enables debug logging in the temp dir when opted in', () => {
    const config = resolveLogConfig({ STRANDS_CLI_LOG: '1' })
    expect(config.enabled).toBe(true)
    expect(config.level).toBe('debug')
    expect(config.filePath).toBe(join(tmpdir(), 'strands', 'cli.log'))
  })

  it('keeps logging off when only the file path is set', () => {
    const config = resolveLogConfig({ STRANDS_CLI_LOG_FILE: '/tmp/custom.log' })
    expect(config.enabled).toBe(false)
    expect(config.filePath).toBe('/tmp/custom.log')
  })

  it('disables logging for off-style values', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'none', 'no', 'disable', 'disabled']) {
      expect(resolveLogConfig({ STRANDS_CLI_LOG: value }).enabled).toBe(false)
    }
  })

  it('honors explicitly enabled logging with a custom file path and level', () => {
    const config = resolveLogConfig({
      STRANDS_CLI_LOG: 'on',
      STRANDS_CLI_LOG_FILE: '/tmp/custom.log',
      STRANDS_CLI_LOG_LEVEL: 'warn',
    })
    expect(config.enabled).toBe(true)
    expect(config.filePath).toBe('/tmp/custom.log')
    expect(config.level).toBe('warn')
  })

  it('falls back to debug for an unknown level', () => {
    expect(resolveLogConfig({ STRANDS_CLI_LOG_LEVEL: 'nonsense' }).level).toBe('debug')
  })

  it('takes the level from STRANDS_CLI_LOG unless STRANDS_CLI_LOG_LEVEL is set', () => {
    expect(resolveLogConfig({ STRANDS_CLI_LOG: 'warn' })).toMatchObject({ enabled: true, level: 'warn' })
    expect(resolveLogConfig({ STRANDS_CLI_LOG: 'warn', STRANDS_CLI_LOG_LEVEL: 'error' }).level).toBe('error')
    expect(resolveLogConfig({ STRANDS_CLI_LOG: 'on' }).level).toBe('debug')
  })

  it('prefers TMPDIR for the default path', () => {
    expect(resolveLogConfig({ TMPDIR: '/var/tmp' }).filePath).toBe('/var/tmp/strands/cli.log')
  })
})

describe('createFileLogger', () => {
  it('writes level-filtered entries to the file, creating the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strands-log-'))
    const filePath = join(dir, 'nested', 'cli.log')
    try {
      const logger = createFileLogger(filePath, 'info')
      logger.debug('skipped')
      logger.info('hello', { a: 1 })
      logger.warn('careful')
      logger.error(new Error('boom'))

      const contents = await readFile(filePath, 'utf8')
      expect(contents).not.toContain('skipped')
      expect(contents).toContain('INFO')
      expect(contents).toContain('hello {"a":1}')
      expect(contents).toContain('WARN')
      expect(contents).toContain('ERROR')
      expect(contents).toContain('boom')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('creates the directory and file for the owner only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strands-log-'))
    const filePath = join(dir, 'nested', 'cli.log')
    try {
      createFileLogger(filePath).info('hello')
      expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700)
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('tightens a pre-existing directory and log file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strands-log-'))
    const filePath = join(dir, 'strands', 'cli.log')
    try {
      await mkdir(dirname(filePath), { mode: 0o755 })
      await writeFile(filePath, 'old\n', { mode: 0o644 })
      await chmod(dirname(filePath), 0o755)
      await chmod(filePath, 0o644)
      createFileLogger(filePath).info('hello')
      expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700)
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
      expect(await readFile(filePath, 'utf8')).toContain('old')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades to a no-op when the directory cannot be created', () => {
    const logger = createFileLogger('/dev/null/nope/cli.log')
    expect(() => logger.info('nothing throws')).not.toThrow()
  })
})
