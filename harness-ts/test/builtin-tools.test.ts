import { describe, expect, it } from 'vitest'

import { builtinToolConfig, enabledBuiltinTools, resolveBuiltinTools, webSearchExplicit } from '../src/builtin-tools.js'
import { BUILTIN_TOOL_CONFIG_KEYS, BUILTIN_TOOL_NAMES, normalizeHarnessAgentConfig } from '../src/config.js'
import { DEFAULT_BUILTIN_TOOLS } from '../src/defaults.js'

describe('resolveBuiltinTools', () => {
  it('selects the defaults when undefined', () => {
    expect(enabledBuiltinTools(resolveBuiltinTools(undefined))).toEqual([...DEFAULT_BUILTIN_TOOLS])
  })

  it('pins a list exactly', () => {
    const resolved = resolveBuiltinTools(['read', 'shell'])
    expect(enabledBuiltinTools(resolved)).toEqual(['shell', 'read'])
    expect(resolved.web_fetch).toBe(false)
    expect(resolved.subagent).toBe(false)
  })

  it('resolves every built-in name in the record', () => {
    expect(Object.keys(resolveBuiltinTools([])).sort()).toEqual([...BUILTIN_TOOL_NAMES].sort())
  })

  it('edits the defaults with a mapping', () => {
    const resolved = resolveBuiltinTools({ subagent: false, web_search: true })
    expect(resolved.subagent).toBe(false)
    expect(resolved.web_search).toBe(true)
    expect(resolved.shell).toBe(true)
    expect(resolved.read).toBe(true)
  })

  it('starts from nothing when "*" is false', () => {
    const resolved = resolveBuiltinTools({ '*': false, read: true })
    expect(enabledBuiltinTools(resolved)).toEqual(['read'])
  })

  it('treats "*": true as the defaults', () => {
    expect(resolveBuiltinTools({ '*': true })).toEqual(resolveBuiltinTools(undefined))
  })

  it('keeps a per-tool web_fetch config', () => {
    const resolved = resolveBuiltinTools({ web_fetch: { model: 'openai/gpt-5-mini', transport: 'direct' } })
    expect(builtinToolConfig(resolved, 'web_fetch')).toEqual({ model: 'openai/gpt-5-mini', transport: 'direct' })
  })

  it('reports an empty web_fetch config when enabled without one and none when off', () => {
    expect(builtinToolConfig(resolveBuiltinTools(undefined), 'web_fetch')).toEqual({})
    expect(builtinToolConfig(resolveBuiltinTools({ web_fetch: false }), 'web_fetch')).toBeUndefined()
  })

  it('rejects an unknown name in a list', () => {
    expect(() => resolveBuiltinTools(['grep'] as never)).toThrow('Unknown built-in tool "grep"')
  })

  it('rejects an unknown name in a mapping', () => {
    expect(() => resolveBuiltinTools({ grep: true } as never)).toThrow('Unknown built-in tool "grep"')
  })

  it.each([
    ['shell', { description: 'Run a command in the sandbox.' }],
    ['programmatic_tool_caller', { allowedTools: ['read'], timeout: 60 }],
    ['subagent', { maxDepth: 1 }],
  ] as const)('keeps a per-tool %s config', (name, config) => {
    const resolved = resolveBuiltinTools({ [name]: config })
    expect(builtinToolConfig(resolved, name)).toEqual(config)
    expect(builtinToolConfig(resolveBuiltinTools({ [name]: true }), name)).toEqual({})
    expect(builtinToolConfig(resolveBuiltinTools({ [name]: false }), name)).toBeUndefined()
  })

  it('pins the configurable tools and their keys', () => {
    expect(BUILTIN_TOOL_CONFIG_KEYS).toEqual({
      read: ['media'],
      shell: ['description'],
      web_fetch: ['model', 'transport'],
      programmatic_tool_caller: ['allowedTools', 'timeout'],
      subagent: ['maxDepth'],
    })
  })

  it.each(Object.entries(BUILTIN_TOOL_CONFIG_KEYS))('derives the %s keys from its config schema', (name, keys) => {
    for (const key of keys) {
      expect(() => normalizeHarnessAgentConfig({ builtinTools: { [name]: { [key]: 'bogus' } } })).not.toThrow(
        'has unknown keys'
      )
    }
    expect(() => normalizeHarnessAgentConfig({ builtinTools: { [name]: { bogus: true } } })).toThrow(
      `builtinTools.${name} has unknown keys: bogus. Allowed: ${keys.join(', ')}.`
    )
  })

  it.each(['write', 'edit'] as const)('rejects a config object on %s, which takes none', (name) => {
    expect(() => resolveBuiltinTools({ [name]: {} } as never)).toThrow(
      `Built-in tool "${name}" takes no config; pass true or false.`
    )
  })

  it('accepts only a boolean or "exa" for web_search', () => {
    expect(() => resolveBuiltinTools({ web_search: { fallback: 'exa' } } as never)).toThrow(
      'builtinTools.web_search must be a boolean or \'exa\', got {"fallback":"exa"}.'
    )
    expect(() => resolveBuiltinTools({ web_search: 'bing' } as never)).toThrow(
      'builtinTools.web_search must be a boolean or \'exa\', got "bing".'
    )
    expect(resolveBuiltinTools({ web_search: 'exa' }).web_search).toBe('exa')
  })

  it.each(Object.entries(BUILTIN_TOOL_CONFIG_KEYS))('rejects an unknown %s config key', (name, keys) => {
    expect(() => resolveBuiltinTools({ [name]: { bogus: 1 } } as never)).toThrow(
      `Unknown ${name} config keys: bogus. Allowed: ${keys.join(', ')}.`
    )
  })

  it('rejects a non-boolean value', () => {
    expect(() => resolveBuiltinTools({ read: 'yes' } as never)).toThrow('builtinTools.read must be a boolean')
  })

  it.each([true, false, 'read'])('rejects %j and points at [] for turning every built-in off', (value) => {
    expect(() => resolveBuiltinTools(value as never)).toThrow(
      `builtinTools must be a list of names or a mapping of name to boolean/config, got ${JSON.stringify(value)}; [] turns every built-in off.`
    )
  })

  it('rejects a non-boolean "*"', () => {
    expect(() => resolveBuiltinTools({ '*': 'all' } as never)).toThrow("builtinTools['*'] must be a boolean")
    expect(() => resolveBuiltinTools({ '*': null } as never)).toThrow("builtinTools['*'] must be a boolean, got null.")
  })
})

describe('webSearchExplicit', () => {
  it('is false for the defaults', () => {
    expect(webSearchExplicit(undefined)).toBe(false)
  })

  it('is true when named in a list or as a mapping key', () => {
    expect(webSearchExplicit(['read', 'web_search'])).toBe(true)
    expect(webSearchExplicit({ web_search: true })).toBe(true)
    expect(webSearchExplicit({ web_search: false })).toBe(true)
    expect(webSearchExplicit({ web_search: 'exa' })).toBe(true)
  })

  it('is false when a mapping leaves it alone', () => {
    expect(webSearchExplicit({ read: true })).toBe(false)
  })
})
