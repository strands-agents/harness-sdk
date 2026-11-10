#!/usr/bin/env node
// Analyze a working tree for cognitive complexity and report the labels a PR
// would receive.
//
// This is the entry point behind `npm run complexity` and `hatch run
// complexity`, and the same script CI invokes, so a contributor sees locally
// exactly what the labeler will apply.
//
// Analysis is read-only: the SDK sources are parsed, never imported or
// executed, which is what makes it safe to run against an untrusted PR.
//
// Usage: run-analysis.mjs [--base <ref>] [--json <out>] [--root <dir>]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAnalyzable } from './classify.mjs'
import { buildReport, formatReport } from './report.mjs'
import { parseSarif } from './complexity-python.mjs'
import { loadEngine, analyzeTypescriptFiles } from './complexity-typescript.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * Where the pinned analyzers live. In CI this points at the base revision's
 * install so a PR cannot substitute its own analyzer; locally it defaults to
 * the checked-in tools directory.
 */
const TOOLS_DIR = process.env.PR_METRICS_TOOLS_DIR
  ? path.resolve(process.env.PR_METRICS_TOOLS_DIR)
  : path.join(SCRIPT_DIR, 'tools')

function parseArgs(argv) {
  const args = { base: 'origin/main', root: process.cwd(), json: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') args.base = argv[++i]
    else if (argv[i] === '--json') args.json = argv[++i]
    else if (argv[i] === '--root') args.root = path.resolve(argv[++i])
  }
  return args
}

function git(root, ...args) {
  // quotePath=false keeps non-ASCII paths literal instead of octal-escaped and
  // quoted, so they match the paths the analyzers report.
  // stderr piped, not inherited: probing a file absent at the base revision is
  // routine and must not leak "fatal:" noise into the report.
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Merge base, so a stale branch is not blamed for changes that landed on main. */
function mergeBase(root, base) {
  try {
    return git(root, 'merge-base', base, 'HEAD').trim()
  } catch {
    // No merge base (shallow clone, unrelated histories, or a ref this clone
    // lacks). Fall back to the ref itself, but only if git can resolve it —
    // otherwise every later git call fails with an opaque error.
    try {
      git(root, 'rev-parse', '--verify', `${base}^{commit}`)
      return base
    } catch {
      throw new Error(
        `cannot resolve a diff base from '${base}': it is neither mergeable with HEAD nor a known commit. ` +
          'Pass --base <ref> with a ref this clone contains.'
      )
    }
  }
}

/**
 * Files the range changes, with their churn.
 *
 * `-z` is what makes renames usable. In the default text format a rename is
 * reported as the single combined path `dir/{old.py => new.py}`, which matches
 * none of the classification patterns, so a renamed test would count toward the
 * size bucket and a renamed source file would never be analyzed. With `-z`, git
 * emits the old and new paths as separate NUL-delimited fields, and the churn
 * reflects only the lines that actually changed rather than the whole file.
 * `-z` also stops git quoting paths with spaces or non-ASCII bytes.
 */
export function changedFiles(root, from) {
  return parseNumstatZ(git(root, 'diff', '--numstat', '-z', from, '--'))
}

/**
 * Parse `git diff --numstat -z` output.
 *
 * Records are NUL-delimited. A normal change is "adds\tdels\tpath"; a rename or
 * copy is "adds\tdels\t" followed by the old path and the new path as two
 * further NUL-delimited fields.
 */
export function parseNumstatZ(numstat) {
  const files = []
  const fields = numstat.split('\0')

  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i]
    if (!record) continue

    // Only the first two tabs are delimiters, since only the counts are
    // guaranteed tab-free. Splitting on every tab would read a path that itself
    // begins with a tab as a rename record — whose third field is also empty —
    // and the skip below would then swallow the next two files.
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (secondTab < 0) continue

    const additions = record.slice(0, firstTab)
    const deletions = record.slice(firstTab + 1, secondTab)
    let filePath = record.slice(secondTab + 1)

    if (filePath === '') {
      // Rename or copy: skip the old path, keep the new one.
      i += 2
      filePath = fields[i]
    }
    if (!filePath) continue

    files.push({
      path: filePath,
      // "-" marks a binary file, which has no reviewable line count.
      additions: additions === '-' ? 0 : Number(additions),
      deletions: deletions === '-' ? 0 : Number(deletions),
    })
  }
  return files
}

/**
 * Run an analyzer, reporting whether its output can be trusted.
 *
 * `okStatuses` lists the exit codes that still mean "ran and produced a report",
 * since both analyzers use a non-zero exit to report findings. Anything else — a
 * missing binary (no status at all), a signal, or a fatal configuration error —
 * means the report is absent or partial and must not be read as "no findings".
 */
function run(cmd, args, okStatuses, options = {}) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    return true
  } catch (error) {
    if (!Number.isInteger(error.status)) return false
    return okStatuses.includes(error.status)
  }
}

function analyzePython(root, tmp, pythonFiles) {
  if (pythonFiles.length === 0) return []
  const sarif = path.join(tmp, 'python.sarif')
  const ok = run(
    'complexipy',
    [
      '--quiet',
      // Report every function, not just those over a threshold; the labeler
      // decides the bucket. SARIF is the only format carrying line ranges.
      '--ignore-complexity',
      '--max-complexity-allowed',
      '0',
      '--output-format',
      'sarif',
      '--output',
      sarif,
      ...pythonFiles,
    ],
    // complexipy exits 1 when any function exceeds the (zero) threshold, which
    // is every run; the report is still written.
    [1],
    { cwd: root }
  )
  if (!ok || !fs.existsSync(sarif)) {
    console.error('warning: complexipy did not produce a report; skipping Python complexity')
    console.error('         run: pip install -r .github/scripts/pr-metrics/tools/requirements.txt')
    return []
  }
  return parseSarif(JSON.parse(fs.readFileSync(sarif, 'utf8')), root)
}

/**
 * Score the merge-base versions of the changed source files.
 *
 * A touched function counts toward the label only if the PR increased its
 * score, so editing inside an already complex function without making it
 * worse inherits nothing. Returns `file::name` -> base complexity. A file
 * with no base version (new or renamed) yields no entries, so its functions
 * count in full as new code.
 */
function baseline(root, tmp, from, pythonFiles, tsFiles, engine) {
  const map = new Map()
  const baseDir = path.join(tmp, 'base')
  const extract = (files) => {
    const extracted = []
    for (const file of files) {
      let content
      try {
        content = git(root, 'show', `${from}:${file}`)
      } catch {
        continue
      }
      const dest = path.join(baseDir, file)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, content)
      extracted.push(dest)
    }
    return extracted
  }
  const add = (fns) => {
    for (const fn of fns) {
      const key = `${fn.file}::${fn.name}`
      // Names are qualified (Class::method) and nested functions fold into
      // their parent, so a collision requires a module-level redefinition;
      // keeping the max under-counts, the safe direction.
      map.set(key, Math.max(map.get(key) ?? 0, fn.complexity))
    }
  }

  const basePy = extract(pythonFiles)
  if (basePy.length > 0) {
    const sarif = path.join(tmp, 'python-base.sarif')
    const ok = run(
      'complexipy',
      [
        '--quiet',
        '--ignore-complexity',
        '--max-complexity-allowed',
        '0',
        '--output-format',
        'sarif',
        '--output',
        sarif,
        ...basePy,
      ],
      [1],
      { cwd: baseDir }
    )
    if (ok && fs.existsSync(sarif)) {
      add(parseSarif(JSON.parse(fs.readFileSync(sarif, 'utf8')), baseDir))
    } else {
      // No baseline means touched functions count in full; wrong labels are
      // worse than the old behavior, so warn and continue.
      console.error('warning: complexipy failed on the base revision; python complexity falls back to absolute scoring')
    }
  }

  const baseTs = extract(tsFiles)
  if (baseTs.length > 0 && engine) {
    add(analyzeTypescriptFiles(engine, baseTs, baseDir))
  }
  return map
}

function analyzeTypescript(engine, root, tsFiles) {
  if (tsFiles.length === 0 || !engine) return []
  return analyzeTypescriptFiles(
    engine,
    tsFiles.map((f) => path.join(root, f)),
    root
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const from = mergeBase(args.root, args.base)
  const files = changedFiles(args.root, from)
  // Rename detection stays on to match changedFiles(): a renamed file then
  // reports only its genuinely changed lines, instead of every line looking
  // added and every pre-existing function counting as touched.
  const diff = git(args.root, 'diff', '-U0', from, '--')

  // Analyze only files the PR touches that still exist in the head revision.
  // isAnalyzable is the same predicate the report uses, so a file is never
  // analyzed only to be discarded later.
  const present = files
    .map((f) => f.path)
    .filter(isAnalyzable)
    .filter((p) => fs.existsSync(path.join(args.root, p)))
  const pythonFiles = present.filter((p) => p.endsWith('.py'))
  const tsFiles = present.filter((p) => !p.endsWith('.py'))

  let engine = null
  if (tsFiles.length > 0) {
    try {
      engine = loadEngine(TOOLS_DIR)
    } catch {
      console.error(
        `warning: complexity analyzers not installed in ${TOOLS_DIR}; skipping TypeScript complexity\n` +
          '         run: npm ci --ignore-scripts --prefix .github/scripts/pr-metrics/tools'
      )
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-complexity-'))
  try {
    const base = baseline(args.root, tmp, from, pythonFiles, tsFiles, engine)
    const functions = [
      ...analyzePython(args.root, tmp, pythonFiles),
      ...analyzeTypescript(engine, args.root, tsFiles),
    ].map((fn) => ({ ...fn, baseComplexity: base.get(`${fn.file}::${fn.name}`) ?? null }))
    const report = buildReport({ diff, files, functions })
    if (args.json) fs.writeFileSync(args.json, JSON.stringify(report))
    console.log(formatReport(report))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Whether `moduleUrl` is the entry script `argvPath` names. Compares realpaths
 * as file URLs: `import.meta.url` is percent-encoded and symlink-resolved
 * (macOS /tmp -> /private/tmp), so comparing raw paths silently never runs
 * main() from a symlinked or space-containing checkout.
 */
export function isMainModule(argvPath, moduleUrl) {
  if (!argvPath) return false
  try {
    return pathToFileURL(fs.realpathSync(argvPath)).href === moduleUrl
  } catch {
    return false
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  await main()
}
