import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { URL } from 'node:url'
import type { JSONValue } from '@strands-agents/sdk'

import { containsPath } from '../paths.js'
import { isControlCharacter } from '../terminal/sanitize.js'
import { isRecord } from '../values.js'

/**
 * A saved permission rule is `tool` (every call) or `tool(pattern)`. Patterns ending in `*` cover a
 * prefix: command words for `shell`, a directory for file tools, a host or path for `web_fetch`.
 */
export interface PermissionScope {
  rule: string
  label: string
}

export interface PermissionRules {
  allow: readonly string[]
  deny: readonly string[]
}

type PermissionSubject =
  | { kind: 'command'; command: string }
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string; key: string; segments: readonly string[] }
  | { kind: 'action'; action: string }

interface ShellParse {
  segments: string[][]
  opaque: boolean
}

interface ShellState extends ShellParse {
  token: string
  quote: string | undefined
}

const WILDCARD = '*'
const MAX_PREFIX_LEVELS = 3
export const FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'write', 'edit'])
const SHELL_SEPARATORS = ['&&', '||', ';', '|', '&', '\n']
const SHELL_OPAQUE = new Set(['`', '<', '>', '(', ')', '{', '}'])
const WHOLE_TOOL_LABELS: Record<PermissionSubject['kind'], string> = {
  command: 'any command',
  path: 'any file',
  url: 'any URL',
  action: 'any action',
}

export function parsePermissionRule(rule: string): { tool: string; pattern?: string } {
  const open = rule.indexOf('(')
  if (open <= 0 || !rule.endsWith(')')) return { tool: rule }
  const tool = rule.slice(0, open)
  const pattern = rule.slice(open + 1, -1)
  return pattern === WILDCARD || !pattern ? { tool } : { tool, pattern }
}

export function canonicalPermissionRule(rule: string): string {
  const { tool, pattern } = parsePermissionRule(rule)
  return pattern === undefined ? tool : `${tool}(${pattern})`
}

/** Deny rules win over allow rules; `undefined` means no saved rule covers the call. */
export function permissionRuleDecision(
  toolName: string,
  input: JSONValue,
  rules: PermissionRules,
  workspace: string
): 'allow' | 'deny' | undefined {
  const subject = permissionSubject(toolName, input, workspace)
  const deny = toolPatterns(rules.deny, toolName)
  if (deny.whole || (subject && deny.patterns.some((pattern) => subjectDenied(subject, pattern)))) return 'deny'
  const allow = toolPatterns(rules.allow, toolName)
  if (allow.whole || (subject && subjectAllowed(subject, allow.patterns))) return 'allow'
  return undefined
}

/** The call's action as shown in a permission prompt, or `undefined` when the tool has none. */
export function permissionAction(toolName: string, input: JSONValue, workspace: string): string | undefined {
  const subject = permissionSubject(toolName, input, workspace)
  if (!subject) return undefined
  if (subject.kind === 'path') return displayPath(subject.path, workspace)
  return subject.kind === 'command' ? subject.command : subject.kind === 'url' ? subject.url : subject.action
}

/** Rules a "forever" choice can save, most specific first; the last always covers the whole tool. */
export function permissionScopes(toolName: string, input: JSONValue, workspace: string): PermissionScope[] {
  const subject = permissionSubject(toolName, input, workspace)
  const specific = subject ? subjectScopes(toolName, subject, workspace) : []
  const whole = { rule: toolName, label: `${WILDCARD} ${subject ? WHOLE_TOOL_LABELS[subject.kind] : 'any call'}` }
  return [...specific.filter((scope) => ![...scope.rule].some(isControlCharacter)), whole]
}

/** Resolves symlinks through the nearest existing ancestor, so a new file maps to its real directory. */
export function canonicalPath(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.push(basename(current))
      current = parent
    }
  }
}

function permissionSubject(toolName: string, input: JSONValue, workspace: string): PermissionSubject | undefined {
  if (!isRecord(input)) return undefined
  if (toolName === 'shell' && typeof input.command === 'string' && input.command.trim()) {
    return { kind: 'command', command: input.command.trim() }
  }
  if (FILE_TOOLS.has(toolName) && typeof input.path === 'string' && input.path.trim()) {
    return { kind: 'path', path: canonicalPath(resolve(workspace, input.path)) }
  }
  if (toolName === 'web_fetch' && typeof input.url === 'string') return urlSubject(input.url)
  if (toolName === 'strands_config' && typeof input.action === 'string' && input.action) {
    return { kind: 'action', action: input.action }
  }
  return undefined
}

function urlSubject(value: string): PermissionSubject | undefined {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return {
      kind: 'url',
      url: value.trim(),
      key: `${url.host}${url.pathname}`,
      segments: [url.host, ...url.pathname.split('/').filter(Boolean)],
    }
  } catch {
    return undefined
  }
}

function toolPatterns(rules: readonly string[], toolName: string): { whole: boolean; patterns: string[] } {
  const parsed = rules.map(parsePermissionRule).filter((rule) => rule.tool === toolName)
  return {
    whole: parsed.some((rule) => rule.pattern === undefined),
    patterns: parsed.flatMap((rule) => (rule.pattern === undefined ? [] : [rule.pattern])),
  }
}

function subjectAllowed(subject: PermissionSubject, patterns: readonly string[]): boolean {
  if (subject.kind !== 'command') return patterns.some((pattern) => subjectMatches(subject, pattern))
  if (patterns.includes(subject.command)) return true
  // Prefix rules cover a compound command only when every part is covered and nothing is hidden in substitutions.
  const parsed = parseShell(subject.command)
  return (
    !parsed.opaque &&
    parsed.segments.length > 0 &&
    parsed.segments.every((words) => patterns.some((pattern) => commandWordsMatch(words, pattern)))
  )
}

function subjectDenied(subject: PermissionSubject, pattern: string): boolean {
  if (subject.kind !== 'command') return subjectMatches(subject, pattern)
  return (
    subject.command === pattern ||
    parseShell(subject.command).segments.some((words) => commandWordsMatch(words, pattern))
  )
}

function subjectMatches(subject: Exclude<PermissionSubject, { kind: 'command' }>, pattern: string): boolean {
  if (subject.kind === 'action') return subject.action === pattern
  if (subject.kind === 'path') return pathMatches(subject.path, pattern)
  if (pattern.includes('://')) return subject.url === pattern
  return prefixMatches(subject.key, pattern, '/')
}

function pathMatches(path: string, pattern: string): boolean {
  return pattern.endsWith(`${sep}${WILDCARD}`) ? prefixMatches(path, pattern, sep) : path === pattern
}

function prefixMatches(value: string, pattern: string, separator: string): boolean {
  if (!pattern.endsWith(`${separator}${WILDCARD}`)) return false
  const base = pattern.slice(0, -2)
  return value === base || value.startsWith(`${base}${separator}`)
}

function commandWordsMatch(words: readonly string[], pattern: string): boolean {
  const prefix = pattern.endsWith(` ${WILDCARD}`)
  const parsed = parseShell(prefix ? pattern.slice(0, -2) : pattern)
  const expected = parsed.segments[0]
  if (!expected || parsed.segments.length !== 1) return false
  if (!prefix && words.length !== expected.length) return false
  return words.length >= expected.length && expected.every((word, index) => words[index] === word)
}

function subjectScopes(toolName: string, subject: PermissionSubject, workspace: string): PermissionScope[] {
  if (subject.kind === 'command') return commandScopes(toolName, subject.command)
  if (subject.kind === 'path') return pathScopes(toolName, subject.path, workspace)
  if (subject.kind === 'url') return urlScopes(toolName, subject)
  return [{ rule: `${toolName}(${subject.action})`, label: subject.action }]
}

function commandScopes(toolName: string, command: string): PermissionScope[] {
  const scope = (pattern: string): PermissionScope => ({ rule: `${toolName}(${pattern})`, label: pattern })
  // A literal trailing `*` would read back as a prefix rule, so only exact commands without one are offered.
  const exact = command.endsWith(WILDCARD) ? [] : [scope(command)]
  const parsed = parseShell(command)
  const words = parsed.segments[0] ?? []
  if (parsed.opaque || parsed.segments.length !== 1) return exact
  const levels = Math.min(MAX_PREFIX_LEVELS, words.length - 1)
  const prefixes = Array.from({ length: Math.max(0, levels) }, (_, offset) =>
    scope(`${words.slice(0, levels - offset).join(' ')} ${WILDCARD}`)
  )
  return [...exact, ...prefixes]
}

function pathScopes(toolName: string, path: string, workspace: string): PermissionScope[] {
  const inside = containsPath(workspace, path)
  const directories: string[] = []
  for (let current = dirname(path); directories.length < MAX_PREFIX_LEVELS; current = dirname(current)) {
    if (current === dirname(current) || (inside && !containsPath(workspace, current))) break
    directories.push(current)
    if (current === workspace) break
  }
  if (inside && !directories.includes(workspace)) directories.push(workspace)
  const exact = path.endsWith(WILDCARD) ? [] : [{ rule: `${toolName}(${path})`, label: displayPath(path, workspace) }]
  return [
    ...exact,
    ...directories.map((directory) => ({
      rule: `${toolName}(${join(directory, WILDCARD)})`,
      label:
        directory === workspace ? `.${sep}${WILDCARD} this project` : join(displayPath(directory, workspace), WILDCARD),
    })),
  ]
}

function urlScopes(toolName: string, subject: Extract<PermissionSubject, { kind: 'url' }>): PermissionScope[] {
  const lengths: number[] = []
  for (let length = subject.segments.length - 1; length >= 1 && lengths.length < MAX_PREFIX_LEVELS; length--) {
    lengths.push(length)
  }
  if (!lengths.includes(1)) lengths.push(1)
  return [
    { rule: `${toolName}(${subject.url})`, label: subject.url },
    ...lengths.map((length) => {
      const pattern = [...subject.segments.slice(0, length), WILDCARD].join('/')
      return { rule: `${toolName}(${pattern})`, label: pattern }
    }),
  ]
}

function displayPath(path: string, workspace: string): string {
  return containsPath(workspace, path) && path !== workspace ? relative(workspace, path) : path
}

function parseShell(command: string): ShellParse {
  const state: ShellState = { segments: [[]], token: '', quote: undefined, opaque: false }
  for (let index = 0; index < command.length; index++) {
    index = shellStep(state, command, index)
  }
  endToken(state)
  return { segments: state.segments.filter((segment) => segment.length > 0), opaque: state.opaque }
}

function shellStep(state: ShellState, command: string, index: number): number {
  const character = command[index]!
  if (character === '\\' && state.quote !== "'") {
    state.token += command.slice(index, index + 2)
    return index + 1
  }
  if (state.quote) {
    state.token += character
    if (character === state.quote) state.quote = undefined
    else if (state.quote === '"' && startsSubstitution(command, index)) state.opaque = true
    return index
  }
  if (character === '"' || character === "'") {
    state.quote = character
    state.token += character
    return index
  }
  if (SHELL_OPAQUE.has(character) || startsSubstitution(command, index)) state.opaque = true
  const separator = SHELL_SEPARATORS.find((candidate) => command.startsWith(candidate, index))
  if (separator || /\s/u.test(character)) {
    endToken(state)
    if (separator) state.segments.push([])
    return index + (separator?.length ?? 1) - 1
  }
  state.token += character
  return index
}

function endToken(state: ShellState): void {
  if (!state.token) return
  state.segments.at(-1)!.push(state.token)
  state.token = ''
}

function startsSubstitution(command: string, index: number): boolean {
  return command[index] === '`' || (command[index] === '$' && command[index + 1] === '(')
}
