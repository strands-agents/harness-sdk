# Agent Development Guide - Documentation Site

This document provides guidance for AI agents working on the Strands Agents documentation site (the `site/` directory). For human contributor guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Purpose and Scope
This directory contains the documentation site for Strands Agents, providing guides on how to develop with the SDK in both Python and TypeScript.

**AGENTS.md** contains agent-specific repository information including:
- Directory structure with summaries of what is included in each directory
- Development workflow instructions for agents to follow when developing features
- Coding patterns and testing patterns to follow when writing code
- Style guidelines, organizational patterns, and best practices

**For human contributors**: See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and contribution guidelines.

## Team Process Documents

When working on SDK features or documentation, familiarize yourself with these team processes:

* **[Feature Lifecycle Process](../team/FEATURE_LIFECYCLE.md)**: How features are added, versioned, deprecated, and graduated from experimental status
* **[API Bar Raising](../team/API_BAR_RAISING.md)**: Standards for API design quality
* **[Decisions](../team/DECISIONS.md)**: Key architectural and design decisions
* **[Tenets](../team/TENETS.md)**: Core principles guiding SDK development

These documents define the standards and processes that ensure consistency and quality across the Strands SDK.

## Documentation Skills and Voice References

Documentation authoring skills and shared reference material live under `.agents/`. The `.claude/skills`, `.claude/references`, `.kiro/skills`, and `.kiro/references` paths are symlinks into `.agents/`, so edits through any path hit the same files.

On Windows, these symlinks require Developer Mode or `git config core.symlinks true`. If they don't resolve on your machine, work directly in `.agents/` — every tool-specific path is just a pointer to the same files.

```
.agents/
├── skills/
│   ├── docs-writer/      # Draft or rewrite doc pages
│   ├── docs-reviewer/    # Review drafts before PR submission
│   ├── docs-audit/       # Assess published pages for quality
│   └── docs-planner/     # Prioritize the docs backlog
└── references/
    ├── voice-guide.md       # Five-layer voice stack
    ├── terminology.md       # Canonical terms (one concept, one term)
    ├── mdx-authoring.md     # Tabs, snippets, callouts
    └── code-verification.md # Verifying code examples against SDK source
```

| Skill | Purpose | Sample triggers |
|-------|---------|-----------------|
| `docs-writer`   | Draft or rewrite doc pages          | "write a doc", "draft a page", "rewrite the quickstart" |
| `docs-reviewer` | Review drafts before PR submission  | "review this draft", "is this ready to ship" |
| `docs-audit`    | Assess published pages for quality  | "audit this page", "check docs quality" |
| `docs-planner`  | Prioritize the docs backlog         | "plan docs work", "what docs need writing" |

When authoring or reviewing documentation pages, follow the voice guide and the terminology lock. When verifying code examples in docs, follow the tiered procedure in `.agents/references/code-verification.md`.

## Directory Structure

```
├── AGENTS.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── SITE-ARCHITECTURE.md          # Detailed Astro/Starlight customizations
├── src/                          # Astro source files
│   ├── components/               # Custom Astro components
│   │   ├── community/            # Sections of the /community/ hub page (hero, courses, events, blog)
│   │   ├── overrides/            # Starlight component overrides
│   │   └── ...
│   ├── config/                   # Site configuration
│   ├── content/                  # Content collections
│   │   ├── catalog/              # Community catalog entries (one YAML per integration, zod-validated)
│   │   ├── courses/              # Course metadata (one YAML per course, zod-validated)
│   │   ├── events/               # Community event entries (one YAML per event, zod-validated)
│   │   └── docs/                 # Documentation content (Markdown/MDX)
│   │       ├── api/
│   │       │   ├── python/
│   │       │   │   └── _generated/   # Symlink to .build/api-docs/python
│   │       │   └── typescript/
│   │       │       └── _generated/   # Symlink to .build/api-docs/typescript
│   │       ├── assets/
│   │       ├── contribute/
│   │       ├── examples/
│   │       ├── integrations/
│   │       ├── labs/
│   │       ├── learning/         # Course lesson pages
│   │       └── user-guide/
│   ├── data/                     # Bot-maintained data (catalog-stats.json — updated by the
│   │                             #   catalog-stats workflow; do not hand-edit)
│   ├── layouts/                  # Custom layouts
│   ├── pages/                    # Astro pages (incl. integrations.astro — the /integrations page)
│   ├── plugins/                  # Remark/Rehype plugins
│   ├── styles/                   # Global styles
│   └── util/                     # Utility functions
├── astro.config.mjs              # Astro configuration
├── package.json                  # Node.js dependencies and scripts
├── tsconfig.json                 # TypeScript configuration
├── LICENSE
├── NOTICE
├── README.md
├── overrides/                    # Legacy MkDocs overrides (being migrated)
├── scripts/                      # Build and utility scripts (scripts/catalog/ — stats refresh
│                                 #   run by the weekly catalog-stats workflow)
├── test/                         # Test files
└── test-snippets/                # TypeScript snippet test files
```
### Directory Purposes


**IMPORTANT**: After making changes that affect the directory structure (adding new directories, moving files, or adding significant new files), you MUST update this directory structure section to reflect the current state of the repository.

## Development Workflow for Agents

### 1. Environment Setup
#### Prerequisites

- Python 3.10+
- Node.js 22+, npm

#### Setup and Installation

```bash
npm install
```

#### Building and Previewing

Generate the static site:

```bash
npm run build
```

Run a local development server at http://localhost:4321/:

```bash
npm run dev
```

### 2. Making Changes

1. **Create feature branch**: `git checkout -b agent-tasks/{ISSUE_NUMBER}`
2. **Implement changes** following the patterns below
3. **Run quality checks** before committing (pre-commit hooks will run automatically)
4. **Commit with conventional commits**: `feat:`, `fix:`, `refactor:`, `docs:`, etc.
5. **Push to remote**: `git push origin agent-tasks/{ISSUE_NUMBER}`

### 3. Quality Gates

Pre-commit hooks automatically run:
- Unit tests (via npm test)
- Format checking (via npm run format:check)
- Type checking (via npm run typecheck)

All checks must pass before commit is allowed.

## Coding Patterns and Best Practices

### Code Style Guidelines (for Typescript)

TypeScript formatting and import organization follow the same conventions as the TypeScript SDK; see [strands-ts/AGENTS.md](../strands-ts/AGENTS.md). Prettier enforces formatting (no semicolons, single quotes, 120-character lines, 2-space indent, ES5 trailing commas); order imports as external dependencies, then internal modules, then type-only imports.

One site-specific exception: files under `src/content/docs/` are limited to 90 characters per line, including template literal contents (not enforced by Prettier). See [.agents/references/mdx-authoring.md](../.agents/references/mdx-authoring.md).

### Code Examples in Documentation Pages

When adding or editing code examples in documentation pages, you MUST follow [.agents/references/mdx-authoring.md](../.agents/references/mdx-authoring.md). It is the authoritative reference for `<Tabs>`/`<Tab>` usage, `--8<--` snippet inclusion, snippet naming and scoping, callouts, frontmatter fields, line length, and validation commands.

For the underlying Astro/Starlight implementation (the snippets plugin, custom components, frontmatter banners), see [SITE-ARCHITECTURE.md](SITE-ARCHITECTURE.md).

## Agent-Specific Notes

### When Implementing Features

1. **Read task requirements** carefully from the GitHub issue
2. **Use existing patterns** as reference
3. **Run all checks** before committing (pre-commit hooks will enforce this)


### Integration with Other Files

- **CONTRIBUTING.md**: Contains testing/setup commands and human contribution guidelines
- **README.md**: Public-facing documentation, links to strandsagents.com
- **SITE-ARCHITECTURE.md**: Comprehensive documentation of Astro/Starlight customizations, components, and plugins
- **package.json**: Defines scripts for building, testing, and linting
- **src/config/navigation.yml**: Defines the navigation structure (loaded by `src/sidebar.ts` for Astro)

## Additional Resources

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [TSDoc Reference](https://tsdoc.org/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Strands Agents Documentation](https://strandsagents.com/)
- [TypeScript SDK](../strands-ts/)
