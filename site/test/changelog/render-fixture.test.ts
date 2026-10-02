import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { renderMarkdown } from '../../scripts/changelog/render-markdown'
import type { ReleaseFile } from '../../scripts/changelog/types'

const here = dirname(fileURLToPath(import.meta.url))
const contentDir = resolve(here, '../../src/content/changelog')

describe('render-markdown byte-identical to committed fixtures', () => {
  it('reproduces sdk/python-v1.41.0.md exactly', () => {
    const committed = readFileSync(resolve(contentDir, 'sdk/python-v1.41.0.md'), 'utf8')
    // The file shape that produced it (read the committed file to fill these in
    // verbatim during implementation -- sdk/language/version/tag/date/urls and
    // the entries array, each entry with type/breaking/scope/areas/title/pr/
    // prUrl/commit/commitUrl/author).
    // Values transcribed verbatim from the committed file on this branch.
    // NOTE: releaseUrl is NOT percent-encoded (the API's html_url form), and
    // commit SHAs are quoted strings in the committed file.
    const file: ReleaseFile = {
      sdk: 'sdk',
      language: 'python',
      version: '1.41.0',
      tag: 'python/v1.41.0',
      date: '2026-05-21',
      releaseUrl: 'https://github.com/strands-agents/harness-sdk/releases/tag/python/v1.41.0',
      packageUrl: 'https://pypi.org/project/strands-agents/1.41.0/',
      entries: [
        {
          type: 'feat',
          breaking: false,
          scope: 'plugins',
          areas: ['multiagent'],
          title: 'add MultiAgentPlugin for Swarm and Graph orchestrators',
          pr: 2280,
          prUrl: 'https://github.com/strands-agents/sdk-python/pull/2280',
          commit: 'afb0dd9',
          commitUrl: 'https://github.com/strands-agents/sdk-python/commit/afb0dd9',
          author: 'zastrowm',
        },
        {
          type: 'feat',
          breaking: false,
          scope: null,
          areas: [],
          title: 'bump starlette dependency to 1.x',
          pr: 2297,
          prUrl: 'https://github.com/strands-agents/sdk-python/pull/2297',
          commit: '1232230',
          commitUrl: 'https://github.com/strands-agents/sdk-python/commit/1232230',
          author: 'pgrayy',
        },
        {
          type: 'feat',
          breaking: false,
          scope: 'bedrock',
          areas: ['model'],
          title: 'add TTL support to auto-injected tool and system/user cache points',
          pr: 2232,
          prUrl: 'https://github.com/strands-agents/sdk-python/pull/2232',
          commit: '46ce50b',
          commitUrl: 'https://github.com/strands-agents/sdk-python/commit/46ce50b',
          author: 'kpx-dev',
        },
        {
          type: 'fix',
          breaking: false,
          scope: 'tests',
          areas: [],
          title: 'add use_native_token_count=True when expected',
          pr: 2311,
          prUrl: 'https://github.com/strands-agents/sdk-python/pull/2311',
          commit: '64a6862',
          commitUrl: 'https://github.com/strands-agents/sdk-python/commit/64a6862',
          author: 'lizradway',
        },
      ],
      newContributors: [],
    }
    expect(renderMarkdown(file)).toBe(committed)
  })
})
