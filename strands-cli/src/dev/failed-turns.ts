import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { sanitizeTerminalText } from '../terminal/text.js'
import type { FailedTurn, FailedTurnRecord } from '../ui/chat/types.js'
import { isRecord } from '../values.js'

const MAX_FAILED_TURNS = 10
const UNSAFE_NAME_CHARACTERS = /[^A-Za-z0-9._-]/gu

const failedTurnsFile = (workspaceDirectory: string, sessionId: string): string =>
  join(
    workspaceDirectory,
    '.strands',
    'state',
    'failed-turns',
    `${sessionId.replace(UNSAFE_NAME_CHARACTERS, '_')}.json`
  )

const validTurns = (value: unknown): FailedTurn[] =>
  (Array.isArray(value) ? value : [])
    .flatMap((turn) =>
      isRecord(turn) && typeof turn.prompt === 'string' && typeof turn.error === 'string'
        ? [{ prompt: sanitizeTerminalText(turn.prompt), error: sanitizeTerminalText(turn.error) }]
        : []
    )
    .slice(-MAX_FAILED_TURNS)

const savedTurns = async (file: string): Promise<FailedTurn[]> => {
  try {
    return validTurns(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return []
  }
}

export const devFailedTurnRecord = async (workspaceDirectory: string, sessionId: string): Promise<FailedTurnRecord> => {
  const file = failedTurnsFile(workspaceDirectory, sessionId)
  return {
    saved: await savedTurns(file),
    save: async (turns): Promise<void> => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, `${JSON.stringify(turns.slice(-MAX_FAILED_TURNS), null, 2)}\n`, { mode: 0o600 })
    },
  }
}
