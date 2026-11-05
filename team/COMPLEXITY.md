# Code Complexity

Every PR is labeled with the [cognitive complexity](https://www.sonarsource.com/docs/CognitiveComplexity.pdf)
of the most complex function it touches: `complexity/low` (10 or less),
`complexity/medium` (11 to 25), or `complexity/high` (above 25). This document
is the reasoning behind that label and the practices that keep code under it.

## Why we measure it, publicly

**It is our first tenet made measurable.** "Simple at any scale" is easy to
agree with and hard to hold: complexity arrives one reasonable-looking `if` at
a time. Cognitive complexity is an imperfect but reproducible proxy for how
hard control flow is to follow, applied at the moment complexity actually
enters the codebase: the PR.

**Review attention is the scarcest resource we have.** This repository
routinely carries around two hundred open PRs. The labels let maintainers
triage at a glance: a `size/s complexity/low` PR can be reviewed between
meetings, while `complexity/high` deserves an unhurried senior read. Without
the label, that triage happens anyway, just later and more expensively, inside
the review.

**A metric depersonalizes the conversation.** "Please split this function" is
an easier request to make and to receive when it points at a number both
sides can reproduce locally, rather than at one reviewer's taste. The same
command CI uses runs on your machine and produces the same result
(see [Check before you push](#check-before-you-push)).

**Authors see it before reviewers do.** The label is computed from your diff,
scoped to functions you actually touched. A pre-existing hotspot elsewhere in
a file you edited does not count against you, and a touched function counts
only if your change *increased* its score over the merge base, so threading a
small edit through an already complex function adds nothing and such a PR
lands at `complexity/low`. Deepening that function does count, at its full
score, which is one more reason to extract rather than deepen.

The label is advisory. It never blocks a merge, and
[some code is honestly complex](#when-high-is-honest).

## How the score works

Two rules produce the whole number:

1. Every break in linear flow costs one point: `if`, `else`, loops,
   `catch`/`except`, ternaries, `switch`/`match`, recursion, and each run of
   mixed boolean operators.
2. **Nesting multiplies the cost.** Each structure also pays one point per
   level of nesting it sits inside. An `if` at the top of a function costs 1;
   the same `if` three levels deep costs 4.

For calibration: the median function in both SDKs scores 1 to 2, and
`complexity/low` covers roughly nine out of ten existing functions. The
thresholds leave generous room for ordinary logic.

## Working with the score

This is not a rewrite of general code etiquette; each point here is listed
because of how the scoring model prices it.

Two design choices pay off before any code exists. Pure decision logic
separated from I/O scores flat, because interleaving them forces error
handling into every branch and every branch pays nesting. And variants encoded
once as data (a table, a dataclass, a discriminated union) let every call site
look up instead of re-deriving the branch ladder, which the model charges for
at each site.

While writing, nesting is the multiplier, so flattening is the
highest-leverage technique:

- **Return early.** Guard clauses (`if not valid: return`) remove a nesting
  level from everything that follows. Avoid `else` after a `return`.
- **Extract nested logic into named helpers.** The nesting penalty resets to
  zero inside the helper, and the label keys on the most complex single
  function you touched, so splitting one deep function into three shallow
  ones directly lowers it.
- **Prefer lookup tables over branch ladders.** A dict or `Map` from value to
  handler replaces an `if`/`elif` or `switch` chain with zero branches.
- **Keep boolean sequences uniform and name the pieces.** `a and b and c`
  costs one point; mixing `and`/`or` costs more.
- **Handle errors at the edges.** One `try` around a coherent block costs
  less than error handling threaded through nested branches.
- **In async code, await sequentially** instead of nesting callbacks or
  `then` chains, which each pay the nesting increment.

These are not hypothetical. A deliberately nested dispatch function scoring 23
drops to a maximum of 4 across three functions when rewritten with exactly
these techniques, with behavior unchanged.

## Keep the change simple

Complexity is also a property of the diff, not just the code:

- **Make the change easy, then make the easy change.** If a feature needs
  restructuring first, land the preparatory refactor as its own PR and the
  small behavior change on top. Two easy reviews beat one hard one, and the
  refactor PR proves itself with unchanged tests.
- **When your change lands in an already-complex function, extract rather
  than deepen.** Pull the piece you need to touch into a helper and change it
  there. Do not refactor the parts you are not touching; drive-by rewrites
  make the diff harder to trust.
- **Do not fear thorough tests.** The `size/*` label excludes test files, so
  testing generously never pushes your PR into a bigger bucket.

## When high is honest

Protocol event converters, state machines, and exhaustive format mappings
often land at `high` because the domain genuinely has that many cases, and
flattening them further would hurt readability. When that is your situation,
keep the function's shape and say so in the PR description. Reviewers weigh
the label against the code; a sentence of context settles it.

## Check before you push

The commands live in
[CONTRIBUTING.md](../CONTRIBUTING.md#pr-size-and-complexity): `npm run
complexity` from the repository root, or `hatch run complexity` from
`strands-py/`. The output lists the most complex functions your diff touches,
so you know exactly which one drives the label.
