---
name: docs-planner
description: Identify documentation gaps and prioritize the docs backlog. Use when planning a docs improvement sprint, after signals surface repeated friction, when new SDK features ship without docs, or for periodic health assessment. Also triggers on "plan docs work", "what docs need writing", "prioritize the backlog", "docs health check", "what should we document next".
---

# Documentation Planner

Identify gaps in the docs site and produce a prioritized backlog.

## Inputs

- **Scope**: Area to assess — all docs, a specific section, or a feature area. Default: all.
- **Signals** (optional): GitHub issues, community questions, support threads.
- **Competitive context** (optional): What competitors document that we don't.

## Process

### Step 1: Inventory current docs

Read `site/src/config/navigation.yml` for the full navigation tree — this is the authoritative navigation source for the Astro site, loaded by `site/astro.config.mjs` via `site/src/sidebar.ts`. Glob `site/src/content/docs/**/*.{md,mdx}` for all content files. Classify each by content type (tutorial, how-to, reference, explanation, mixed) and coverage area (quickstart, tools, agents, multi-agent, deployment, etc.).

### Step 2: Identify gaps

Compare the inventory against:

- **SDK surface area**: Are all major features documented? Features without docs pages are gaps.
- **Diataxis completeness**: For each feature area, does documentation exist across all four types? A feature with reference but no tutorial has a gap.
- **Community signals**: If GitHub CLI is available, pull open issues labeled "documentation" from strands-agents/harness-sdk. Map questions to existing docs (unclear/hard to find) or missing docs (content gap).
- **Competitive comparison** (if provided): What do LangChain, CrewAI, Anthropic, and OpenAI document about equivalent features that we don't?

### Step 3: Prioritize

Score each gap on developer impact and effort:

- **P0 (do now)**: High impact, any effort. Quickstart, getting-started, core concepts.
- **P1 (do soon)**: Medium impact, low effort. Missing how-to guides for common tasks.
- **P2 (plan for)**: Medium impact, high effort. New tutorials, architectural explanations.
- **P3 (backlog)**: Low impact. Niche scenarios, edge case documentation.

### Step 4: Produce the backlog

Output as markdown:

```markdown
## Docs Backlog: [Scope]

**Generated:** [date]
**Pages inventoried:** [count]
**Gaps identified:** [count]

### P0: Do Now
- [ ] [Task] — [content type] — [target page] — [reason]

### P1: Do Soon
- [ ] [Task] — [content type] — [target page] — [reason]

### P2: Plan For
- [ ] [Task] — [content type] — [target page] — [reason]

### P3: Backlog
- [ ] [Task] — [content type] — [target page] — [reason]

### Coverage Matrix

| Feature Area | Tutorial | How-To | Reference | Explanation |
|---|---|---|---|---|
| Agent basics | Y | ~ | Y | N |
| Custom tools | Y | Y | Y | N |
| Multi-agent  | ~ | N | Y | ~ |

### Signal-Driven Insights
- [Theme from community signals mapped to specific doc gaps]
```

## What This Skill Does NOT Do

- Does not write docs (use docs-writer for that)
- Does not require external signal pipelines (works with local inventory alone)
- Does not auto-create tasks in external tools
