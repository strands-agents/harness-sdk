#!/usr/bin/env tsx
// CLI entry for the changelog generator. Generates/updates the changelog .md
// files in the working tree. Does NOT open a PR -- the workflow (or a developer
// running this locally) commits the resulting diff. Runnable locally:
//   tsx scripts/changelog/sync.ts --mode backfill
//   tsx scripts/changelog/sync.ts --tag python/v1.42.0
//   tsx scripts/changelog/sync.ts --check   (exit 1: a release has no file; 2: could not verify)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { run, findMissing } from './run'
import { makeClient } from './github-client'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function resolveToken(): string {
  // Prefer GITHUB_TOKEN env over --token: the --token CLI arg is visible via
  // `ps` and /proc on shared systems. Use GITHUB_TOKEN or `gh auth login`
  // instead; --token is supported but discouraged outside local dev.
  const explicit = arg('token') || process.env.GITHUB_TOKEN
  if (explicit) return explicit
  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim()
  } catch (e: any) {
    const detail = e.stderr ? String(e.stderr).trim() : e.message
    throw new Error(`No token: pass --token, set GITHUB_TOKEN, or run \`gh auth login\`. (gh error: ${detail})`)
  }
}

async function main() {
  const sourceRepo = arg('source-repo') || process.env.SOURCE_REPO || 'strands-agents/harness-sdk'
  const mode = (arg('mode') || process.env.MODE) === 'backfill' ? 'backfill' : 'single'
  const tag = arg('tag') || process.env.TAG || undefined
  const skipExisting = flag('skip-existing') || process.env.SKIP_EXISTING === 'true'

  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(here, '../../..') // scripts/changelog -> site -> repo root

  if (flag('check')) {
    const missing = await findMissing({
      repo: sourceRepo,
      client: makeClient(resolveToken(), (m) => console.warn(`warning: ${m}`)),
      exists: async (p) => existsSync(join(repoRoot, p)),
    }).catch((e) => {
      console.error(`changelog: could not verify ${sourceRepo}: ${e instanceof Error ? e.message : e}`)
      process.exit(2)
    })
    for (const m of missing) console.error(`changelog: ${sourceRepo} ${m.tag} has no ${m.path}`)
    if (missing.length) process.exit(1)
    console.log(`changelog: every ${sourceRepo} release has a changelog file`)
    return
  }

  if (mode === 'single' && !tag) {
    console.error('changelog: single mode requires --tag <release-tag> (or use --mode backfill).')
    process.exit(1)
  }

  const warnings: string[] = []
  const client = makeClient(resolveToken(), (m) => warnings.push(m))

  const result = await run({
    repo: sourceRepo,
    mode,
    tag,
    skipExisting,
    client,
    readExisting: async (p) => {
      try {
        return readFileSync(join(repoRoot, p), 'utf8')
      } catch {
        return null
      }
    },
    writeFile: async (p, contents) => {
      const full = join(repoRoot, p)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, contents)
    },
  })

  console.log(`changelog: wrote ${result.written.length} file(s)`)
  for (const w of [...warnings, ...result.warnings]) console.warn(`warning: ${w}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
