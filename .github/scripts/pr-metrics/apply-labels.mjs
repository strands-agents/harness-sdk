// Apply the size/* and complexity/* labels from an analysis artifact.
//
// Runs in the trusted half of the labeler with `pull-requests: write`, so the
// artifact is treated as hostile input throughout: it was produced by a job
// that ran contributor-controlled code.
//
//   - Label names are derived here from clamped integers, never read as strings
//     from the artifact, so an arbitrary label cannot be injected.
//   - The PR number is verified against the triggering run's head SHA, so one
//     PR cannot relabel another.
//   - Only labels in the managed namespace are added or removed, so labels set
//     by maintainers or other automation are left alone.

import fs from 'node:fs'
import path from 'node:path'
import {
  ALL_MANAGED_LABELS,
  SIZE_OVERFLOW_LABEL,
  COMPLEXITY_OVERFLOW_LABEL,
  sizeLabel,
  complexityLabel,
} from './classify.mjs'

// Guards against an artifact claiming an absurd count to force a bucket.
const MAX_REASONABLE_LINES = 10_000_000
const MAX_REASONABLE_COMPLEXITY = 100_000

/**
 * A non-negative integer from the artifact, or null.
 *
 * Requires an actual number: `Number(null)`, `Number(false)` and `Number([])` are
 * all 0, so coercing first would let a missing or malformed metric silently
 * become the smallest bucket instead of being rejected.
 */
function readNonNegativeInt(value, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) return null
  return value
}

/**
 * Recompute labels from the artifact's numbers. Deliberately ignores the
 * artifact's own `label` strings so only names from classify.mjs can be applied.
 */
export function labelsFromMetrics(metrics) {
  const labels = []

  const countedLines = readNonNegativeInt(metrics?.size?.countedLines, MAX_REASONABLE_LINES)
  if (countedLines !== null) labels.push(sizeLabel(countedLines))

  // null max complexity is legitimate: docs-only and test-only PRs touch no
  // analyzable function, so they get no complexity label at all.
  const rawComplexity = metrics?.complexity?.maxComplexity
  if (rawComplexity !== null && rawComplexity !== undefined) {
    const maxComplexity = readNonNegativeInt(rawComplexity, MAX_REASONABLE_COMPLEXITY)
    if (maxComplexity !== null) labels.push(complexityLabel(maxComplexity))
  }

  return labels
}

/** Resolve the PR this artifact belongs to, verifying it against the run's head SHA. */
export async function resolvePrNumber({ github, context, core, claimed }) {
  const run = context.payload.workflow_run
  const candidates = (run.pull_requests ?? []).map((pr) => pr.number)

  if (candidates.length === 0) {
    // Forks do not populate `pull_requests`, so search by head SHA instead.
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: context.repo.owner,
      repo: context.repo.repo,
      commit_sha: run.head_sha,
    })
    candidates.push(...data.map((pr) => pr.number))
  }

  if (candidates.length === 0) {
    if (claimed === null) {
      core.info(`no pull request found for head sha ${run.head_sha}`)
      return null
    }
    // Fork PRs reach here: they populate neither `workflow_run.pull_requests`
    // nor the commit-association API, since the head commit exists only in the
    // fork. Verify the claim directly instead — honoring it only when the
    // claimed PR's actual head is the commit this run analyzed, which makes the
    // metrics correct for that PR by definition.
    let head
    let headRepoId
    try {
      const { data } = await github.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: claimed,
      })
      head = data.head.sha
      // A commit object can be pushed into any repository, so the SHA alone only
      // proves the tree. The head repository is what pins the claim to this PR.
      headRepoId = data.head.repo?.id
    } catch (error) {
      // Only a 404 refutes the claim. Anything else (5xx, rate limit, network)
      // is a transient lookup failure — rethrow so the run fails visibly and
      // can be re-run, instead of silently skipping the labels.
      if (error.status === 404) {
        core.warning(`artifact claimed PR #${claimed}, which does not exist; not labeling`)
        return null
      }
      throw error
    }
    if (head === run.head_sha && headRepoId != null && headRepoId === run.head_repository?.id) return claimed
    core.warning(
      `artifact claimed PR #${claimed}, whose head ${head} (repo ${headRepoId}) does not match ` +
        `the run's ${run.head_sha} (repo ${run.head_repository?.id}); not labeling`
    )
    return null
  }
  // The artifact's claim is only honored if the API independently agrees the PR
  // is associated with this run's head commit.
  if (claimed !== null) {
    if (candidates.includes(claimed)) return claimed
    // A claim that fails verification means the artifact is not trustworthy
    // about its own identity; labeling some other PR instead would act on
    // known-bad input.
    core.warning(`artifact claimed PR #${claimed}, which is not associated with ${run.head_sha}; not labeling`)
    return null
  }
  // No claim (the analyze job skipped recording one). A single unambiguous
  // association is safe; more than one cannot be attributed with confidence.
  const unique = [...new Set(candidates)]
  if (unique.length > 1) {
    core.warning(`head sha ${run.head_sha} is associated with PRs ${unique.join(', ')}; not labeling`)
    return null
  }
  return unique[0]
}

export async function applyLabels({ github, context, core, workspace }) {
  const metricsDir = path.join(workspace, 'metrics')

  // The artifact was produced by a job that ran untrusted code, so malformed
  // content is expected rather than exceptional: warn and stop instead of
  // throwing an unhandled error that reads as a broken workflow.
  let metrics
  let claimed = null
  try {
    metrics = JSON.parse(fs.readFileSync(path.join(metricsDir, 'pr-metrics.json'), 'utf8'))
    const claimedRaw = fs.readFileSync(path.join(metricsDir, 'pr-number.txt'), 'utf8').trim()
    // Digits only: parseInt would accept "12abc", and a PR number is never signed.
    claimed = /^\d+$/.test(claimedRaw) ? readNonNegativeInt(Number(claimedRaw), Number.MAX_SAFE_INTEGER) : null
  } catch (error) {
    core.warning(`could not read the metrics artifact: ${error.message}`)
    return
  }

  const prNumber = await resolvePrNumber({ github, context, core, claimed })
  if (prNumber === null) return

  const desired = labelsFromMetrics(metrics)
  if (desired.length === 0) {
    core.warning('artifact contained no usable metrics; leaving labels unchanged')
    return
  }

  const identity = { owner: context.repo.owner, repo: context.repo.repo, issue_number: prNumber }
  const { data: current } = await github.rest.issues.listLabelsOnIssue(identity)
  const currentManaged = current.map((l) => l.name).filter((name) => ALL_MANAGED_LABELS.includes(name))

  // Remove only stale labels in our namespace, so re-runs are quiet and other
  // automation's labels survive.
  for (const name of currentManaged) {
    if (!desired.includes(name)) {
      await github.rest.issues.removeLabel({ ...identity, name })
      core.info(`removed ${name}`)
    }
  }
  const missing = desired.filter((name) => !currentManaged.includes(name))
  if (missing.length > 0) {
    await github.rest.issues.addLabels({ ...identity, labels: missing })
    core.info(`added ${missing.join(', ')}`)
  }

  await summarize({ core, metrics, desired })
}

/**
 * Escape text bound for the job summary.
 *
 * `core.summary` interpolates into HTML without escaping, and every string here
 * originates in the artifact — a PR-controlled file path can otherwise close the
 * surrounding tag and inject arbitrary markup into the trusted job's summary.
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** A count for display, or '?' when the artifact's value was not a usable integer. */
function displayInt(value, max) {
  const n = readNonNegativeInt(value, max)
  return n === null ? '?' : String(n)
}

/**
 * A summary table row with every cell escaped.
 *
 * `addTable` writes cell data into `<td>` unescaped, so escaping here rather
 * than at each call site keeps a future artifact-derived cell from regressing
 * silently.
 */
function summaryRow(cells) {
  return cells.map((cell) => escapeHtml(cell))
}

async function summarize({ core, metrics, desired }) {
  const { complexity } = metrics
  const counted = displayInt(metrics?.size?.countedLines, MAX_REASONABLE_LINES)
  const excluded = displayInt(metrics?.size?.excludedLines, MAX_REASONABLE_LINES)
  const maxComplexity = readNonNegativeInt(complexity?.maxComplexity, MAX_REASONABLE_COMPLEXITY)

  core.summary.addHeading('PR metrics', 3).addTable([
    [
      { data: 'Metric', header: true },
      { data: 'Label', header: true },
      { data: 'Detail', header: true },
    ],
    summaryRow([
      'Size',
      desired.find((l) => l.startsWith('size/')) ?? 'n/a',
      `${counted} lines counted, ${excluded} excluded (tests and generated files)`,
    ]),
    summaryRow([
      'Complexity',
      desired.find((l) => l.startsWith('complexity/')) ?? 'n/a',
      maxComplexity === null
        ? 'no SDK source functions touched'
        : maxComplexity === 0
          ? 'touched functions, none increased in complexity'
          : `max cognitive complexity ${maxComplexity} among functions this PR touches`,
    ]),
  ])

  const offenders = Array.isArray(complexity?.offenders) ? complexity.offenders : []
  if (desired.includes(COMPLEXITY_OVERFLOW_LABEL) && offenders.length > 0) {
    core.summary.addRaw('\nMost complex functions this PR touches:\n')
    core.summary.addCodeBlock(
      escapeHtml(
        offenders
          .slice(0, 10)
          .map(
            (fn) =>
              `${displayInt(fn?.complexity, MAX_REASONABLE_COMPLEXITY).padStart(4)}  ` +
              `${fn?.file}:${displayInt(fn?.startLine, MAX_REASONABLE_LINES)}  ${fn?.name}`
          )
          .join('\n')
      )
    )
  }
  if (desired.includes(SIZE_OVERFLOW_LABEL)) {
    core.summary.addRaw('\nThis PR is large enough that reviewers may ask for it to be split.\n')
  }
  await core.summary.write()
}
