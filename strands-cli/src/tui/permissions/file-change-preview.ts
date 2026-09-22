import { SandboxPathNotFoundError, type BeforeToolCallEvent } from '@strands-agents/sdk'

import type { ChatDiffLine, ChatDiffPreview } from '../chat/controller.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'

const CONTEXT_LINES = 3
const MAX_DIFF_LINES = 320
const MAX_LCS_CELLS = 300_000

interface DiffOperation extends ChatDiffLine {
  kind: 'context' | 'add' | 'remove'
}

export async function buildFileChangePreview(event: BeforeToolCallEvent): Promise<ChatDiffPreview | undefined> {
  const input = event.toolUse.input
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined
  }
  const path = input.path
  if (typeof path !== 'string' || !path) {
    return undefined
  }

  if (event.toolUse.name === 'write') {
    const content = input.content
    if (typeof content !== 'string') {
      return undefined
    }
    const before = await readText(event, path, true)
    return before === undefined ? undefined : createDiffPreview(path, before, content)
  }

  if (event.toolUse.name === 'edit') {
    const oldText = input.old_str
    const newText = input.new_str
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      return undefined
    }
    const before = await readText(event, path, false)
    if (before === undefined || !oldText || before.split(oldText).length !== 2) {
      return undefined
    }
    return createDiffPreview(path, before, before.replace(oldText, newText))
  }

  return undefined
}

export function createDiffPreview(path: string, before: string, after: string): ChatDiffPreview {
  const operations = lineOperations(splitLines(before), splitLines(after))
  const lines = diffHunks(operations)
  const truncated = lines.length > MAX_DIFF_LINES
  return {
    path: sanitizeTerminalText(path),
    lines: truncated ? lines.slice(0, MAX_DIFF_LINES) : lines,
    ...(truncated ? { truncated: true } : {}),
  }
}

export function sanitizeDiffPreview(diff: ChatDiffPreview): ChatDiffPreview {
  return {
    path: sanitizeTerminalText(diff.path),
    lines: diff.lines.map((line) => ({ ...line, text: sanitizeTerminalText(line.text) })),
    ...(diff.truncated ? { truncated: true } : {}),
  }
}

async function readText(
  event: BeforeToolCallEvent,
  path: string,
  missingIsEmpty: boolean
): Promise<string | undefined> {
  try {
    return await event.agent.sandbox.readText(path)
  } catch (error) {
    if (missingIsEmpty && error instanceof SandboxPathNotFoundError) {
      return ''
    }
    return undefined
  }
}

function splitLines(value: string): string[] {
  return value === '' ? [] : value.split('\n')
}

function lineOperations(before: readonly string[], after: readonly string[]): DiffOperation[] {
  return before.length * after.length <= MAX_LCS_CELLS
    ? lcsOperations(before, after)
    : contiguousOperations(before, after)
}

function lcsOperations(before: readonly string[], after: readonly string[]): DiffOperation[] {
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex--) {
      table[oldIndex]![newIndex] =
        before[oldIndex] === after[newIndex]
          ? table[oldIndex + 1]![newIndex + 1]! + 1
          : Math.max(table[oldIndex + 1]![newIndex]!, table[oldIndex]![newIndex + 1]!)
    }
  }

  const operations: DiffOperation[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < before.length || newIndex < after.length) {
    if (oldIndex < before.length && newIndex < after.length && before[oldIndex] === after[newIndex]) {
      operations.push({
        kind: 'context',
        text: before[oldIndex]!,
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      })
      oldIndex++
      newIndex++
    } else if (
      newIndex < after.length &&
      (oldIndex === before.length || table[oldIndex]![newIndex + 1]! > table[oldIndex + 1]![newIndex]!)
    ) {
      operations.push({ kind: 'add', text: after[newIndex]!, newLine: newIndex + 1 })
      newIndex++
    } else {
      operations.push({ kind: 'remove', text: before[oldIndex]!, oldLine: oldIndex + 1 })
      oldIndex++
    }
  }
  return operations
}

function contiguousOperations(before: readonly string[], after: readonly string[]): DiffOperation[] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix++
  }

  const operations: DiffOperation[] = []
  for (let index = 0; index < prefix; index++) {
    operations.push({ kind: 'context', text: before[index]!, oldLine: index + 1, newLine: index + 1 })
  }
  for (let index = prefix; index < before.length - suffix; index++) {
    operations.push({ kind: 'remove', text: before[index]!, oldLine: index + 1 })
  }
  for (let index = prefix; index < after.length - suffix; index++) {
    operations.push({ kind: 'add', text: after[index]!, newLine: index + 1 })
  }
  for (let index = 0; index < suffix; index++) {
    const oldIndex = before.length - suffix + index
    const newIndex = after.length - suffix + index
    operations.push({
      kind: 'context',
      text: before[oldIndex]!,
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
    })
  }
  return operations
}

function diffHunks(operations: readonly DiffOperation[]): ChatDiffLine[] {
  const changes = operations.flatMap((operation, index) => (operation.kind === 'context' ? [] : [index]))
  if (changes.length === 0) {
    return [{ kind: 'header', text: 'No changes' }]
  }

  const ranges: { start: number; end: number }[] = []
  for (const index of changes) {
    const start = Math.max(0, index - CONTEXT_LINES)
    const end = index + CONTEXT_LINES + 1
    const previous = ranges.at(-1)
    if (previous && start <= previous.end) {
      previous.end = end
    } else {
      ranges.push({ start, end })
    }
  }

  return ranges.flatMap((range) => {
    const hunk = operations.slice(range.start, range.end)
    const oldLines = hunk.filter((line) => line.kind !== 'add')
    const newLines = hunk.filter((line) => line.kind !== 'remove')
    const oldStart = oldLines[0]?.oldLine ?? nearestLine(operations, range.start, 'oldLine')
    const newStart = newLines[0]?.newLine ?? nearestLine(operations, range.start, 'newLine')
    return [
      {
        kind: 'header' as const,
        text: `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
      },
      ...hunk,
    ]
  })
}

function nearestLine(operations: readonly DiffOperation[], index: number, field: 'oldLine' | 'newLine'): number {
  for (let cursor = index; cursor < operations.length; cursor++) {
    if (operations[cursor]?.[field] !== undefined) {
      return operations[cursor]![field]!
    }
  }
  return (operations.at(-1)?.[field] ?? 0) + 1
}
