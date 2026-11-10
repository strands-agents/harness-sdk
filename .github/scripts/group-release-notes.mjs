#!/usr/bin/env node
// Group release-note commits by conventional-commit type.
//
// Reads `<short-hash><TAB><subject>` lines on stdin (one commit each, as
// produced by `git log --pretty=format:'%h%x09%s'`) and writes Markdown
// release notes to stdout, bucketed by conventional-commit type (`feat`,
// `fix`, `docs`, ...) instead of by author.
//
// The header is drawn from the `NEW_TAG` / `PREV_TAG` environment variables
// so the output matches the previous shortlog-based notes.
//
// Node port of group-release-notes.py; the two MUST produce byte-identical
// output so both SDKs' release notes read the same.

// Conventional-commit types in the order they should appear, mapped to
// their section headings. Types not listed here fall through to "Other".
const SECTIONS = [
  ['feat', '🚀 Features'],
  ['fix', '🐛 Fixes'],
  ['perf', '⚡ Performance'],
  ['refactor', '♻️ Refactoring'],
  ['docs', '📚 Documentation'],
  ['test', '✅ Tests'],
  ['build', '📦 Build'],
  ['ci', '👷 CI'],
  ['chore', '🔧 Chores'],
  ['revert', '⏪ Reverts'],
]
const SECTION_TITLES = new Set(SECTIONS.map(([key]) => key))
const OTHER_KEY = 'other'

// `type(optional scope)!: subject` — captures the type. The optional `!` and
// scope are conventional-commit syntax.
const COMMIT_RE = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.*)$/

// Return the section key for a commit subject line. Only the type is parsed
// off, for bucketing; the subject itself is kept verbatim (prefix included)
// by the caller so the rendered notes still show the `feat:` / `fix:`
// convention.
function classify(subject) {
  const match = COMMIT_RE.exec(subject)
  if (match && SECTION_TITLES.has(match[1])) {
    return match[1]
  }
  return OTHER_KEY
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const buckets = new Map()
  const input = await readStdin()
  for (const rawLine of input.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line) {
      continue
    }
    const tab = line.indexOf('\t')
    const shortHash = tab === -1 ? line : line.slice(0, tab)
    const subject = tab === -1 ? '' : line.slice(tab + 1)
    const key = classify(subject)
    if (!buckets.has(key)) {
      buckets.set(key, [])
    }
    buckets.get(key).push([shortHash, subject.trim()])
  }

  const newTag = process.env.NEW_TAG ?? ''
  const prevTag = process.env.PREV_TAG ?? ''

  const out = []
  out.push(`## ${newTag}`)
  out.push('')
  out.push(
    `_Auto-drafted from commits in \`${prevTag}..${newTag}\`, grouped by ` +
      'conventional-commit type. Edit on the release page after publish if ' +
      'you want a polished writeup; the canonical release notes live on the ' +
      'website._',
  )
  out.push('')

  // Known types first, in declared order; then the "Other" catch-all.
  for (const [key, title] of [...SECTIONS, [OTHER_KEY, '🔖 Other']]) {
    const commits = buckets.get(key)
    if (!commits || commits.length === 0) {
      continue
    }
    out.push(`### ${title}`)
    out.push('')
    for (const [shortHash, subject] of commits) {
      out.push(`- ${subject} (${shortHash})`)
    }
    out.push('')
  }

  if (buckets.size === 0) {
    out.push('_No commits in range._')
    out.push('')
  }

  process.stdout.write(out.join('\n').replace(/\s+$/, '') + '\n')
}

main()
