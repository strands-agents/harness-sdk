import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseRefOverrides, resolveTrackedSource } from '../../scripts/external-docs/cli'
import type { ExternalDocsProductConfig } from '../../scripts/external-docs/schema'

const temporaryDirectories: string[] = []
const REVISION_A = 'a'.repeat(40)
const REVISION_B = 'b'.repeat(40)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('external docs source resolution', () => {
  it('fetches the configured ref again for every build', () => {
    const { firstRevision, repository, sourceRoot, sourcesRoot } = createRepository()

    const first = resolveTrackedSource(productConfig(repository), sourcesRoot)
    expect(first.revision).toBe(firstRevision)
    expect(fs.readFileSync(path.join(first.root, 'docs/value.md'), 'utf-8')).toBe('first\n')

    writeSource(sourceRoot, 'second')
    const secondRevision = commit(sourceRoot, 'second')
    git(['-C', sourceRoot, 'push', 'origin', 'main'])

    const second = resolveTrackedSource(productConfig(repository), sourcesRoot)
    expect(second.revision).toBe(secondRevision)
    expect(second.revision).not.toBe(first.revision)
    expect(fs.readFileSync(path.join(second.root, 'docs/value.md'), 'utf-8')).toBe('second\n')
  }, 15_000)

  it('fetches an exact override without following a newer main revision', () => {
    const { firstRevision, repository, sourceRoot, sourcesRoot } = createRepository()
    writeSource(sourceRoot, 'second')
    commit(sourceRoot, 'second')
    git(['-C', sourceRoot, 'push', 'origin', 'main'])

    const source = resolveTrackedSource(productConfig(repository), sourcesRoot, firstRevision)

    expect(source.revision).toBe(firstRevision)
    expect(fs.readFileSync(path.join(source.root, 'docs/value.md'), 'utf-8')).toBe('first\n')
  }, 15_000)

  it('fails instead of reusing a stale checkout when main cannot be fetched', () => {
    const { repository, sourcesRoot } = createRepository()
    const first = resolveTrackedSource(productConfig(repository), sourcesRoot)
    fs.renameSync(`${repository}.git`, `${repository}.git.unavailable`)

    expect(() => resolveTrackedSource(productConfig(repository), sourcesRoot)).toThrow()
    expect(fs.existsSync(first.root)).toBe(false)
  }, 15_000)
})

describe('external docs ref overrides', () => {
  const productIds = ['strands-box', 'strands-decider']

  it('parses exact revisions for configured products', () => {
    expect(parseRefOverrides(`strands-box=${REVISION_A}, strands-decider=${REVISION_B}`, productIds)).toEqual(
      new Map([
        ['strands-box', REVISION_A],
        ['strands-decider', REVISION_B],
      ])
    )
  })

  it('rejects malformed revisions', () => {
    expect(() => parseRefOverrides('strands-box=main', productIds)).toThrow(/40-character lowercase commit SHA/)
  })

  it('rejects duplicate products', () => {
    expect(() => parseRefOverrides(`strands-box=${REVISION_A},strands-box=${REVISION_B}`, productIds)).toThrow(
      /duplicate product "strands-box"/
    )
  })

  it('rejects unknown products', () => {
    expect(() => parseRefOverrides(`other-product=${REVISION_A}`, productIds)).toThrow(
      /unknown product "other-product"/
    )
  })
})

function createRepository(): {
  firstRevision: string
  repository: string
  sourceRoot: string
  sourcesRoot: string
} {
  const root = temporaryDirectory()
  const sourceRoot = path.join(root, 'source')
  const repository = path.join(root, 'external-docs')
  const sourcesRoot = path.join(root, 'checkouts')
  git(['init', '--initial-branch=main', sourceRoot])
  git(['-C', sourceRoot, 'config', 'user.name', 'External Docs Test'])
  git(['-C', sourceRoot, 'config', 'user.email', 'external-docs@example.com'])

  writeSource(sourceRoot, 'first')
  const firstRevision = commit(sourceRoot, 'first')
  git(['clone', '--bare', sourceRoot, `${repository}.git`])
  git(['-C', sourceRoot, 'remote', 'add', 'origin', `${repository}.git`])
  return { firstRevision, repository, sourceRoot, sourcesRoot }
}

function productConfig(repository: string): ExternalDocsProductConfig {
  return {
    id: 'strands-box',
    repository,
    ref: 'main',
    manifest: 'docs/site-manifest.json',
    routePrefix: 'docs/user-guide/box',
    navLabel: 'Box',
    publicationStatus: 'stable',
  }
}

function writeSource(root: string, value: string): void {
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs/value.md'), `${value}\n`, 'utf-8')
}

function commit(root: string, message: string): string {
  git(['-C', root, 'add', 'docs/value.md'])
  git(['-C', root, 'commit', '-m', message])
  return git(['-C', root, 'rev-parse', 'HEAD'])
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'external-docs-cli-'))
  temporaryDirectories.push(directory)
  return directory
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
