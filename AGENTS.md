# Agent Development Guide - Strands Agents Monorepo

This document provides guidance for AI agents working in the Strands Agents monorepo. For human contributor guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).

This file is shared by agents with different goals — writing code, opening PRs, helping contributors — and is organized by task.

## Context

### Monorepo Layout

```
strands-agents/
├── strands-py/         # Python SDK (hatch) — see strands-py/AGENTS.md
├── strands-ts/         # TypeScript SDK (npm workspace) — see strands-ts/AGENTS.md
├── site/               # Documentation site (Astro) — see site/AGENTS.md
├── team/               # Governance + cross-SDK process (tenets, decisions, API bar-raising, PR & compatibility guidelines, designs/ proposals)
├── test-infra/         # CDK stack for integ tests that require provisioned AWS infra
├── .agents/            # Agent skills and references
├── package.json        # npm workspace root
└── .github/workflows/  # CI (ci.yml is the merge gate)
```

Determine which sub-project you're in and follow its conventions — each has its own `AGENTS.md`.

### Where the "why" lives: `team/`

Before designing a feature or changing an API, read the relevant context in `team/`. It captures the reasoning the code itself doesn't:

- **`team/designs/`** — RFC-style proposals for significant features (numbered `NNNN-*.md`). The richest source of architectural context: problem framing, the chosen approach, alternatives considered, and consequences. If you're touching a major subsystem, find its design doc first.
- **`team/DECISIONS.md`** — lightweight architecture decision records for smaller calls.
- **`team/TENETS.md`** — the principles a contribution should align with.
- **`team/API_BAR_RAISING.md`** and **`team/FEATURE_LIFECYCLE.md`** — the bar and process for API changes and feature deprecation.

## Writing Code

- **Code conventions**: Follow the conventions in the sub-project's own `AGENTS.md` (`strands-py/AGENTS.md`, `strands-ts/AGENTS.md`, `site/AGENTS.md`) — they define the style, patterns, and directory layout for that toolchain.
- **Write for low complexity**: every PR is labeled with the [cognitive complexity](https://www.sonarsource.com/docs/CognitiveComplexity.pdf) of the most complex function it touches, and nesting drives the score. Write flat control flow (guard clauses, extracted helpers, lookup tables over branch ladders) and keep refactors in their own PR. Why we measure and how the score works: [team/COMPLEXITY.md](./team/COMPLEXITY.md). Check before pushing with `npm run complexity` (or `hatch run complexity` from `strands-py/`).
- **Branching**: `git checkout -b agent-tasks/{ISSUE_NUMBER}`
- **Commits**: Use [conventional commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `refactor:`, `docs:`, etc.
- **CI**: The `ci.yml` merge gate detects which paths changed and runs only relevant checks.
- **Skills**: Reusable, repo-specific workflows live under `.agents/skills/` — for PRs (`pr-create`, `pr-writer`, `pr-feedback`), docs (`docs-writer`, `docs-reviewer`, `docs-audit`, `docs-planner`), and code review (`strands-review`). See [`.agents/skills/README.md`](./.agents/skills/README.md) for what each does and when to use it.
- **Doc `sourceLinks` track source files**: Doc pages under `site/` point at their backing implementation via `sourceLinks` frontmatter — repo-relative paths into `strands-py/` and `strands-ts/`. When you **rename or move a source file**, update any `sourceLinks` that reference its old path in the same change. The site build only fails on a malformed path or an unmapped file extension, **not** on a path that still resolves to the wrong (or now-nonexistent) file, so a stale reference rots silently. Find affected pages with `grep -rn "<old/path>" site/src/content/docs`.

### Cross-SDK Conventions

These rules apply to **both** SDKs. Each sub-guide (`strands-py/AGENTS.md`, `strands-ts/AGENTS.md`) shows the language-idiomatic form; the shared intent lives here so the two cannot drift apart. The two SDKs aim for parity in *concepts and names*, not identical code.

- **Plugin / construct naming**: name a construct for what it *does*, not for the interface it implements. `AgentSkills`, `ContextOffloader`, `GoalLoop` — never an `…Plugin` suffix. (Python's `vended_plugins` and TS's `vended-plugins` already follow this.)
- **Cross-SDK parity**: when a name, constant, or hook event exists in both SDKs, keep them in sync.
  - **Identifiers** match, re-cased to the language idiom (`snake_case` ↔ `camelCase`).
  - **Single-word string-literal values** are byte-identical (`'user'`, `'success'`).
  - **Multi-word string-literal values** are `snake_case` in Python and `camelCase` in TypeScript (`tool_use` ↔ `toolUse`); convert via an explicit map, never emit the other language's casing.
  - **Wire field names** (keys exchanged with a provider API) keep their wire format in both SDKs even when it breaks the language's casing convention (`inputSchema`, `tool_use_id`).
  - **Hook event names are shared** across SDKs (modulo the suffix convention). When you add a hook event in one SDK, add the matching name in the other.
- **Public vs internal API**: mark anything exported-but-not-public so consumers don't depend on it — Python keeps it out of `__all__` (and should prefix the module `_`); TypeScript keeps it out of the `index.ts` barrel and tags it `@internal`.
- **`invocationState` is user-only**: `invocationState` / `invocation_state` belongs to the user. SDK code must never use it to carry, store, key, or forward internal state. Existing SDK uses of it are debt, not precedent.
- **Structured logging format**: `field=<value>, field=<value> | lowercase human-readable message`, no punctuation, pipe-separate multiple statements. Python interpolates with `%s` (never f-strings; ruff `G` enforces it); TypeScript uses template literals (never printf `%s`/`%d`).
- **Evergreen, to-the-point comments**: a comment states only what cannot be inferred from the code (a constraint, an invariant, a non-obvious why) and states it briefly. Reasoning that explains or defends a change to its reviewer belongs in the PR description, not the source. Never narrate how the code changed or what it used to be ("improved", "previously", "used to", "which would previously have crashed"). This applies to tests too — a regression test for a discovered bug links the issue it guards against and states the behavior it guarantees; a test written as part of feature development carries no issue reference. ("deprecated"/"legacy" is fine when it describes a stable API surface or runtime state; it's forbidden only when narrating how the code itself changed.)

- **Directory & file naming parity**: subsystem directories use the language-idiomatic separator (`snake_case` in Python, `kebab-case` in TypeScript) but the stem matches word-for-word so they are mechanically translatable (`vended_plugins/` ↔ `vended-plugins/`, `conversation_manager/` ↔ `conversation-manager/`).

### Testing

When writing tests, follow the sub-project's testing guidance — `strands-py/docs/TESTING.md` for the Python SDK, `strands-ts/docs/TESTING.md` for the TypeScript SDK.

**`test-infra/` guardrails.** The `test-infra/` CDK stack deploys real AWS resources (Bedrock KBs, EC2 instances) that a small subset of integration tests depend on. Most tests do not need it — they run without provisioned infrastructure.

- **Do not deploy this stack** unless you are explicitly working on the test infrastructure itself or iterating on tests that resolve SSM parameters from it.
- **Never set `STRANDS_TEST_INFRA_INTERNAL=true`** unless deploying to the Strands team's own test account. This attaches a broad internal policy and GitHub OIDC trust that is meaningless (and wasteful) outside the internal account.
- **To run infrastructure-dependent integ tests without deploying anything**, open a PR — CI runs them against pre-provisioned resources automatically.

## Creating PRs

See [PR guidelines](./team/PR.md). Use the `pr-create` and `pr-writer` skills under `.agents/skills/` to draft and open PRs.

If you are opening a PR on behalf of a contributor, the human is the author and is accountable for everything you submit. A small, focused change that its author fully understands is the single biggest predictor of a fast review and an accepted PR. (See [CONTRIBUTING.md](./CONTRIBUTING.md#using-ai-tools) for the human-facing version.)

- **Understand before you submit.** The contributor must be able to explain why every line works and defend the design. If you produced code you cannot explain plainly, simplify or explain it before opening the PR.
- **Keep it small and focused.** One logical change per PR. A branch that touches several sub-projects (`strands-py/`, `strands-ts/`, `site/`) is almost always several PRs. Smaller PRs are easier to understand, guide, and merge.
- **Open an issue first for anything significant**, so maintainers can align on the approach before time is invested.
- **Don't pad the change.** No drive-by reformatting, unrelated refactors, or speculative abstractions — they make the diff hard to review and the change hard to trust.
- **Verify before opening.** Run the relevant sub-project's checks (see [Development Environment](./CONTRIBUTING.md#development-environment), or the sub-project's own `AGENTS.md`) and make sure the change passes the `ci.yml` merge gate locally. Don't open a PR with known lint, type, or test failures.
- **Actually exercise the change, don't just rely on the gate.** Automated checks confirm the code is *valid*, not that the feature *works*. Run the behavior end to end — a manual script, a REPL snippet, the CLI, or an example — and confirm it does what the PR claims, including edge cases. If you can't exercise it (e.g. requires provisioned infra), say so explicitly in the PR rather than implying it was tested. Where it helps a reviewer, include the script or commands you ran.
- **Self-review the diff** end to end as if you were the reviewer, and confirm you can truthfully check every box in the PR template — including the item attesting that you have reviewed and understand every line of code in the PR, including any generated by AI tools. Then use the `pr-writer` skill so the description explains the **why**.

## Reviewing

### Documentation changes

When a change touches documentation under `site/`, apply the documentation skills in `.agents/skills/` in addition to standard code review:

- **`.agents/skills/docs-reviewer/SKILL.md`** — voice consistency, structure, terminology, and code-example quality.
- **`.agents/skills/docs-audit/SKILL.md`** — technical accuracy against live SDK sources (import paths, method signatures, API correctness).

Verify terminology against `.agents/references/terminology.md` and MDX authoring patterns against `.agents/references/mdx-authoring.md`. It is critical that you actually read these referenced source files before reviewing — their criteria do not apply if you only skim this summary.

## Working with the Community

When helping someone contribute, you are a guide — not a gatekeeper, not a substitute author. The contribution is theirs; help them make it good and learn along the way. The standard for what makes a good contribution lives in [CONTRIBUTING.md](CONTRIBUTING.md#using-ai-tools); this is about the people.

- **Point people to the community.** Real questions and design discussion belong with people — the [Discord](https://discord.gg/strands) and [GitHub Discussions](https://github.com/strands-agents/harness-sdk/discussions).
- **Assume good faith.** Most contributors are learning; meet them where they are. Good first issues are for bringing newcomers in, not just tickets to close.
- **Talk with contributors, not at them.** Warm, plain, concise. One question at a time, no walls of text, never patronizing. Explain the *why* so it teaches rather than dictates.
