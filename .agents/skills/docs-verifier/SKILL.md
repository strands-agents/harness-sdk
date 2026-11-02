---
name: docs-verifier
description: Verify every code example and factual claim on a documentation page against the source, citing the line that proves each one and type-checking or running the code. Use before merging a docs PR, or when asked to verify or fact-check a page.
---

# Documentation Verifier

Check that everything a documentation page states is true of the code right now, and produce a claim-by-claim report citing the `file:line` behind each assessment. Unlike `docs-reviewer` (style) and `docs-audit` (whether a page needs work), this skill checks only truth, and checks all of it. Where the page and the code disagree, the page is wrong; never edit source to match a page.

## Inputs

Verify exactly the pages you're given, usually one or two:

- page paths under `site/src/content/docs/` (or their URLs)
- a docs PR or branch: its changed pages, from `git diff --name-only origin/main... -- site/src/content/docs`
- a code change: pages whose `sourceLinks` or prose mention the changed paths or symbols (`grep -rln "<path>\|<Symbol>" site/src/content/docs`)

With no target, ask. Never default to the whole site.

## Where the truth lives

| Area | Source | Public surface |
|------|--------|----------------|
| Python SDK (`strands-agents`) | `strands-py/src/strands/` | `__all__` of the imported module |
| TypeScript SDK (`@strands-agents/sdk`) | `strands-ts/src/` | `strands-ts/src/index.ts` (`@internal` is not public) |
| Python harness (`strands-harness`) | `harness-py/src/strands_harness/` | `harness-py/src/strands_harness/__init__.py` |
| TypeScript harness (`@strands-agents/harness`) | `harness-ts/src/` | `harness-ts/src/index.ts` (`./internal` is not public) |
| CLI (`@strands-agents/cli`) | `strands-cli/src/` | `strands-cli/src/cli/`; in-chat slash commands in `strands-cli/src/tui/chat/commands.ts` |
| MCP server (`strands-agents-mcp-server`) | `strands-mcp/src/strands_mcp_server/` | its registered MCP tools |

**Not in this repo:** `user-guide/evals-sdk/`, `user-guide/box/`, and `user-guide/shell/` document `strands-agents/evals`, `strands-agents/box`, and `strands-agents/shell`. Shallow-clone the repo into `.context/src/<repo>` or read it with `gh api repos/strands-agents/<repo>/contents/<path>`, and cite `<repo>/<path>:line`. A package name alone never makes a claim `correct`.

For orientation, see the **Key Python modules** and **Key TypeScript modules** lists in `../../references/code-verification.md`. Tests and examples support a behavior claim but never replace reading the implementation.

## Process

### Step 1: Resolve the page

1. Record `git rev-parse --short HEAD` and the branch.
2. Read the page and its frontmatter (`languages`, `experimental`, `sourceLinks`). No `languages` field means the page covers both SDKs.
3. Resolve every `--8<-- "path:region"` include (paths relative to `site/src/content/docs/`), including its `_imports` sibling, and confirm each region has a matching `[start:]` / `[end:]` pair.

### Step 2: Build the claim inventory

Before verifying anything, list every checkable claim, numbered, with its line (`fm` for frontmatter). Inventory a repeated claim once and list all its lines.

- **Code blocks**, per language tab: imports, calls, argument names and values, attributes read, shown output, install commands and install comments (a `# pip install …` comment claims it installs everything the block needs), and comments that assert something.
- **Prose, tables, callouts:** names, signatures, defaults, numbers, behavior and ordering, error types, which language or provider supports what (both values of every `<Syntax py="…" ts="…" />`), env vars, flags, and links.
- **Frontmatter:** each `sourceLinks` path, `languages`, `experimental`.

List motivation and opinion sentences as "not claims" so the inventory is visibly complete.

### Step 3: Verify each claim against source

Find the code that decides each claim and record `file:line`.

- **Trace behavior; don't infer it** from names, docstrings, or comments. For numbers, find the constant and where it's used.
- **Check each language separately.** Shared prose must hold in every SDK the page covers.
- **Check it's public** (see the table). An unexported symbol gets the `internal` tag even if the example works.
- **Check lifecycle:** compare deprecation markers and experimental namespaces with the page's frontmatter and wording.
- **Check it's released.** Find the commit that added the export (`git log -S '<symbol>' --oneline -- <index.ts or __init__.py>`), then the first release with it: `git tag --contains <commit> | grep -E '^<prefix>/v[0-9]' | sort -V | head -1`, where `<prefix>` is `python`, `typescript`, `harness-python`, `harness-typescript`, `harness-cli`, or `mcp`. Harnesses depend on the published SDK (ranges in `harness-py/pyproject.toml` and `harness-ts/package.json`), so SDK behavior a harness page relies on must be inside that range.
- **Check `sourceLinks`:** each path exists and implements what the page describes.

### Step 4: Check the code mechanically

Compile every code block, and run it when you can. Put scratch files under `.context/`, which is not gitignored (Step 7 cleans up).

**TypeScript snippet files** (`--8<--` includes): install in `docs-ci.yml` order, then type-check:

```bash
(cd site && npm ci)
(cd strands-ts && npm install --ignore-scripts && npm run build)
(cd site && npm install)        # re-links the built SDK
(cd site && npm run typecheck:snippets); echo "exit=$?"
```

`tsc: not found` (exit 127) is a setup failure, not a pass. The check covers the whole site, so report only this page's errors; confirm its files were included with `npx tsc -p site/test-snippets --listFiles | grep <page-dir>`.

Then type-check each rendered block on its own (the `_imports` region plus the body region), since lines outside the markers never render. A region that ends before its class or function closes is `incorrect`. If several regions are meant to be read together, also check them combined.

**Inlined TypeScript** (no CI covers it; the convention break itself is `docs-audit`'s finding): copy each block verbatim into a scratch file.

For SDK blocks, the root `node_modules/@strands-agents/sdk` links to the local `strands-ts` (build it first if `strands-ts/dist/` is missing):

```bash
mkdir -p .context/verify/ts
echo '{ "type": "module" }' > .context/verify/ts/package.json
# write blocks to .context/verify/ts/<n>.ts and this tsconfig.json:
#   { "extends": "../../../strands-ts/tsconfig.base.json",
#     "compilerOptions": { "noEmit": true, "rootDir": ".", "types": ["node"], "noUnusedLocals": false },
#     "include": ["./*.ts"] }
npx tsc -p .context/verify/ts/tsconfig.json
```

For harness blocks, check inside `harness-ts/`, whose `node_modules` has the published SDK. Never check an SDK block there.

```bash
cd harness-ts && npm ci && npm run build
mkdir -p .verify
# write blocks to .verify/<n>.ts and this tsconfig.json:
#   { "extends": "../tsconfig.base.json",
#     "compilerOptions": { "noEmit": true, "noUnusedLocals": false },
#     "include": ["./*.ts"] }
npx tsc -p .verify/tsconfig.json
```

**Python** (no CI covers it):

```bash
uv venv --clear .context/verify-venv
uv pip install --python .context/verify-venv/bin/python -e ./strands-py   # harness pages: -e ./harness-py instead
mkdir -p .context/verify   # write blocks to .context/verify/<n>.py
cd .context/verify && ../verify-venv/bin/python <n>.py
```

Install only the documented package and what the page's install line names. If a block works only after you add an extra the page doesn't mention, the install line is `incorrect` with `high` impact. Run from inside `.context/`, because agents can create session or memory directories in the working directory.

**How far to run:**

- Run each block up to its first model call. Construction needs no credentials and catches wrong imports, parameters, and types. Use `inspect.signature(...)` for keywords the block doesn't exercise.
- Run a full invocation only if it needs no credentials or credentials are clearly configured.
- Stand in for external systems (a CLI binary, a VM) with a stub on `PATH`, and say so in the evidence.
- Probe for hangs with in-language timeouts; macOS has no `timeout` command.

**Shell commands:** check flags against the CLI source or `--help`, and package names against `pyproject.toml` / `package.json`. Don't install globally, deploy, or call paid services.

### Step 5: Check links

- **Internal links and anchors:** the target page or heading exists and covers what the sentence promises. The build only catches dead links.
- **API reference links:** they point at a real public symbol. Run `npm run sdk:generate` in `site/` first, because `api/*/_generated` symlinks into the gitignored `site/.build`.
- **GitHub links:** they point at a path that exists on `main`.

### Step 6: Assess each claim

Keep these fields separate; a claim can be correct and still fragile.

**Accuracy** (one per claim):

| Value | Meaning | Evidence |
|-------|---------|----------|
| `correct` | True as written | `file:line` |
| `incorrect` | Page says X, code says Y | `file:line` for Y, plus a fix |
| `incomplete` | True only under an unstated condition, or for only some of the cases it generalizes to | `file:line` of the condition, plus the qualifier to add |
| `unverifiable` | No source settles it | Why, and what would settle it |

Never round `unverifiable` up to `correct`.

**Impact** (claims that aren't `correct`): `high` means copied code fails or the reader acts on wrong behavior. `medium` means misleading, but the reader recovers. `low` means hygiene only, with no reader misled.

**Checked by** (the strongest check you actually ran): `read`, `compiled`, or `executed` (at least through construction). Never report `executed` for code you only compiled.

**Risk tags** (zero or more, including on `correct` claims):

- `deprecated`: deprecated in source
- `internal`: not public
- `unreleased`: not in a published release, or outside a harness's SDK range
- `one-language`: holds in one SDK, but the page implies both
- `accidental`: works, but not for the reason the page implies
- `experimental`: experimental in source, but the page doesn't say so

### Step 7: Clean up

```bash
rm -rf .context/verify .context/verify-venv .context/src harness-ts/.verify
git status --short   # nothing new except .context/docs-verifier/
```

## Output Format

```markdown
## Docs Verification: [Page Title]

**File:** site/src/content/docs/[path]
**Verified against:** [short SHA] on [branch]
**Result:** [N] claims, [n] findings: [n] high · [n] medium · [n] low · [n] unverifiable · [n] risk-tagged

### Findings

| # | Line | Claim | Accuracy | Impact | Tags | Checked by | Evidence | Suggested fix |
|---|------|-------|----------|--------|------|------------|----------|---------------|
| 8 | 13 | `web_search` is on by default | incorrect | high | | executed | harness-py/src/strands_harness/agent.py:121-139 turns it off when the model has no native search | "`web_search` turns on only where the provider has native search" |

[Every claim that isn't `correct`, plus every risk-tagged claim, sorted high → medium → low → unverifiable → risk-tagged. "None" if empty.]

### Full Claim Inventory

| # | Line | Claim | Accuracy | Checked by | Evidence |
|---|------|-------|----------|------------|----------|
| 14 | 20-21 | Fetched content is cached for 15 minutes | correct | read | harness-py/src/strands_harness/tools/web_fetch.py:37 (`15 * 60`) |

Not claims: [lines]

### Commands Run

| Command | Result |
|---------|--------|
| `npm run typecheck:snippets` | exit 0 |
| `cd .context/verify && ../verify-venv/bin/python 3.py` (construction only) | pass |
```

Include the full inventory even with no findings, so a reviewer can audit the run. For several pages, write one report per page plus a summary table of finding counts. Save each report to `.context/docs-verifier/<page-slug>.md` and return it in your reply.

## Out of scope

- Voice, style, structure, and terminology (`docs-reviewer`, `docs-audit`).
- Editing source. After the report, offer docs-only fixes, highest impact first, and apply them only if the user agrees.
- Commits, pushes, and PRs.
