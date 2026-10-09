import type { JSONValue } from '@strands-agents/sdk'

export function sanitizeTerminalText(text: string): string {
  let state: 'text' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'text'
  let result = ''

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (state === 'csi') {
      if (code >= 0x40 && code <= 0x7e) {
        state = 'text'
      }
      continue
    }
    if (state === 'string') {
      if (character === '\u0007' || code === 0x9c) {
        state = 'text'
      } else if (character === '\u001b') {
        state = 'stringEscape'
      }
      continue
    }
    if (state === 'stringEscape') {
      state = character === '\\' || code === 0x9c ? 'text' : 'string'
      continue
    }
    if (state === 'escape') {
      if (character === '[') {
        state = 'csi'
      } else if (character === ']' || character === 'P' || character === '^' || character === '_') {
        state = 'string'
      } else {
        state = 'text'
      }
      continue
    }
    if (character === '\u001b') {
      state = 'escape'
      continue
    }
    if (code === 0x9b) {
      state = 'csi'
      continue
    }
    if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) {
      state = 'string'
      continue
    }
    if (character === '\n' || character === '\t' || (code >= 0x20 && (code < 0x7f || code > 0x9f))) {
      result += character
    }
  }
  return result
}

export function errorMessage(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error))
}

export function sanitizeTerminalValue(value: JSONValue): JSONValue {
  if (Array.isArray(value)) {
    return value.map(sanitizeTerminalValue)
  }
  if (value !== null && typeof value === 'object') {
    const clone: Record<string, JSONValue> = {}
    for (const [key, child] of Object.entries(value)) {
      clone[sanitizeTerminalText(key)] = sanitizeTerminalValue(child)
    }
    return clone
  }
  return typeof value === 'string' ? sanitizeTerminalText(value) : value
}
