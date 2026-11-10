// Tests for the PR metrics labeler: `npm run test:pr-metrics`
//
// Uses node:test so the suite runs with no install step. The TypeScript cases
// need the pinned compiler from tools/ and skip without it; `npm run
// complexity:setup` installs it.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { classify, FileKind, countsTowardSize, isAnalyzable, sizeLabel, complexityLabel } from './classify.mjs'
import { parseChangedLines, rangeTouched } from './diff.mjs'
import { buildReport } from './report.mjs'
import { escapeHtml, labelsFromMetrics, resolvePrNumber } from './apply-labels.mjs'
import { parseSarif } from './complexity-python.mjs'
import { loadEngine, analyzeTypescriptFiles } from './complexity-typescript.mjs'
import { isMainModule, parseNumstatZ } from './run-analysis.mjs'

test('classify separates tests from source', () => {
  assert.equal(classify('strands-py/src/strands/agent.py'), FileKind.SOURCE)
  assert.equal(classify('strands-py/tests/strands/test_agent.py'), FileKind.TEST)
  assert.equal(classify('strands-py/tests_integ/test_model.py'), FileKind.TEST)
  assert.equal(classify('strands-ts/src/agent/__tests__/agent.test.ts'), FileKind.TEST)
  assert.equal(classify('strands-ts/src/mcp/client.test.ts'), FileKind.TEST)
  assert.equal(classify('strands-py/src/strands/conftest.py'), FileKind.TEST)
  assert.equal(classify('site/src/content/docs/index.mdx'), FileKind.DOCS)
  assert.equal(classify('package-lock.json'), FileKind.GENERATED)
  assert.equal(classify('strands-py/uv.lock'), FileKind.GENERATED)
})

test('size counts source and docs but not tests or lockfiles', () => {
  assert.equal(countsTowardSize('strands-ts/src/agent/agent.ts'), true)
  assert.equal(countsTowardSize('site/src/content/docs/index.mdx'), true)
  assert.equal(countsTowardSize('strands-py/tests/test_agent.py'), false)
  assert.equal(countsTowardSize('package-lock.json'), false)
})

test('only SDK source is analyzed for complexity', () => {
  assert.equal(isAnalyzable('strands-py/src/strands/agent.py'), true)
  assert.equal(isAnalyzable('strands-ts/src/agent/agent.ts'), true)
  // Docs tooling and tests are out of scope even though they are real code.
  assert.equal(isAnalyzable('site/src/scripts/build.ts'), false)
  assert.equal(isAnalyzable('strands-py/tests/test_agent.py'), false)
  assert.equal(isAnalyzable('strands-ts/src/agent/__tests__/agent.test.ts'), false)
})

test('label thresholds sit on documented boundaries', () => {
  assert.equal(sizeLabel(20), 'size/xs')
  assert.equal(sizeLabel(21), 'size/s')
  assert.equal(sizeLabel(1000), 'size/l')
  assert.equal(sizeLabel(1001), 'size/xl')
  assert.equal(complexityLabel(10), 'complexity/low')
  assert.equal(complexityLabel(11), 'complexity/medium')
  assert.equal(complexityLabel(25), 'complexity/medium')
  assert.equal(complexityLabel(26), 'complexity/high')
})

test('parseChangedLines tracks post-image line numbers', () => {
  const diff = [
    'diff --git a/a.py b/a.py',
    '--- a/a.py',
    '+++ b/a.py',
    '@@ -10,0 +11,2 @@',
    '+one',
    '+two',
    '@@ -30,1 +32,1 @@',
    '-old',
    '+new',
  ].join('\n')
  const changed = parseChangedLines(diff)
  assert.deepEqual(
    [...changed.get('a.py')].sort((x, y) => x - y),
    [11, 12, 32]
  )
})

test('parseChangedLines ignores pure deletions and deleted files', () => {
  const diff = [
    'diff --git a/gone.py b/gone.py',
    '--- a/gone.py',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-a',
    '-b',
    '-c',
  ].join('\n')
  assert.equal(parseChangedLines(diff).size, 0)
})

test('rangeTouched only matches overlapping ranges', () => {
  const lines = new Set([50])
  assert.equal(rangeTouched(lines, 40, 60), true)
  assert.equal(rangeTouched(lines, 50, 50), true)
  assert.equal(rangeTouched(lines, 51, 90), false)
  assert.equal(rangeTouched(undefined, 1, 10), false)
})

// The core guarantee: a pre-existing hotspot elsewhere in a touched file must
// not drive the label, or every PR touching that file is permanently 'high'.
test('complexity ignores untouched functions in a touched file', () => {
  const diff = [
    'diff --git a/strands-py/src/strands/m.py b/strands-py/src/strands/m.py',
    '--- a/strands-py/src/strands/m.py',
    '+++ b/strands-py/src/strands/m.py',
    '@@ -20,0 +21,1 @@',
    '+    pass',
  ].join('\n')
  const report = buildReport({
    diff,
    files: [{ path: 'strands-py/src/strands/m.py', additions: 1, deletions: 0 }],
    functions: [
      { file: 'strands-py/src/strands/m.py', name: 'simple', complexity: 4, startLine: 10, endLine: 30 },
      { file: 'strands-py/src/strands/m.py', name: 'monster', complexity: 90, startLine: 100, endLine: 400 },
    ],
  })
  assert.equal(report.complexity.maxComplexity, 4)
  assert.equal(report.complexity.label, 'complexity/low')
})

// Editing inside an already complex function without increasing its score must
// not inherit the function's whole score: a 47-score function touched by two
// trivial lines is the function's complexity, not the PR's.
test('complexity ignores touched functions whose score did not increase', () => {
  const diff = [
    'diff --git a/strands-py/src/strands/m.py b/strands-py/src/strands/m.py',
    '--- a/strands-py/src/strands/m.py',
    '+++ b/strands-py/src/strands/m.py',
    '@@ -200,0 +201,2 @@',
    '+    duration = timer()',
    '+    result.duration = duration',
  ].join('\n')
  const report = buildReport({
    diff,
    files: [{ path: 'strands-py/src/strands/m.py', additions: 2, deletions: 0 }],
    functions: [
      // touched, but at its watermark: excluded
      {
        file: 'strands-py/src/strands/m.py',
        name: 'hotspot',
        complexity: 47,
        startLine: 110,
        endLine: 327,
        baseComplexity: 47,
      },
    ],
  })
  // Measured but nothing increased is a verdict of zero added complexity,
  // which buckets as low; only "nothing measurable" yields no label.
  assert.equal(report.complexity.maxComplexity, 0)
  assert.equal(report.complexity.label, 'complexity/low')
  assert.deepEqual(report.complexity.offenders, [])
})

test('complexity counts touched functions that increased, at their head score', () => {
  const diff = [
    'diff --git a/strands-py/src/strands/m.py b/strands-py/src/strands/m.py',
    '--- a/strands-py/src/strands/m.py',
    '+++ b/strands-py/src/strands/m.py',
    '@@ -120,0 +121,3 @@',
    '+    if extra:',
    '+        if deeper:',
    '+            pass',
  ].join('\n')
  const report = buildReport({
    diff,
    files: [{ path: 'strands-py/src/strands/m.py', additions: 3, deletions: 0 }],
    functions: [
      // grew from 27 to 30: counts, and at the absolute head score
      {
        file: 'strands-py/src/strands/m.py',
        name: 'grew',
        complexity: 30,
        startLine: 110,
        endLine: 327,
        baseComplexity: 27,
      },
      // shrank from 12 to 9: excluded
      {
        file: 'strands-py/src/strands/m.py',
        name: 'shrank',
        complexity: 9,
        startLine: 1,
        endLine: 100,
        baseComplexity: 12,
      },
    ],
  })
  assert.equal(report.complexity.maxComplexity, 30)
  assert.equal(report.complexity.label, 'complexity/high')
  // The offenders list proves the exclusion: `shrank` must be absent, and
  // `grew` reports its head score, not its base.
  assert.deepEqual(report.complexity.offenders, [
    { file: 'strands-py/src/strands/m.py', name: 'grew', complexity: 30, startLine: 110 },
  ])
})

test('complexity counts functions without a baseline in full', () => {
  const diff = [
    'diff --git a/strands-ts/src/agent/n.ts b/strands-ts/src/agent/n.ts',
    '--- a/strands-ts/src/agent/n.ts',
    '+++ b/strands-ts/src/agent/n.ts',
    '@@ -5,0 +6,1 @@',
    '+  const x = 1',
  ].join('\n')
  const report = buildReport({
    diff,
    files: [{ path: 'strands-ts/src/agent/n.ts', additions: 1, deletions: 0 }],
    functions: [
      // No base version (new file), so it counts in full as new code
      { file: 'strands-ts/src/agent/n.ts', name: 'handler', complexity: 14, startLine: 1, endLine: 40 },
    ],
  })
  assert.equal(report.complexity.maxComplexity, 14)
  assert.equal(report.complexity.label, 'complexity/medium')
})

test('size excludes test churn from the bucket', () => {
  const report = buildReport({
    diff: '',
    files: [
      { path: 'strands-py/src/strands/agent.py', additions: 10, deletions: 5 },
      { path: 'strands-py/tests/test_agent.py', additions: 800, deletions: 100 },
      { path: 'package-lock.json', additions: 5000, deletions: 4000 },
    ],
    functions: [],
  })
  assert.equal(report.size.countedLines, 15)
  assert.equal(report.size.label, 'size/xs')
  assert.equal(report.size.totalLines, 9915)
})

test('a docs-only PR gets no complexity label', () => {
  const report = buildReport({
    diff: '',
    files: [{ path: 'site/src/content/docs/index.mdx', additions: 40, deletions: 2 }],
    functions: [],
  })
  assert.equal(report.complexity.label, null)
  assert.equal(report.size.label, 'size/s')
})

// The artifact comes from a job that ran untrusted code, so labels must be
// derived from its integers, never from any string it supplies.
test('labelsFromMetrics ignores artifact-supplied label strings', () => {
  const labels = labelsFromMetrics({
    size: { countedLines: 5, label: 'approved' },
    complexity: { maxComplexity: 3, label: 'lgtm; ship it' },
  })
  assert.deepEqual(labels, ['size/xs', 'complexity/low'])
})

test('labelsFromMetrics rejects malformed and out-of-range numbers', () => {
  assert.deepEqual(labelsFromMetrics({ size: { countedLines: -1 }, complexity: { maxComplexity: null } }), [])
  assert.deepEqual(labelsFromMetrics({ size: { countedLines: 1e12 }, complexity: { maxComplexity: null } }), [])
  assert.deepEqual(labelsFromMetrics({ size: { countedLines: 'ten' }, complexity: { maxComplexity: null } }), [])
  assert.deepEqual(labelsFromMetrics({ size: { countedLines: 1.5 }, complexity: { maxComplexity: null } }), [])
  // A valid size still applies when complexity is unusable.
  assert.deepEqual(labelsFromMetrics({ size: { countedLines: 10 }, complexity: { maxComplexity: 'x' } }), ['size/xs'])
})

// `git diff --numstat` reports a rename as the combined path `dir/{a => b}` in
// its text format, which matches none of the patterns below — a renamed test
// would count toward size and renamed source would go unanalyzed. changedFiles()
// uses -z, where the new path arrives as its own field; this pins the contract
// that classification only ever sees a plain path.
test('renamed paths resolve to plain paths, not brace notation', () => {
  assert.equal(classify('strands-ts/src/agent/__tests__/b.test.ts'), FileKind.TEST)
  assert.equal(countsTowardSize('strands-ts/src/agent/__tests__/b.test.ts'), false)
  assert.equal(isAnalyzable('strands-py/src/strands/agent2.py'), true)
  // The brace form must NOT be mistaken for analyzable source.
  assert.equal(isAnalyzable('strands-py/src/strands/{agent.py => agent2.py}'), false)
})

// Exercises the -z record parsing directly, rather than only asserting the
// contract it is supposed to satisfy. Records are built by joining on NUL so no
// escape sequence has to be embedded in a literal.
const numstatZ = (...records) => records.join('\0') + '\0'

test('parseNumstatZ keeps the new path of a rename and drops the old one', () => {
  const files = parseNumstatZ(numstatZ('9\t0\t', 'old/streaming.py', 'new/streaming.py'))
  assert.deepEqual(files, [{ path: 'new/streaming.py', additions: 9, deletions: 0 }])
})

test('parseNumstatZ does not treat a tab-leading path as a rename', () => {
  // A path beginning with a tab leaves an empty third tab-field, exactly like a
  // rename header; misreading it swallowed the next two files entirely.
  const files = parseNumstatZ(numstatZ('1\t0\t\tsneaky.py', '900\t0\ta.py', '900\t0\tb.py'))
  assert.deepEqual(files, [
    { path: '\tsneaky.py', additions: 1, deletions: 0 },
    { path: 'a.py', additions: 900, deletions: 0 },
    { path: 'b.py', additions: 900, deletions: 0 },
  ])
})

test('parseNumstatZ preserves a tab inside a path', () => {
  const files = parseNumstatZ(numstatZ('1\t0\tdir/ta\tb.py'))
  assert.deepEqual(files, [{ path: 'dir/ta\tb.py', additions: 1, deletions: 0 }])
})

test('parseNumstatZ reads binary files as zero churn', () => {
  assert.deepEqual(parseNumstatZ(numstatZ('-\t-\timage.png')), [{ path: 'image.png', additions: 0, deletions: 0 }])
})

test('parseNumstatZ handles a binary rename followed by a plain record', () => {
  const files = parseNumstatZ(numstatZ('-\t-\t', 'old.bin', 'new.bin', '2\t1\tplain.py'))
  assert.deepEqual(files, [
    { path: 'new.bin', additions: 0, deletions: 0 },
    { path: 'plain.py', additions: 2, deletions: 1 },
  ])
})

test('parseNumstatZ ignores empty and malformed records', () => {
  assert.deepEqual(parseNumstatZ(''), [])
  assert.deepEqual(parseNumstatZ(numstatZ('', '')), [])
  // Fewer than two tabs cannot be a numstat record.
  assert.deepEqual(parseNumstatZ(numstatZ('garbage')), [])
  assert.deepEqual(parseNumstatZ(numstatZ('1\tonly-one-tab')), [])
})

test('parseChangedLines is not fooled by an added line whose content starts with ++', () => {
  const diff = [
    'diff --git a/strands-py/src/strands/m.py b/strands-py/src/strands/m.py',
    '--- a/strands-py/src/strands/m.py',
    '+++ b/strands-py/src/strands/m.py',
    '@@ -5,0 +6,3 @@',
    '+# a comment',
    '++ b/nowhere.py',
    '+more code',
  ].join('\n')
  const changed = parseChangedLines(diff)
  assert.deepEqual([...changed.keys()], ['strands-py/src/strands/m.py'])
  assert.deepEqual(
    [...changed.get('strands-py/src/strands/m.py')].sort((x, y) => x - y),
    [6, 7, 8]
  )
})

test('parseChangedLines handles multiple files and a no-count hunk header', () => {
  const diff = [
    'diff --git a/a.py b/a.py',
    '--- a/a.py',
    '+++ b/a.py',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/b.py b/b.py',
    '--- a/b.py',
    '+++ b/b.py',
    '@@ -10,0 +11,1 @@',
    '+added',
  ].join('\n')
  const changed = parseChangedLines(diff)
  assert.deepEqual([...changed.get('a.py')], [1])
  assert.deepEqual([...changed.get('b.py')], [11])
})

test('parseChangedLines ignores the no-newline marker', () => {
  const diff = [
    'diff --git a/a.py b/a.py',
    '--- a/a.py',
    '+++ b/a.py',
    '@@ -1 +1,2 @@',
    ' first',
    '+second',
    '\\ No newline at end of file',
  ].join('\n')
  assert.deepEqual([...parseChangedLines(diff).get('a.py')], [2])
})

test('parseChangedLines keeps paths containing spaces intact', () => {
  const diff = [
    'diff --git a/dir/we ird.py b/dir/we ird.py',
    '--- a/dir/we ird.py',
    // git appends a tab after a path containing whitespace.
    '+++ b/dir/we ird.py\t',
    '@@ -0,0 +1 @@',
    '+x = 1',
  ].join('\n')
  assert.deepEqual([...parseChangedLines(diff).get('dir/we ird.py')], [1])
})

// The artifact is produced by a job that ran untrusted code. Number(null) is 0,
// so coercing before validating would turn a missing metric into size/xs.
test('labelsFromMetrics rejects falsy non-numbers instead of reading them as 0', () => {
  assert.deepEqual(labelsFromMetrics({ size: { countedLines: null }, complexity: { maxComplexity: false } }), [])
  assert.deepEqual(labelsFromMetrics({ size: { countedLines: [] }, complexity: { maxComplexity: '' } }), [])
  assert.deepEqual(labelsFromMetrics({ size: { countedLines: '0' }, complexity: { maxComplexity: null } }), [])
  // A real zero is still a valid measurement.
  assert.deepEqual(labelsFromMetrics({ size: { countedLines: 0 }, complexity: { maxComplexity: 0 } }), [
    'size/xs',
    'complexity/low',
  ])
})

// core.summary interpolates into HTML without escaping, and a PR controls its
// own file paths, so an unescaped path could close the surrounding tag and
// inject markup into the trusted labeling job's summary.
test('escapeHtml neutralizes markup in artifact-supplied paths', () => {
  assert.equal(escapeHtml('</code></pre><h1>Approved</h1>'), '&lt;/code&gt;&lt;/pre&gt;&lt;h1&gt;Approved&lt;/h1&gt;')
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  // Ampersands escape first so existing entities are not double-decoded.
  assert.equal(escapeHtml('a & b'), 'a &amp; b')
  assert.equal(escapeHtml('ordinary/path.ts'), 'ordinary/path.ts')
})

test('parseSarif reads complexity and line ranges from complexipy output', () => {
  const sarif = {
    runs: [
      {
        results: [
          {
            message: {
              text: "Function 'f' has a cognitive complexity of 37, which exceeds the maximum of 15.",
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: '/repo/strands-py/src/strands/m.py' },
                  region: { startLine: 447, endLine: 654 },
                },
                logicalLocations: [{ name: 'f', kind: 'function' }],
              },
            ],
          },
        ],
      },
    ],
  }
  assert.deepEqual(parseSarif(sarif, '/repo'), [
    { file: 'strands-py/src/strands/m.py', name: 'f', complexity: 37, startLine: 447, endLine: 654 },
  ])
})

// resolvePrNumber decides which PR gets labeled by a job holding
// pull-requests: write, so its refusals matter as much as its successes.
const stubCore = () => {
  const warnings = []
  return { warnings, info: () => {}, warning: (m) => warnings.push(m) }
}
const FORK_REPO_ID = 42
const stubContext = (pullRequests, headSha = 'abc123', headRepoId = FORK_REPO_ID) => ({
  repo: { owner: 'o', repo: 'r' },
  payload: {
    workflow_run: { head_sha: headSha, head_repository: { id: headRepoId }, pull_requests: pullRequests },
  },
})
// Only reached when the event carries no associated PRs, as on a fork.
// prHeads values are 'sha' strings (head repo defaults to the fork's), an
// Error to throw, or `{ sha, repoId }` to control the head repository.
const stubGithub = (associated, prHeads = {}) => ({
  rest: {
    repos: {
      listPullRequestsAssociatedWithCommit: async () => ({ data: associated.map((number) => ({ number })) }),
    },
    pulls: {
      get: async ({ pull_number: pullNumber }) => {
        const entry = prHeads[pullNumber]
        if (entry instanceof Error) throw entry
        if (!entry) throw Object.assign(new Error('Not Found'), { status: 404 })
        const { sha, repoId = FORK_REPO_ID } = typeof entry === 'string' ? { sha: entry } : entry
        return { data: { head: { sha, repo: { id: repoId } } } }
      },
    },
  },
})

test('resolvePrNumber honors a claim the API confirms', async () => {
  const core = stubCore()
  const number = await resolvePrNumber({
    github: stubGithub([]),
    context: stubContext([{ number: 42 }]),
    core,
    claimed: 42,
  })
  assert.equal(number, 42)
  assert.deepEqual(core.warnings, [])
})

test('resolvePrNumber refuses a claim the API does not confirm', async () => {
  const core = stubCore()
  const number = await resolvePrNumber({
    github: stubGithub([]),
    context: stubContext([{ number: 42 }]),
    core,
    claimed: 99,
  })
  // Labeling PR 42 here would act on an artifact already shown to be lying.
  assert.equal(number, null)
  assert.match(core.warnings[0], /not labeling/)
})

test('resolvePrNumber falls back to the head sha for forks', async () => {
  const core = stubCore()
  const number = await resolvePrNumber({
    github: stubGithub([7]),
    context: stubContext([]),
    core,
    claimed: 7,
  })
  assert.equal(number, 7)
})

// Fork PRs populate neither `workflow_run.pull_requests` nor the
// commit-association API — the head commit exists only in the fork — so the
// claim is verified directly against the claimed PR's actual head.
test('resolvePrNumber verifies the claim via the PR head when no association exists', async () => {
  const core = stubCore()
  const number = await resolvePrNumber({
    github: stubGithub([], { 3704: 'abc123' }),
    context: stubContext([], 'abc123'),
    core,
    claimed: 3704,
  })
  assert.equal(number, 3704)
  assert.deepEqual(core.warnings, [])
})

test('resolvePrNumber refuses a claim whose PR head does not match the run', async () => {
  const core = stubCore()
  const number = await resolvePrNumber({
    github: stubGithub([], { 3704: 'different-sha' }),
    context: stubContext([], 'abc123'),
    core,
    claimed: 3704,
  })
  assert.equal(number, null)
  assert.match(core.warnings[0], /not labeling/)
})

// A commit object can be pushed into any repository, so a matching SHA alone
// does not tie the claim to this PR — the head repository must match too.
test('resolvePrNumber refuses a claim whose head repository differs despite a matching sha', async () => {
  const core = stubCore()
  const number = await resolvePrNumber({
    github: stubGithub([], { 3704: { sha: 'abc123', repoId: 999 } }),
    context: stubContext([], 'abc123'),
    core,
    claimed: 3704,
  })
  assert.equal(number, null)
  assert.match(core.warnings[0], /not labeling/)
})

test('resolvePrNumber refuses a claim naming a PR that does not exist', async () => {
  const core = stubCore()
  const number = await resolvePrNumber({
    github: stubGithub([], {}),
    context: stubContext([], 'abc123'),
    core,
    claimed: 99999,
  })
  assert.equal(number, null)
  assert.match(core.warnings[0], /not labeling/)
})

// A transient lookup failure must fail the run visibly rather than silently
// skipping the labels — silent skipping is the bug this path exists to fix.
test('resolvePrNumber rethrows transient lookup failures instead of refusing', async () => {
  const core = stubCore()
  const transient = Object.assign(new Error('Service Unavailable'), { status: 503 })
  await assert.rejects(
    resolvePrNumber({
      github: stubGithub([], { 3704: transient }),
      context: stubContext([], 'abc123'),
      core,
      claimed: 3704,
    }),
    /Service Unavailable/
  )
  assert.deepEqual(core.warnings, [])
})

test('resolvePrNumber refuses when a commit maps to several PRs and nothing is claimed', async () => {
  const core = stubCore()
  const number = await resolvePrNumber({
    github: stubGithub([1, 2]),
    context: stubContext([]),
    core,
    claimed: null,
  })
  assert.equal(number, null)
  assert.match(core.warnings[0], /associated with PRs/)
})

test('resolvePrNumber returns null when no PR matches', async () => {
  const core = stubCore()
  assert.equal(await resolvePrNumber({ github: stubGithub([]), context: stubContext([]), core, claimed: null }), null)
})

// The TypeScript engine needs the pinned tools install; skip rather than
// fail when it is absent.
let engine = null
try {
  engine = loadEngine(new URL('tools', import.meta.url).pathname)
} catch {
  // Reported by the skip reason below.
}
const tsTest = (name, fn) => test(name, { skip: engine ? false : 'run npm run complexity:setup' }, fn)

tsTest('analyzeTypescriptFiles reports qualified names, scores and full spans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjx-'))
  const file = path.join(dir, 'sample.ts')
  fs.writeFileSync(
    file,
    [
      'export class Widget {',
      '  render(x: number): number {',
      '    if (x > 0) {',
      '      if (x > 1) { return 2 }',
      '    }',
      '    return 0',
      '  }',
      '}',
      'const bound = (y: boolean) => (y ? 1 : 0)',
    ].join('\n')
  )
  try {
    const fns = analyzeTypescriptFiles(engine, [file], dir)
    const render = fns.find((f) => f.name === 'Widget::render')
    assert.ok(render, 'method is class-qualified')
    assert.equal(render.complexity, 3)
    assert.equal(render.startLine, 2)
    assert.equal(render.endLine, 7)
    assert.equal(render.file, 'sample.ts')
    const bound = fns.find((f) => f.name === 'bound')
    assert.ok(bound, 'const arrow takes its binding name')
    assert.equal(bound.complexity, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

tsTest('analyzeTypescriptFiles skips an unparseable file with a warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cjx-'))
  const bad = path.join(dir, 'bad.ts')
  const good = path.join(dir, 'good.ts')
  fs.writeFileSync(bad, 'function ( {{{')
  fs.writeFileSync(good, 'export function ok(a: number) { return a ? 1 : 0 }')
  const warnings = []
  try {
    const fns = analyzeTypescriptFiles(engine, [bad, good], dir, (m) => warnings.push(m))
    assert.deepEqual(
      fns.map((f) => f.name),
      ['ok']
    )
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /could not parse/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// The guard must compare realpaths: import.meta.url is symlink-resolved
// (macOS /tmp -> /private/tmp), so a raw-path comparison silently never runs
// main() from a symlinked checkout, reporting nothing with exit 0.
test('isMainModule resolves symlinks in the entry path', () => {
  const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ismain-'))
  const link = `${real}-link`
  fs.symlinkSync(real, link)
  try {
    const script = path.join(real, 'entry.mjs')
    fs.writeFileSync(script, '')
    const moduleUrl = pathToFileURL(script).href
    assert.equal(isMainModule(path.join(link, 'entry.mjs'), moduleUrl), true)
    assert.equal(isMainModule(script, moduleUrl), true)
    assert.equal(isMainModule(path.join(real, 'other.mjs'), moduleUrl), false)
    assert.equal(isMainModule(undefined, moduleUrl), false)
    assert.equal(isMainModule('/nonexistent/entry.mjs', moduleUrl), false)
  } finally {
    fs.rmSync(link, { force: true })
    fs.rmSync(real, { recursive: true, force: true })
  }
})
