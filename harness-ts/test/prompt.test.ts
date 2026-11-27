import { describe, expect, it } from 'vitest'

import { HARNESS_CONTRACT, buildSystemPrompt } from '../src/prompt.js'

describe('buildSystemPrompt', () => {
  it('returns the contract only by default', () => {
    expect(buildSystemPrompt()).toBe(HARNESS_CONTRACT)
  })

  it('appends instructions after the contract', () => {
    const prompt = buildSystemPrompt('You are a SQL assistant.')
    expect(prompt.startsWith(HARNESS_CONTRACT)).toBe(true)
    expect(prompt.endsWith('You are a SQL assistant.')).toBe(true)
  })

  it('appends context parts last, in order', () => {
    const prompt = buildSystemPrompt('domain block', ['Current time: noon', 'Repo: acme'])
    expect(prompt.indexOf('domain block')).toBeLessThan(prompt.indexOf('Current time: noon'))
    expect(prompt.indexOf('Current time: noon')).toBeLessThan(prompt.indexOf('Repo: acme'))
  })
})
