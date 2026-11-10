// Decide the size/* and complexity/* labels for a PR.
//
// Pure data in, pure data out: takes a unified diff plus per-function
// complexity records and emits the label decision as JSON. The same code runs
// locally (`hatch run complexity` / `npm run complexity`) and in CI, so the
// number a contributor sees matches the label the bot applies.

import { countsTowardSize, isAnalyzable, sizeLabel, complexityLabel } from './classify.mjs'
import { parseChangedLines, rangeTouched } from './diff.mjs'

/**
 * @param {object} input
 * @param {string} input.diff - `git diff -U0` between merge base and head
 * @param {Array<{path: string, additions: number, deletions: number}>} input.files
 * @param {Array<{file, name, complexity, startLine, endLine, baseComplexity?}>} input.functions
 */
export function buildReport({ diff, files, functions }) {
  const countedLines = files
    .filter((f) => countsTowardSize(f.path))
    .reduce((sum, f) => sum + f.additions + f.deletions, 0)
  const totalLines = files.reduce((sum, f) => sum + f.additions + f.deletions, 0)

  const changedLines = parseChangedLines(diff)
  const measured = functions
    .filter((fn) => isAnalyzable(fn.file))
    .filter((fn) => rangeTouched(changedLines.get(fn.file), fn.startLine, fn.endLine))
  const touched = measured
    // A function with a known base score counts only if the PR increased it:
    // editing inside an already complex function without making it worse must
    // not inherit the function's whole score. A function without a base score
    // (new file, renamed file, or a base analysis failure) counts
    // in full as new code.
    .filter((fn) => fn.baseComplexity == null || fn.complexity > fn.baseComplexity)
    .sort((a, b) => b.complexity - a.complexity)

  // Three distinct outcomes: nothing measurable (docs-only, tests-only) means
  // no label at all; functions measured but none increased is a real verdict
  // of zero added complexity, which buckets as complexity/low; otherwise the
  // most complex counted function drives the label.
  const maxComplexity = touched.length > 0 ? touched[0].complexity : measured.length > 0 ? 0 : null

  return {
    size: {
      label: sizeLabel(countedLines),
      countedLines,
      totalLines,
      excludedLines: totalLines - countedLines,
    },
    complexity: {
      label: maxComplexity === null ? null : complexityLabel(maxComplexity),
      maxComplexity,
      offenders: touched.slice(0, 10).map((fn) => ({
        file: fn.file,
        name: fn.name,
        complexity: fn.complexity,
        startLine: fn.startLine,
      })),
    },
  }
}

/** Human-readable summary for local runs and the CI job log. */
export function formatReport(report) {
  const lines = []
  const { size, complexity } = report
  lines.push(`size:       ${size.label}  (${size.countedLines} lines counted, ${size.excludedLines} excluded)`)
  if (complexity.label === null) {
    lines.push('complexity: n/a  (no SDK source functions touched)')
  } else if (complexity.maxComplexity === 0 && complexity.offenders.length === 0) {
    lines.push(`complexity: ${complexity.label}  (touched functions, none increased)`)
  } else {
    lines.push(`complexity: ${complexity.label}  (max ${complexity.maxComplexity})`)
    for (const fn of complexity.offenders) {
      lines.push(`  ${String(fn.complexity).padStart(4)}  ${fn.file}:${fn.startLine}  ${fn.name}`)
    }
  }
  return lines.join('\n')
}
