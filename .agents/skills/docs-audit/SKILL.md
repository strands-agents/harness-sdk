---
name: docs-audit
description: Assess a published or in-progress documentation page for quality, accuracy, and voice compliance. Use before rewriting a page, during periodic health checks, when community signals point to confusion, or when comparing against competitor docs. Also triggers on "audit this page", "assess the docs", "what's wrong with this page", "check docs quality", "review this doc page".
---

# Documentation Audit

Assess an existing documentation page. Produces a structured assessment with specific improvement recommendations.

**How this differs from docs-reviewer:** The docs-reviewer is a voice/style gate for drafts in progress (runs at the end of docs-writer). The docs-audit is an assessment tool for published pages: it checks accuracy against SDK source, identifies content gaps, and optionally compares against competitor docs. Use docs-audit to decide *what needs work*; use docs-reviewer to verify *that a draft is ready to ship*. For a line-by-line check that every code example and prose claim is true against the source, use docs-verifier.

## When to Use

- Before rewriting a doc page (understand current state first)
- When community signals point to confusion around a topic
- During periodic docs health checks
- When comparing Strands docs to competitor docs on the same topic

## Inputs

- **Target page**: File path in `site/src/content/docs/` or published URL
- **Content type**: If known. If not, classify it first.
- **Context** (optional): Community signals, GitHub issues, or specific concerns

## Process

### Step 1: Fetch and classify

Read the source file from `site/src/content/docs/` in this repo. If you need the published version and have web access, fetch from strandsagents.com.

Classify the content type (tutorial, howto, reference, explanation, mixed). Note: "mixed" is itself a finding. Pages that mix types are the most common structural problem.

### Step 2: Voice stack review

Walk through each layer of the voice stack defined in `../../references/voice-guide.md` against this page:

1. **Structure** — Does each section answer exactly one question? Are there sections that mix concerns?
2. **Framing** — Do section openings lead with the developer's goal, or with API descriptions?
3. **Register** — Does the tone match the content type? Flag tutorial/reference mismatches.
4. **Hard constraints** — Check for banned phrases, passive voice, hedging, terminology violations.
5. **Authenticity** — Does the page have structural variety and visible editorial choices?

### Step 3: Accuracy check

Follow the verification procedure in `../../references/code-verification.md`. Check imports, parameter names, types, defaults, and method signatures against SDK source.

**The SDK source is the source of truth.** Where the docs page contradicts the source, the docs are wrong by definition — flag the inconsistency under Accuracy Issues with the file/line in the SDK that the docs disagree with. Never reconcile in the other direction (do not "update" the source to match a docs claim).

Specific checks:
- Are code examples using current API signatures?
- Do import statements reference current package names and module paths?
- Are parameter names and types correct against the latest SDK source?
- Are any documented features deprecated or removed?
- Are internal cross-reference links working?
- **Snippet file conventions:** TypeScript code must live in sibling `.ts` snippet files (included via `--8<--`), never inlined in MDX. Each TypeScript fence should include both an imports snippet (`_imports.ts`) and a body snippet so the rendered block is self-contained. Verify that each `--8<-- "path:region"` directive references a real file with a matching `[start:region]`/`[end:region]` pair. Flag inlined TypeScript or missing imports includes as structural issues.

### Step 4: AI-readability check

- Is the page self-contained? (Could an AI assistant use this page alone?)
- Is essential context at the top?
- Is inline code properly formatted with backticks?
- Is terminology consistent with the terminology lock?
- Are language-specific identifiers in shared prose using the `<Syntax>` component rather than being spelled out manually with language labels?

### Step 5: Competitive comparison (optional)

**When to run.** Only on conceptual or how-to pages covering tasks other agent frameworks also address (agents, tools, hooks, sessions, streaming, multi-agent, structured output). Skip for Strands-internal architecture, reference/API, and governance pages.

**How.**
1. Fetch 1–3 relevant comparator pages via web access (cite URL + access date in the report).
2. Compare on three axes — coverage, depth, voice — one observation per axis.
3. Output one-line gaps under `### Competitive Notes`: *"Add [topic] — comparators X, Y cover it; we don't."*

Don't imitate voice; only adopt structure or coverage. If a comparator does something we shouldn't (hype, non-deterministic shown as deterministic), note it so future audits don't drift toward it.

## Output Format

```markdown
## Docs Audit: [Page Title]

**URL:** [published URL or file path]
**Content type:** [classified type]
**Overall verdict:** [Strong / Needs work / Significant gaps]

### Voice Stack Assessment

| Layer | Score | Key Finding |
|-------|-------|-------------|
| Structure | /warning/x | [one-line finding] |
| Framing | /warning/x | [one-line finding] |
| Register | /warning/x | [one-line finding] |
| Constraints | /warning/x | [count of violations] |
| Authenticity | /warning/x | [one-line finding] |

### Accuracy Issues
- [list specific inaccuracies found, or "None detected"]

### AI-Readability Issues
- [list specific issues, or "Passes all checks"]

### Recommended Actions
1. [Highest priority fix]
2. [Second priority]
3. [Third priority]

### Competitive Notes (if checked)
- [observations from competitor comparison]
```

## What This Skill Does NOT Do

- Does not rewrite the page (use docs-writer for that)
- Does not commit changes
- Does not modify the docs repo
