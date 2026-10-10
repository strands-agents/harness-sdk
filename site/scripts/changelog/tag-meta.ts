// Map a repo + release tag to changelog metadata, and build package-registry URLs.
// Pure, dependency-free. Mirrors site/src/config/changelog.ts (Plan 1 contract).

import type { TagMeta, Sdk, Language } from './types'

function cleanVersion(raw: string): string {
  // Strip a leading 'v' and any stray dot after it (handles 'v.1.2.0').
  return raw.replace(/^v\.?/, '')
}

/**
 * @param repo  e.g. 'strands-agents/harness-sdk' | 'strands-agents/evals'
 * @param tag   the release tag
 */
export function tagToMeta(repo: string, tag: string): TagMeta | null {
  const isEvals = repo.endsWith('/evals')
  if (isEvals) {
    // Evals is python-only; accept bare vX or python/vX.
    const m = tag.match(/(?:^|\/)v\.?(\d.*)$/)
    if (!m) return null
    return { sdk: 'evals', language: undefined, version: cleanVersion('v' + m[1]) }
  }
  // The archived pre-monorepo TypeScript repo: all its releases are
  // harness/typescript history (used only by the one-time backfill).
  if (repo.endsWith('/sdk-typescript')) {
    if (!/^v\.?\d/.test(tag)) return null
    return { sdk: 'sdk', language: 'typescript', version: cleanVersion(tag) }
  }
  // harness-sdk
  if (tag.startsWith('python-wasm/')) return null
  if (tag.startsWith('python/')) {
    return { sdk: 'sdk', language: 'python', version: cleanVersion(tag.slice('python/'.length)) }
  }
  if (tag.startsWith('typescript/')) {
    return { sdk: 'sdk', language: 'typescript', version: cleanVersion(tag.slice('typescript/'.length)) }
  }
  if (/^v\.?\d/.test(tag)) {
    return { sdk: 'sdk', language: 'python', version: cleanVersion(tag) }
  }
  return null
}

const pypi = (name: string, v: string) => `https://pypi.org/project/${name}/${v}/`
const npm = (name: string, v: string) => `https://www.npmjs.com/package/${name}/v/${v}`

export function getPackageUrl(sdk: Sdk, language: Language | undefined, version: string): string {
  if (sdk === 'evals') return pypi('strands-agents-evals', version)
  if (language === 'typescript') return npm('@strands-agents/sdk', version)
  return pypi('strands-agents', version)
}
