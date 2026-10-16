import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { permissionRuleDecision, permissionScopes } from '../src/tui/permissions/rules.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('permission scopes', () => {
  it('offers shell word prefixes only for a single plain command', () => {
    expect(permissionScopes('shell', { command: 'npm run test -- --watch' }, '/w')).toEqual([
      { rule: 'shell(npm run test -- --watch)', label: 'npm run test -- --watch' },
      { rule: 'shell(npm run test *)', label: 'npm run test *' },
      { rule: 'shell(npm run *)', label: 'npm run *' },
      { rule: 'shell(npm *)', label: 'npm *' },
      { rule: 'shell', label: '* any command' },
    ])
    for (const command of ['git status && rm -rf build', 'echo $(whoami)', 'echo hi > ~/.bashrc']) {
      expect(permissionScopes('shell', { command }, '/w').map((scope) => scope.rule)).toEqual([
        `shell(${command})`,
        'shell',
      ])
    }
  })

  it('offers parent directories up to the workspace, saved as absolute paths', async () => {
    const workspace = await temporaryWorkspace()
    const path = join(workspace, 'src', 'tui', 'view', 'app.tsx')
    expect(permissionScopes('write', { path }, workspace)).toEqual([
      { rule: `write(${path})`, label: join('src', 'tui', 'view', 'app.tsx') },
      { rule: `write(${join(workspace, 'src', 'tui', 'view', '*')})`, label: join('src', 'tui', 'view', '*') },
      { rule: `write(${join(workspace, 'src', 'tui', '*')})`, label: join('src', 'tui', '*') },
      { rule: `write(${join(workspace, 'src', '*')})`, label: join('src', '*') },
      { rule: `write(${join(workspace, '*')})`, label: './* this project' },
      { rule: 'write', label: '* any file' },
    ])
  })

  it('offers URL path prefixes down to the host', () => {
    expect(permissionScopes('web_fetch', { url: 'https://docs.example.com/a/b' }, '/w')).toEqual([
      { rule: 'web_fetch(https://docs.example.com/a/b)', label: 'https://docs.example.com/a/b' },
      { rule: 'web_fetch(docs.example.com/a/*)', label: 'docs.example.com/a/*' },
      { rule: 'web_fetch(docs.example.com/*)', label: 'docs.example.com/*' },
      { rule: 'web_fetch', label: '* any URL' },
    ])
  })

  it('offers only the whole tool when it has no specific action', () => {
    expect(permissionScopes('mcp_search', { query: 'x' }, '/w')).toEqual([{ rule: 'mcp_search', label: '* any call' }])
  })
})

describe('permission rule decisions', () => {
  const decide = (toolName: string, input: Record<string, string>, allow: string[], deny: string[] = []) =>
    permissionRuleDecision(toolName, input, { allow, deny }, '/w')

  it('allows a compound command only when every part is covered', () => {
    expect(decide('shell', { command: 'git status && npm test' }, ['shell(git *)', 'shell(npm test)'])).toBe('allow')
    expect(decide('shell', { command: 'git status && rm -rf /' }, ['shell(git *)'])).toBeUndefined()
    expect(decide('shell', { command: 'git log $(rm -rf /)' }, ['shell(git *)'])).toBeUndefined()
    expect(decide('shell', { command: 'git log > out.txt' }, ['shell(git *)'])).toBeUndefined()
  })

  it('denies a command when any part matches a deny rule, ahead of allow rules', () => {
    expect(decide('shell', { command: 'ls; rm -rf build' }, ['shell'], ['shell(rm *)'])).toBe('deny')
    expect(decide('shell', { command: 'echo "rm -rf build"' }, ['shell'], ['shell(rm *)'])).toBe('allow')
  })

  it('matches path and URL prefixes on segment boundaries', () => {
    expect(decide('write', { path: '/w/src/a.ts' }, ['write(/w/src/*)'])).toBe('allow')
    expect(decide('write', { path: '/w/src-other/a.ts' }, ['write(/w/src/*)'])).toBeUndefined()
    expect(decide('web_fetch', { url: 'https://docs.example.com/a/b' }, ['web_fetch(docs.example.com/*)'])).toBe(
      'allow'
    )
    expect(decide('web_fetch', { url: 'https://docs.example.com.evil.io/' }, ['web_fetch(docs.example.com/*)'])).toBe(
      undefined
    )
  })

  it('treats a bare tool name as every call of that tool', () => {
    expect(decide('strands_config', { action: 'apply' }, ['strands_config'])).toBe('allow')
    expect(decide('strands_config', { action: 'apply' }, [], ['strands_config(apply)'])).toBe('deny')
    expect(decide('strands_config', { action: 'inspect' }, [], ['strands_config(apply)'])).toBeUndefined()
  })
})

async function temporaryWorkspace(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'strands-permission-rules-')))
  temporaryDirectories.push(directory)
  await mkdir(join(directory, 'src'), { recursive: true })
  return directory
}
