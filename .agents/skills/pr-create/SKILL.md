---
name: pr-create
description: Creates a GitHub pull request using the gh CLI. Use when the user asks to create, open, or submit a PR on GitHub.
---

# GitHub PR Create Skill

## Process

### 1. Get the PR Description

- Check for `.local/pr-body.md`. If it exists, re-read it fresh and sanity-check that its content matches the current branch's changes (e.g. the description references files, features, or issues consistent with the current diff). If it looks stale or unrelated to the current changes, warn the user and offer to regenerate it.
- Else if the user already generated a PR description earlier in the conversation, use that.
- Otherwise, fall back to the `pr-writer` skill to generate the title and body.

### 2. Pre-flight Checks

Check for `CONTRIBUTING.md` (at the repo root or in `docs/`) and `.github/PULL_REQUEST_TEMPLATE.md`. Scan them for any recommended steps before opening a PR — common examples:

- Running a linter or formatter (e.g. `npm run lint`, `cargo fmt`)
- Running tests (e.g. `npm test`, `pytest`)
- Building the project
- Updating documentation or changelogs

If you find any such steps, **list them and ask the user which ones they'd like you to run**. Run whichever the user approves. If any step fails, show the output and ask how to proceed before continuing.

If neither file exists or they contain no actionable pre-PR steps, skip this and move on.

To run the local equivalent of the CI merge gate before opening the PR (lint, format, type-check, tests for the areas the change touches), use the `pre-push` skill — `bash .agents/skills/pre-push/run-checks.sh`.

### 3. Push the Branch (if needed)

Check whether the current branch has an upstream tracking branch with all commits pushed. If not, push before creating the PR. If the push fails, show the error and stop.

### 4. Create the PR

Ensure the final PR body is written to `.local/pr-body.md` (create `.local/` if needed), overwriting any earlier draft. Then create the PR:

```bash
gh pr create \
  --title "<title>" \
  --body-file .local/pr-body.md \
  --draft
```

- Default to `--draft`. Only omit it if the user explicitly asks for a non-draft PR.
- Do NOT pass `--repo` — let `gh` infer the upstream from the git remotes so the PR targets the correct upstream repository.

## Rules

- If `gh` is not authenticated or the command fails, show the error and stop.
