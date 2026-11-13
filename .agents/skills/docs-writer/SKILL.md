---
name: docs-writer
description: Draft or rewrite Strands Agents documentation pages. Use when writing new doc pages, rewriting pages that failed audit, drafting sections for existing pages, or writing blog posts and release notes about Strands. Also triggers on "write a doc", "draft a page", "rewrite the quickstart", "add a tutorial for X", "document this feature".
---

# Documentation Writer

Draft or rewrite Strands Agents documentation following the five-layer voice stack.

## Inputs

- **Content type**: tutorial, howto, reference, explanation, blog (required)
- **Topic**: What this page covers (required)
- **Target file**: Path in docs repo where this will live (if known)
- **Existing content**: Current page to rewrite (if rewriting)
- **Context** (optional): Community signals, GitHub issues, or positioning themes motivating this work

## Process

### Step 1: Load voice context

Read these files before writing anything:
1. `../../references/voice-guide.md` (the full voice stack)
2. `../../references/terminology.md` (canonical terms)

If rewriting, read the current published page as a baseline.

### Step 2: Outline

Produce an outline where each item is the question that section answers.

- **Tutorial**: step-by-step journey toward a working result
- **How-to**: prerequisites, steps, expected result
- **Reference**: API surface (classes, methods, parameters)
- **Explanation**: problem, design choice, tradeoffs, implications

Each section answers one question. No mixed-type sections. Review for scope creep.

### Step 3: Draft

Write each section following the outline.

- First sentence of every section describes the developer's goal (framing layer)
- Use the tone appropriate for this content type (register layer)
- Code examples: runnable with real Strands imports and realistic values
- For agent responses, label non-deterministic output following the patterns in `voice-guide.md` under "Documenting non-deterministic behavior" (typical output as a comment under the code; capability language for tool selection).
- Comments explain intent, not mechanics
- One concept per code block
- Match snippet length to the complexity of what's being demonstrated. Bias toward brevity. If setup machinery dwarfs the feature being shown, the snippet is overweight.
- Snippets must be copy-paste-runnable: imports present, variables defined, no missing context.
- Prefer prose over a snippet for trivial API surface. A single property, a single method call, or a one-line config change is often clearer as inline backtick code in a sentence than as a dedicated code block. Reach for a snippet when the shape, ordering, or interaction between calls carries the lesson.
- Diagrams follow `../../references/diagrams.md`. Concept diagrams are hand-authored SVGs rendered with `<Diagram>`; use the `docs-diagrams` skill to draw them. ` ```mermaid ` fences are fine for quick or short-lived diagrams. Never use ASCII art or box-drawing characters for diagrams.

### Step 3b: Apply MDX formatting

Apply MDX formatting patterns from `../../references/mdx-authoring.md` — especially Tabs/Tab syntax, the `<Syntax>` component for inline language-specific identifiers, snippet includes, and callout syntax (default to inline prose; callouts are rare).

When shared prose needs to reference a language-specific identifier (method name, parameter, class, etc.), use `<Syntax py="..." ts="..." />`. This keeps prose clean and adapts to the reader's language selection. Never spell out both variants manually in prose.

**TypeScript code is never inlined in MDX.** All TypeScript examples live in runnable `.ts` snippet files alongside the page and are included via `--8<--` directives. Two files per page:

- **`<page>_imports.ts`** — one named snippet region per example's import set. Every example gets its own imports snippet so the rendered block is self-contained.
- **`<page>.ts`** — body snippets scoped in blocks.

In the MDX, each TypeScript code fence contains two `--8<--` includes (imports + body) inside a single fence so it renders as one copy-pasteable block. Every example must include its imports — a body-only include that omits the import line produces a snippet that isn't runnable.

Read `../../references/mdx-authoring.md` ("Snippet Inclusion" and "TypeScript Snippet Scoping") for the full specification. Look at any existing page with TypeScript tabs in the same directory for the concrete file layout.

Python code may be inlined directly in the MDX since Python files in the docs tree don't go through a type-checker.

### Step 4: Constrain

Check the **type-aware constraint overrides table** in the voice guide first. The content type determines which rules are strict vs relaxed.

Then self-check against hard constraints:
- No banned phrases (AI tells, hype words)
- No em-dashes
- No emoji
- Active voice (unless reference type, per overrides table)
- No hedging on facts (softened for explanation tradeoff discussions)
- Terminology matches the lock file
- Code examples are contextually complete (imports present, runnable)
- Code examples use proper backtick formatting
- All prose outside a `<Tab>` is language-neutral. No Python or TypeScript parameter names, no language-specific syntax (e.g. `preserve_context=False` or `preserveContext: false`). Describe the concept in plain English; the code inside each tab shows the language-specific spelling.
- Headings describe the concept, never the API. No parameter names or syntax in headings.
- Never name the language inside its own tab. The reader selected the tab; they already know.

### Step 4b: Verify code accuracy

Follow the verification procedure in `../../references/code-verification.md`.

Do not skip this step. Plausible-but-wrong code examples erode developer trust faster than missing documentation.

### Step 5: Authenticate

Review the draft for machine-generated feel:
- Break structural sameness (vary section openings, use fragments, vary length)
- Add visible editorial judgment (name rejected alternatives, state opinions)
- Cut aggressively (first drafts are always too long)
- Replace "you could use X or Y" with a recommendation

### Step 6: Metadata

Add frontmatter following the schema documented in `../../references/mdx-authoring.md` ("Frontmatter Schema"). At minimum:

```yaml
---
title: "[title]"
description: "[140-160 char description for SEO]"
---
```

Add optional fields (`languages`, `community`, `experimental`, `integrationType`, `category`, `redirectFrom`, `tags`, `sourceLinks`) only when applicable. Don't add fields the schema doesn't validate — Zod silently strips unknown keys at build time.

### Step 7: Run docs-reviewer

Run the docs-reviewer skill on the completed draft. Address any findings before presenting the draft.

## Output

Present the completed draft as:
1. The full page content
2. A brief note on voice choices made (register, key editorial decisions)
3. Any open questions for PM review (terminology, scope, accuracy concerns)

## Git workflow

Follow the git workflow described in the repo's `AGENTS.md` and `CONTRIBUTING.md`.

## What this skill does NOT do

- Auto-commit without human review
- Generate reference docs from code (separate auto-generation concern)
- Publish or deploy docs

## Gotchas

- **Never inline TypeScript in MDX.** TypeScript examples live in sibling `.ts` snippet files and are included via `--8<--` directives. Inlined TypeScript fails review. See Step 3b and `mdx-authoring.md`.
- Always verify code against SDK source. The most common failure mode is plausible imports that don't exist or parameters with wrong names.
- Terminology lock is strict. "Hook" not "callback." "Plugin" not "middleware." "Tool" not "function." Check before drafting.
- The constraint overrides table relaxes different rules per content type. Don't apply tutorial constraints to reference pages.
- Tabs syntax in MDX is finicky. Match the exact pattern from `mdx-authoring.md` or builds will break.
- Cut aggressively. First drafts are always 30-50% too long. The authenticity pass is where most quality comes from.
