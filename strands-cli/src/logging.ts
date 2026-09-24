/**
 * Development logging for the CLI.
 *
 * The interactive (ink) TUI has no console to log to, so it can capture logs to a file in the OS
 * temp directory for inspection after a run. That file logging is opt-in: nothing is written unless
 * `STRANDS_CLI_LOG` asks for it. Only the TUI ever logs to a file — the other run modes keep the
 * SDK's console logger so warnings and errors still reach stderr. Controlled by environment
 * variables:
 *
 *   STRANDS_CLI_LOG        enables file logging in the TUI (`1`/`on`/`true`, or a level name, which also
 *                   sets the level); unset, empty, or an off-value (`off`/`0`/`false`/`none`/`no`/
 *                   `disable`/`disabled`) leaves it off
 *   STRANDS_CLI_LOG_FILE   overrides the log file path (default: `<tmpdir>/strands/cli.log`); it does
 *                   not enable logging on its own
 *   STRANDS_CLI_LOG_LEVEL  `debug` | `info` | `warn` | `error` (default: `debug`); wins over a level given
 *                   in `STRANDS_CLI_LOG`
 */

import { chmodSync, fchmodSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configureLogging as configureCliLogging } from '@strands-agents/harness'
import { configureLogging as configureSdkLogging, type Logger } from '@strands-agents/sdk'

import type { CliRunMode } from './cli/arguments.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const OFF_VALUES = new Set(['', 'off', '0', 'false', 'none', 'no', 'disable', 'disabled'])

export interface LogConfig {
  enabled: boolean
  filePath: string
  level: LogLevel
}

export function defaultLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TMPDIR?.trim() || tmpdir(), 'strands', 'cli.log')
}

export function resolveLogConfig(env: NodeJS.ProcessEnv = process.env): LogConfig {
  const requested = (env.STRANDS_CLI_LOG ?? '').trim().toLowerCase()
  const enabled = !OFF_VALUES.has(requested)
  const filePath = env.STRANDS_CLI_LOG_FILE?.trim() || defaultLogFilePath(env)
  const level = env.STRANDS_CLI_LOG_LEVEL?.trim().toLowerCase() || requested
  return {
    enabled,
    filePath,
    level: level && level in LEVEL_ORDER ? (level as LogLevel) : 'debug',
  }
}

const NOOP_LOGGER: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

export function initLogging(mode: CliRunMode, env: NodeJS.ProcessEnv = process.env): void {
  if (mode !== 'ink') {
    return
  }
  const config = resolveLogConfig(env)
  const logger = config.enabled ? createFileLogger(config.filePath, config.level) : NOOP_LOGGER
  configureCliLogging(logger)
  configureSdkLogging(logger)
}

/**
 * Build a Logger that appends level-filtered lines to `filePath`. The file is opened once and each
 * line is written to the held descriptor, so live TUI rendering isn't stalled by an open/close per
 * log call; writes stay synchronous so a crash-time log isn't lost in a buffer. The log can hold
 * prompts and tool output and the default path is in the shared temp dir, so the directory is
 * created `0o700` and the file opened `0o600`, and both are re-applied to a pre-existing path. If the
 * log file can't be prepared (e.g. an unwritable
 * temp dir) it degrades to a no-op logger so logging never breaks a run.
 */
export function createFileLogger(filePath: string, level: LogLevel = 'debug'): Logger {
  let fd: number
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    chmodSync(dirname(filePath), 0o700)
    fd = openSync(filePath, 'a', 0o600)
    fchmodSync(fd, 0o600)
  } catch {
    return NOOP_LOGGER
  }

  const threshold = LEVEL_ORDER[level]
  const write = (entryLevel: LogLevel, args: unknown[]): void => {
    if (LEVEL_ORDER[entryLevel] < threshold) {
      return
    }
    const line = `${new Date().toISOString()} ${entryLevel.toUpperCase().padEnd(5)} [${process.pid}] ${args.map(formatArg).join(' ')}\n`
    try {
      writeSync(fd, line)
    } catch {
      // Best-effort: a logging failure must never interrupt a run.
    }
  }

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return arg
  }
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`
  }
  try {
    return JSON.stringify(arg) ?? String(arg)
  } catch {
    return String(arg)
  }
}
