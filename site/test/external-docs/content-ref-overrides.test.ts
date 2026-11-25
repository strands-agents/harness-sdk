import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  parseExactShaOverrides,
  resolveProductionContentRefs,
  serializeExactShaOverrides,
} from '../../scripts/content-ref-overrides'

const REVISION_A = 'a'.repeat(40)
const REVISION_B = 'b'.repeat(40)
const REVISION_C = 'c'.repeat(40)
const EXTERNAL_PRODUCT_IDS = ['strands-box', 'strands-decider']
const siteRoot = fileURLToPath(new URL('../../', import.meta.url))
const resolverPath = fileURLToPath(new URL('../../scripts/content-ref-overrides.ts', import.meta.url))
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('exact SHA overrides', () => {
  it('parses configured sources and trims comma-separated entries', () => {
    expect(
      parseExactShaOverrides(
        `samples=${REVISION_A}, strands-box=${REVISION_B}`,
        ['samples', ...EXTERNAL_PRODUCT_IDS],
        'CONTENT_REF_OVERRIDES'
      )
    ).toEqual(
      new Map([
        ['samples', REVISION_A],
        ['strands-box', REVISION_B],
      ])
    )
  })

  it.each([
    ['malformed entry', `samples=${REVISION_A},`],
    ['missing revision', 'samples='],
    ['branch name', 'samples=main'],
    ['uppercase SHA', `samples=${REVISION_A.toUpperCase()}`],
  ])('rejects a %s', (_label, input) => {
    expect(() => parseExactShaOverrides(input, ['samples', ...EXTERNAL_PRODUCT_IDS], 'CONTENT_REF_OVERRIDES')).toThrow()
  })

  it('rejects duplicate and unknown sources', () => {
    expect(() =>
      parseExactShaOverrides(
        `samples=${REVISION_A},samples=${REVISION_B}`,
        ['samples', ...EXTERNAL_PRODUCT_IDS],
        'CONTENT_REF_OVERRIDES'
      )
    ).toThrow(/duplicate source "samples"/)
    expect(() =>
      parseExactShaOverrides(`other=${REVISION_A}`, ['samples', ...EXTERNAL_PRODUCT_IDS], 'CONTENT_REF_OVERRIDES')
    ).toThrow(/unknown source "other"/)
  })

  it('serializes overrides in configured order', () => {
    const overrides = new Map([
      ['strands-decider', REVISION_C],
      ['strands-box', REVISION_B],
    ])

    expect(serializeExactShaOverrides(overrides, EXTERNAL_PRODUCT_IDS)).toBe(
      `strands-box=${REVISION_B},strands-decider=${REVISION_C}`
    )
  })

  it('refuses to serialize an unchecked revision', () => {
    expect(() => serializeExactShaOverrides(new Map([['strands-box', 'main']]), EXTERNAL_PRODUCT_IDS)).toThrow(
      /override for "strands-box" must be a 40-character lowercase commit SHA/
    )
  })
})

describe('production content refs', () => {
  it('defaults every source to main when no overrides are supplied', () => {
    expect(resolveProductionContentRefs(undefined, EXTERNAL_PRODUCT_IDS)).toEqual({
      samplesRef: 'main',
      externalDocsRefOverrides: '',
    })
  })

  it('resolves Samples and external products through one input', () => {
    expect(
      resolveProductionContentRefs(
        `samples=${REVISION_A},strands-box=${REVISION_B},strands-decider=${REVISION_C}`,
        EXTERNAL_PRODUCT_IDS
      )
    ).toEqual({
      samplesRef: REVISION_A,
      externalDocsRefOverrides: `strands-box=${REVISION_B},strands-decider=${REVISION_C}`,
    })
  })

  it('can override only Samples', () => {
    expect(resolveProductionContentRefs(`samples=${REVISION_A}`, EXTERNAL_PRODUCT_IDS)).toEqual({
      samplesRef: REVISION_A,
      externalDocsRefOverrides: '',
    })
  })

  it('keeps unspecified sources on main', () => {
    expect(resolveProductionContentRefs(`strands-box=${REVISION_B}`, EXTERNAL_PRODUCT_IDS)).toEqual({
      samplesRef: 'main',
      externalDocsRefOverrides: `strands-box=${REVISION_B}`,
    })
  })

  it('reserves the Samples source ID', () => {
    expect(() => resolveProductionContentRefs(undefined, ['samples'])).toThrow(
      /external docs product id "samples" is reserved/
    )
  })
})

describe('production content refs command', () => {
  it('writes the validated Samples and external docs outputs for GitHub Actions', () => {
    const outputPath = path.join(temporaryDirectory(), 'github-output')
    const result = runResolver({
      CONTENT_REF_OVERRIDES: `samples=${REVISION_A},strands-box=${REVISION_B}`,
      GITHUB_OUTPUT: outputPath,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe(
      `samples_ref=${REVISION_A}\nexternal_docs_ref_overrides=strands-box=${REVISION_B}\n`
    )
  })

  it('fails when GitHub Actions does not provide an output file', () => {
    const result = runResolver({ CONTENT_REF_OVERRIDES: '', GITHUB_OUTPUT: '' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('GITHUB_OUTPUT is required to resolve production content refs')
  })
})

function runResolver(environment: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', resolverPath], {
    cwd: siteRoot,
    encoding: 'utf-8',
    env: { ...process.env, ...environment },
  })
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'content-ref-overrides-'))
  temporaryDirectories.push(directory)
  return directory
}
