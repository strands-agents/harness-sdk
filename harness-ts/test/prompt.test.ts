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
    const prompt = buildSystemPrompt('domain block', ['Region: eu-west-1', 'Repo: acme'])
    expect(prompt.indexOf('domain block')).toBeLessThan(prompt.indexOf('Region: eu-west-1'))
    expect(prompt.indexOf('Region: eu-west-1')).toBeLessThan(prompt.indexOf('Repo: acme'))
  })
})
