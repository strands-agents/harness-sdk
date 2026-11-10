---
name: pre-push
description: Runs the local equivalent of the CI merge gate before you push. Detects which areas (Python, TypeScript, docs) your changes touch, auto-fixes what it can, then runs only those checks. Use when the user asks to run pre-push checks, get push-ready, verify changes before pushing or opening a PR, "make sure CI will pass", or check lint/tests/types locally.
---

# Pre-push Checks Skill

Get your branch push-ready: detect which areas your changes touch, auto-fix what's mechanically fixable, then run the same checks CI's merge gate runs for those areas — and triage whatever's left with the user.

This is a manually-invoked check, not a git hook — it runs only when you ask for it, so it never gets in the way of committing incrementally. Reach for it when you're about to push or open a PR. (When opening a PR, run this first, then use the `pr-create` / `pr-writer` skills to draft and open it.)

The repo's CI (`.github/workflows/ci.yml`) detects which of three areas changed and runs only those: **python** (`strands-py/`), **typescript** (`strands-ts/`), and **docs** (`site/`). This skill mirrors that routing locally.

## Process

### 1. Run the bundled script

```bash
bash .agents/skills/pre-push/run-checks.sh 2>&1
```

Non-zero exit means something failed. On failure, the script prints a summary at the end with every failed step and the last 20 lines of its error output — everything you need to start fixing is in the tail of the output. Ignore noise earlier in the output.

The script runs from anywhere in the repo (it locates the root via `git rev-parse --show-toplevel`). From a subdirectory:

```bash
bash "$(git rev-parse --show-toplevel)/.agents/skills/pre-push/run-checks.sh"
```

It detects the changed areas — comparing against the closest `main`/`master` base it can find (local or any remote, so `upstream/main` on a fork works too — fork-aware), plus staged, unstaged, and untracked changes — using the same path filters CI uses, then for each detected area runs two phases:

- **Phase 1 — auto-fix:** formatting, lint `--fix`, and lockfile sync. These are scoped to the files your change touches (so they never reformat unrelated files into your commit), write to working-tree files, and never fail the run.
- **Phase 2 — check:** the gate (build, lint check, format check, type-check, tests, audit), run tree-wide for CI parity. Phase 2 runs on the now-fixed tree and decides pass/fail.

The script exits non-zero if any check fails after fixing.

Useful flags:

- `--list` — show the detected areas and triggering files without running anything. Use first to confirm scope.
- `--all` — run every area regardless of what changed.
- `--base <ref>` — compare against `<ref>` instead of the auto-detected base.
- `--heavy` — also run the slow CI-parity steps skipped by default (browser tests, `test:package`, full Python version matrix). Slower, may need extra system deps; reach for it only when the change is risky in those dimensions.
- `python` / `typescript` / `docs` — run specific areas explicitly, overriding detection.

### 2. Triage what phase 2 reports

If the script exits 0, you're done — report it and stop. If it exits non-zero, work the `FAILED:` items before calling the branch push-ready, splitting by whether the fix requires judgment:

- **Mechanical / unambiguous** — a missing type annotation, an unused import the linter flagged but didn't strip, a lockfile that needs committing. Just fix these and re-run the script.
- **Anything ambiguous** — loop back to the developer with the failing output before changing anything. The clearest case is a **test failure**: it means either the change broke real behavior (fix the code) or the behavior change is intended and the test is stale (fix the test). Don't guess, and never rewrite a test just to make it pass — that silences the very check that caught the regression. Surface it and let the developer decide.

How that split applies to the specific things phase 2 reports:

- **Lint / type errors** the autofixer couldn't resolve — usually mechanical; fix the code and re-run.
- **Test failures** — the judgment case above: show the failing output and let the developer decide whether the code or the test is wrong.
- **`npm audit`** — a high-severity advisory may be a pre-existing transitive dependency issue outside this change. Surface it; don't block the user's work on it. Note it and move on.
- **Missing tool** (`hatch`/`npm` not found) — the script says how to install. Report it; don't silently work around it.

After fixing anything, re-run the script to confirm green.

## Output format

- **Starting a check:** `  > label`
- **Inline failure:** `  FAILED: label` (printed inline as each check fails)
- **End summary (on failure only):** after `============`, each failed step is listed as `--- FAILED: label ---` followed by the last 20 lines of its output. This summary has everything needed to diagnose and fix.
- **Exit code:** non-zero if any check failed

## Rules

- Always run the script rather than freehanding the commands — it keeps the path filters and check list in sync with CI.
- A green run clears the deterministic, single-platform failures but does not reproduce CI's OS/version matrices or the npm-pack smoke test. Report "local checks passed," not "CI will pass."
- The script writes to working-tree files in phase 1 (formatters, lockfile). That's expected for a push-readiness helper; the user can review with `git diff` before committing.
- If no area is detected (the change touches only files outside python/typescript/docs, e.g. top-level docs or `.agents/`), say so — there's nothing the merge gate runs for it, and that's fine.
