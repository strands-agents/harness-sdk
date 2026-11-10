import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@strands-agents/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

const configureHarness = vi.fn()
const configureSdk = vi.fn()

vi.mock('@strands-agents/harness', () => ({ configureLogging: configureHarness }))
vi.mock('@strands-agents/sdk', async (importActual) => ({
  ...(await importActual<typeof import('@strands-agents/sdk')>()),
  configureLogging: configureSdk,
}))

const { initLogging } = await import('../src/logging.js')

afterEach(() => {
  configureHarness.mockClear()
  configureSdk.mockClear()
})

describe('initLogging', () => {
  it.each([{}, { STRANDS_CLI_LOG: 'off' }, { STRANDS_CLI_LOG: '1', STRANDS_CLI_LOG_FILE: '/dev/null/nope/cli.log' }])(
    'configures both loggers in ink mode for %j',
    (environment) => {
      initLogging('ink', environment)
      expect(configureHarness).toHaveBeenCalledTimes(1)
      expect(configureSdk).toHaveBeenCalledTimes(1)
    }
  )

  it('writes to the log file only once logging is opted into', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-init-log-'))
    const filePath = join(directory, 'cli.log')
    try {
      initLogging('ink', { STRANDS_CLI_LOG_FILE: filePath })
      const disabled = configureHarness.mock.calls[0]?.[0] as Logger
      disabled.info('dropped')
      expect(existsSync(filePath)).toBe(false)

      initLogging('ink', { STRANDS_CLI_LOG: '1', STRANDS_CLI_LOG_FILE: filePath })
      const enabled = configureHarness.mock.calls[1]?.[0] as Logger
      enabled.info('captured')
      expect(await readFile(filePath, 'utf8')).toContain('captured')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('leaves both loggers untouched in non-ink modes', () => {
    for (const mode of ['print', 'plain', 'acp'] as const) {
      initLogging(mode)
    }
    expect(configureHarness).not.toHaveBeenCalled()
    expect(configureSdk).not.toHaveBeenCalled()
  })
})
