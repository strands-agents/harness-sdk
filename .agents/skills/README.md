# Agent Skills

Skills for this repository. See [agentskills.io](https://agentskills.io/home) for the general format.

## Build with Strands

| Skill | Purpose |
|-------|---------|
| **strands** | Helps coding agents choose, scaffold, extend, and migrate applications with Strands Agents. Includes focused entry points for scaffolding an agent, adding a tool, connecting an MCP server, and porting from LangGraph. Claude Code discovers `strands` in this repository through the tracked `.claude/skills` symlink; the four focused entry points under `strands/skills/` load only when the directory is installed as a plugin. |

## PR workflow

| Skill | Purpose |
|-------|---------|
| **pr-writer** | Generates PR titles and descriptions following our Conventional Commits format, PR template, and `team/PR.md` writing guidelines. Captures design decisions from the conversation so reviewers get the "why" without reading the full thread. |
| **pr-create** | Orchestrates the full PR creation flow: description generation, pre-flight checks from CONTRIBUTING.md, conditional push, and `gh pr create --draft`. Prevents common agent mistakes like creating non-draft PRs or using incompatible flags. |
| **pr-feedback** | Fetches all unresolved PR comments (inline threads, reviews, issue-level) via a bundled script using GitHub's GraphQL API. Surfaces reaction data and author replies to distinguish "agreed to fix" from "open discussion", then presents a prioritized list for selective addressing. |

## Documentation

| Skill | Purpose |
|-------|---------|
| **docs-writer** | Drafts or rewrites documentation pages following the project's voice and structure guidelines. |
| **docs-reviewer** | Reviews drafts for voice consistency, structure, and terminology before PR submission. |
| **docs-audit** | Assesses published pages for quality, accuracy, and voice compliance. |
| **docs-planner** | Identifies documentation gaps and prioritizes the backlog. |

## Code review

| Skill | Purpose |
|-------|---------|
| **strands-review** | Local preview of the `/strands review` GitHub Action. Runs the same Task Reviewer SOP so you can anticipate what the remote agent will flag before pushing. |

## Local checks

| Skill | Purpose |
|-------|---------|
| **pre-push** | Mirrors the `ci.yml` merge gate locally. A bundled script detects which areas changed (python/typescript/docs) using CI's exact path filters, auto-fixes what's mechanical (format, lint `--fix`, lockfile sync) scoped to changed files, then runs that area's checks. Run it to get push-ready before pushing or opening a PR (pairs with **pr-create** / **pr-writer**). |

## Adding a new skill

Create a directory under `.agents/skills/<skill-name>/` with at least a `SKILL.md` file:

```
.agents/skills/my-skill/
├── SKILL.md           # Required: frontmatter + instructions
└── helper-script.sh   # Optional: bundled scripts the skill references
```

Guidelines:
- Name contributor-workflow skills as `{domain}-{action}` (e.g. `pr-create`, `docs-audit`); user-facing skills such as `strands` are named for the product
- Keep instructions specific to this repo — reference actual file paths and conventions
- If a workflow involves unreliable CLI commands, bundle a tested script rather than inlining commands
- The `description` field is what the agent uses to decide whether to load the skill — make it specific about trigger conditions
