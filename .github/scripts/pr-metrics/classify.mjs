// Shared file classification and label thresholds for the PR size and
// complexity labelers.
//
// Both labelers must agree on what counts as a test, so the rules live here
// rather than being duplicated across workflows.

import fs from 'node:fs'
import path from 'node:path'

/**
 * A repo-relative, forward-slash path for a location an analyzer reported.
 *
 * Analyzers emit absolute paths (and complexipy a file:// URI), while the diff
 * is keyed by repo-relative paths; these must agree or every function looks
 * untouched. Symlinks are resolved on both sides so a symlinked checkout root
 * (/tmp -> /private/tmp on macOS) does not produce an escaping ../.. path.
 */
export function toRepoRelative(pathOrUri, repoRoot) {
  const filePath = pathOrUri.startsWith('file://') ? pathOrUri.slice('file://'.length) : pathOrUri
  if (!path.isAbsolute(filePath)) return filePath.split(path.sep).join('/')
  return path.relative(realpath(repoRoot), realpath(filePath)).split(path.sep).join('/')
}

function realpath(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** Test files. Excluded from the size bucket and never analyzed for complexity. */
const TEST_PATTERNS = [
  /(^|\/)tests?\//,
  /(^|\/)tests_integ\//,
  /(^|\/)__tests__\//,
  /(^|\/)__fixtures__\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.spec\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /(^|\/)conftest\.py$/,
]

/** Machine-generated files. A lockfile bump is not review effort. */
const GENERATED_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)uv\.lock$/,
  /\.lock$/,
  /\.snap$/,
  /(^|\/)dist\//,
  /(^|\/)build\//,
]

export const FileKind = {
  TEST: 'test',
  GENERATED: 'generated',
  DOCS: 'docs',
  SOURCE: 'source',
}

export function classify(path) {
  if (GENERATED_PATTERNS.some((re) => re.test(path))) return FileKind.GENERATED
  if (TEST_PATTERNS.some((re) => re.test(path))) return FileKind.TEST
  if (/\.(md|mdx)$/.test(path)) return FileKind.DOCS
  return FileKind.SOURCE
}

/** Files whose churn counts toward the size bucket. */
export function countsTowardSize(path) {
  const kind = classify(path)
  return kind === FileKind.SOURCE || kind === FileKind.DOCS
}

/**
 * Source files eligible for complexity analysis: the two SDKs' shipped source.
 * Docs tooling under site/ is intentionally out of scope.
 */
export function isAnalyzable(path) {
  if (classify(path) !== FileKind.SOURCE) return false
  if (/^strands-py\/src\/.*\.py$/.test(path)) return true
  if (/^strands-ts\/src\/.*\.[cm]?tsx?$/.test(path)) return true
  return false
}

/**
 * Size thresholds, in changed lines excluding tests and generated files.
 * Calibrated so `size/xl` flags roughly the top 2% of PRs.
 */
export const SIZE_THRESHOLDS = [
  ['size/xs', 20],
  ['size/s', 100],
  ['size/m', 500],
  ['size/l', 1000],
]
export const SIZE_OVERFLOW_LABEL = 'size/xl'

export function sizeLabel(lines) {
  for (const [label, max] of SIZE_THRESHOLDS) {
    if (lines <= max) return label
  }
  return SIZE_OVERFLOW_LABEL
}

/**
 * Cognitive complexity thresholds, applied to the single most complex function
 * the diff touches. 15 is Sonar's own default; `high` sits above the 96th
 * percentile of existing SDK functions.
 */
export const COMPLEXITY_THRESHOLDS = [
  ['complexity/low', 10],
  ['complexity/medium', 25],
]
export const COMPLEXITY_OVERFLOW_LABEL = 'complexity/high'

export function complexityLabel(maxComplexity) {
  for (const [label, max] of COMPLEXITY_THRESHOLDS) {
    if (maxComplexity <= max) return label
  }
  return COMPLEXITY_OVERFLOW_LABEL
}

/** Every label these workflows may apply. The labeler will not set anything else. */
export const ALL_MANAGED_LABELS = [
  ...SIZE_THRESHOLDS.map(([label]) => label),
  SIZE_OVERFLOW_LABEL,
  ...COMPLEXITY_THRESHOLDS.map(([label]) => label),
  COMPLEXITY_OVERFLOW_LABEL,
]
