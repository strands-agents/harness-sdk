# Voice Guide

Five-layer writing voice reference for all Strands Agents documentation and developer-facing content. Applies to SDK docs, blog posts, release notes, READMEs, strategy documents, and any prose aimed at developers or technical leadership.

When writing or reviewing any developer-facing content, walk through the five layers in order.

## Table of Contents

- [Layer 1: Structure](#layer-1-structure-denos-one-section-one-question)
- [Layer 2: Framing](#layer-2-framing-stripes-more-you-than-i)
- [Layer 3: Register](#layer-3-register-googles-knowledgeable-friend--shopify-polaris-tone-by-situation)
  - [Tutorials](#tutorials-learning-oriented)
  - [How-to guides](#how-to-guides-problem-oriented)
  - [Reference](#reference-information-oriented)
  - [Explanation](#explanation-understanding-oriented)
  - [Error documentation](#error-documentation-elm-compiler-philosophy)
  - [Blog posts and announcements](#blog-posts-and-announcements)
  - [Strategy documents](#strategy-documents-and-internal-writing)
- [Layer 4: Hard Constraints](#layer-4-hard-constraints)
  - [Type-aware constraint overrides](#type-aware-constraint-overrides)
  - [Banned phrases](#banned-phrases-ai-tells-and-hype)
  - [Code examples](#code-examples)
    - [Documenting non-deterministic behavior](#documenting-non-deterministic-behavior)
- [Layer 5: Authenticity](#layer-5-authenticity)
- [Agent SDK-Specific Guidance](#agent-sdk-specific-guidance)
  - [Multi-language documentation](#multi-language-documentation-python--typescript)
  - [Multi-agent patterns](#multi-agent-patterns)
  - [Streaming and async](#streaming-and-async)
  - [Version sensitivity](#version-sensitivity)
- [Documentation for Humans and AI](#documentation-for-humans-and-ai)
- [Self-Check](#self-check)

---

## Layer 1: Structure (Deno's "one section, one question")

Before writing any prose, define the scope.

Every section answers exactly one question a developer is asking. If a section tries to answer two questions, split it. If a section doesn't clearly answer a question, it shouldn't exist.

Test: can you state the section's purpose as a single question? "How do I add custom tools to my agent?" is good scope. "How do I add tools and configure streaming?" is two sections.

Page-level structure follows the content type (see Layer 3). Section-level structure follows this rule regardless of type.

### Outline before writing

For any doc page longer than a few paragraphs, produce an outline first. Each item in the outline is the question that section answers. Review the outline for scope creep before drafting prose.

## Layer 2: Framing (Stripe's "More You Than I")

Every section opens with the developer's goal, not the API's capability.

The developer's problem or intent comes first. The tool, method, or pattern comes second. This is the difference between documentation that teaches and documentation that catalogs.

**Yes:**
- "You create an agent with custom tools by passing them to the constructor."
- "To retry failed tool calls automatically, configure a retry strategy."
- "When your agent needs to maintain state across turns, use session management."

**No:**
- "The Agent class accepts a tools parameter in its constructor."
- "The retry_strategy parameter configures automatic retry behavior."
- "Session management provides state persistence across conversation turns."

The "no" versions aren't wrong. They're reference-style descriptions, appropriate for API reference tables. But in tutorials, guides, and explanations, lead with "you."

### The first-sentence test

After drafting any section, read the first sentence. Does it describe what the developer wants to accomplish, or what the system does? If it's the latter, rewrite it.

## Layer 3: Register (Google's "knowledgeable friend" + Shopify Polaris tone-by-situation)

The base register is a knowledgeable friend: someone who knows the system well, respects the developer's intelligence, and doesn't waste their time. Warm but not chatty. Expert but not condescending. Direct but not curt.

The specific tone varies by content type. Classify every page or section before writing.

### Tutorials (learning-oriented)

**Register:** Patient, encouraging, explains "why" alongside "how." More conversational than other types. You can use phrases like "Now let's..." and "Notice how..." because the narrative arc matters.

**Structure:** Linear progression. Each step builds on the previous one. Prerequisites stated upfront. Expected outcome described before the steps begin. End with "what you built" summary and pointers to next topics.

**What to include:** Every step the developer needs, even "obvious" ones. Context for why each step matters. Expected output after key steps. For non-deterministic output, follow the patterns in "Documenting non-deterministic behavior" under Code examples.

**What to exclude:** Alternative approaches (save for how-to guides). Deep architectural reasoning (save for explanation pages). Exhaustive parameter lists (link to reference).

**Voice markers:** "You" throughout. Short paragraphs. Code blocks after brief setup sentences. Occasional sentence fragments for emphasis.

### How-to guides (problem-oriented)

**Register:** Efficient, practical, assumes baseline knowledge. No hand-holding, but clear prerequisites. Action-oriented.

**Structure:** Goal stated in title or opening line. Prerequisites listed. Numbered steps. Expected result at the end. Troubleshooting section if common pitfalls exist.

**What to include:** The fastest path to the goal. Required configuration. Error handling for likely failure modes. Links to reference for options you're not covering.

**What to exclude:** Conceptual background (link to explanation pages). Step-by-step basics the audience already knows. Multiple approaches unless the choice materially affects the outcome.

**Voice markers:** Imperative mood for instructions ("Configure the retry strategy" not "You should configure the retry strategy"). Terse transitions. Code-heavy.

### Reference (information-oriented)

**Register:** Formal, exhaustive, every word load-bearing. This is the contract between the SDK and the developer. Accuracy is more important than readability.

**Structure:** Consistent format across all reference pages. For each item: description, parameters (with types, defaults, constraints), return value, errors/exceptions, example. Tables for parameter lists.

**What to include:** Every parameter, every return type, every error condition. Default values. Constraints and edge cases. Version information if behavior changed.

**What to exclude:** Narrative ("let's see how this works"). Recommendations ("we suggest using X"). Conceptual motivation (link to explanation pages).

**Voice markers:** Third person for descriptions ("Creates a new agent instance"). Present tense. No contractions. Consistent terminology (never synonym variation).

### Explanation (understanding-oriented)

**Register:** Thoughtful, opinionated, shows tradeoffs. This is where design decisions become visible. You're having a design discussion, not giving instructions.

**Structure:** Open with the problem or tension ("Hooks exist because system prompts can't enforce behavior at runtime"). Present the design choice. Show alternatives considered. Explain tradeoffs. Connect to practical implications.

**What to include:** The "why" behind design decisions. Tradeoffs and constraints that shaped the approach. Connections to related concepts. Diagrams for system-level architecture.

**What to exclude:** Step-by-step instructions (link to how-to guides). Parameter details (link to reference). Getting-started content (link to tutorials).

**Voice markers:** "We" for design decisions ("We chose X because..."). Longer paragraphs than other types. Visible editorial judgment. Sentence fragments for emphasis after complex passages.

### Error documentation (Elm compiler philosophy)

**When to document:** when the developer can't figure out what to do next from the error message alone. If the message is self-explanatory and the fix is "do what it says," leave it out — documentation should add information the developer doesn't already have.

**Register:** Calm, diagnostic, forward-looking. The developer hit a wall. Help them understand what happened, why, and what to do next.

**Structure:** What the error means (plain language, not just the error string). Why it happens (common causes). How to fix it (specific steps). How to prevent it (if applicable).

**What to include:** The exact error message or behavior. The most likely cause. A working fix with code. Edge cases if the obvious fix doesn't apply.

**What to exclude:** Blame or judgment ("you forgot to..."). Excessive detail about internal error handling. Workarounds for bugs that should be fixed in the SDK.

**Voice markers:** Direct but not alarming. "This error means..." not "ERROR: Critical failure in..." Active voice for fixes ("Add the missing import" not "The missing import should be added").

### Blog posts and announcements

**Register:** Conversational, peer-to-peer, technically grounded. Lead with what the technology does, not with enthusiasm about it. If something is notable, let the technical detail carry the weight.

**Structure:** Open with the problem or context, stated practically. Follow a problem-solution arc. End with a concrete call to action (try it, check the repo, open an issue).

**Voice markers:** First-person plural ("we") for team announcements. "You" when addressing the reader directly. Short paragraphs. One idea per paragraph.

### Strategy documents and internal writing

The audience shifts from external developers to technical leadership. The core principles hold: respect their time, be direct.

**Register:** Direct, data-grounded, forward-looking. State recommendations as decisions, not preferences.

**Structure:** Problem statement (one tight paragraph) → Recommendation (one or two sentences) → Strategy (approach and tradeoffs) → Alternatives considered → Next steps (concrete actions, owners, dates).

**Voice markers:** Give the punchline early. Specificity signals you've done the work ("adoption reached 70% in Q1" not "adoption grew significantly"). No hedging on recommendations you believe in.

## Layer 4: Hard Constraints

These apply to all content types unless a type-specific override is noted. They are mechanically checkable and Vale-enforceable.

### Type-aware constraint overrides

Some constraints flex by content type. The defaults below are strict; these overrides relax specific rules where the content type demands it.

| Constraint | Tutorial | How-To | Reference | Explanation | Error docs |
|-----------|----------|--------|-----------|-------------|------------|
| Passive voice | Avoid | Avoid | **Allowed** (standard register) | Avoid | Avoid |
| Sentence length (30 words) | Enforce | Enforce | Enforce | **Relaxed to 40 words** (ideas need room) | Enforce |
| "More You Than I" framing | Enforce | Enforce | **Exempt** (third-person register) | Enforce with "we" | Enforce |
| Contractions | Use freely | Use freely | **Avoid** | Use freely | Use freely |
| Hedging ban | Enforce | Enforce | Enforce | **Soften** (tradeoff discussion needs nuance) | Enforce |

When Vale flags a passive construction in a reference page, it's a false positive. When it flags one in a tutorial, it's a real issue. Classify the page's content type from its structure and apply the matching column.

### Banned phrases (AI tells and hype)

Never use these in any context:

**AI hedge phrases:** "notably," "importantly," "it's worth noting," "it's important to understand," "delve," "delve into," "comprehensive," "remarkably," "it bears mentioning," "one might consider," "it should be noted"

**Hype and filler:** "powerful," "robust," "seamlessly," "effortlessly," "elegant," "game-changing," "groundbreaking," "revolutionary," "we're thrilled to announce," "push the frontier," "cutting-edge," "state-of-the-art," "leverage" (as a verb), "utilize" (use "use")

**Vague approval:** "This is powerful." "This is really useful." "This makes it easy to..."

If a feature works well, show it working well. Don't narrate your approval.

### No em-dashes

Replace em-dashes with colons (for elaboration), commas or parentheses (for asides), or restructure the sentence. This is a hard rule.

### No emoji

No emoji in documentation, tutorials, guides, reference, error docs, or blog posts. Let the technical content carry the weight. Emoji introduce tonal inconsistency (a party popper in the quickstart sets a register nothing else maintains) and reduce trust signal for experienced developers evaluating the SDK.

### Active voice

Use active voice throughout. "The hook extracts tool names" not "tool names are extracted by the hook." Exception: reference docs use passive voice as standard register (see type-aware overrides above). "The agent is configured by passing a tools list" is correct reference style.

### No hedging on facts

Say "the hook extracts tool names," not "the hook can be used to extract tool names." If it's true, state it directly. Hedging erodes developer trust.

### Consistent terminology

See `terminology.md` in this directory for the canonical term for each concept. Never vary terminology for stylistic reasons. "Tool calling" in section one and "function invocation" in section three is a bug, not variety.

### Code examples

**Completeness requirement (Stripe principle):** Every code example must be contextually complete. A developer should be able to copy the block, paste it into a file, and run it. This means: imports present, variables defined, realistic values (not `foo`/`bar`/`my_var`), and any required setup included or linked.

**Self-explanatory code (Deno principle):** If a code example needs surrounding prose to explain what it does, it's not a good example. Rewrite the code until the intent is clear from the code itself. Comments explain *intent* ("# Retry up to 3 times with exponential backoff"), not mechanics ("# Call the retry function").

Keep snippets focused on one concept per block. Use real tool names and realistic values from the actual SDK.

For code verification procedures, see `code-verification.md` in this directory.

#### Documenting non-deterministic behavior

Agent behavior is non-deterministic: the same prompt can produce different model responses, tool selections, and reasoning paths. Documentation must acknowledge this without undermining developer confidence. The principle: **show deterministic code exactly, label non-deterministic parts explicitly.**

Keep the example and its expected output close together. The labels `Typical` and `Example` already convey variability — don't restate that with parenthetical disclaimers.

**Pattern 1 — Model output.** Append the expected response as a comment under the code:

```python
result = agent("What's the square root of 144?")
print(result)

# Typical output:
# "The square root of 144 is 12."
```

Never write "the agent will respond with..." — it *might* respond with that.

**Pattern 2 — Tool selection.** Show possible tool selection, not guaranteed execution. Describe tools the agent *can* use for a task without promising that a specific call will happen. Prefer capability language like "can use" or "may use" over deterministic language like "will call."

Example:

```md
The agent can use `calculator` for arithmetic.
```

**Pattern 3 — Multi-step reasoning.** When documenting agents that chain multiple tool calls, show one representative trace as ordered steps in a comment under the code:

```python
result = agent("Find the lifecycle hooks doc and summarize it")

# Example:
# 1. Agent calls search_docs with query "hooks lifecycle"
# 2. Agent calls read_file on the top result
# 3. Agent synthesizes a response
```

**Pattern 4 — Structured output.** When an agent uses structured output (Pydantic models), the schema is deterministic even though the content values vary. Show the schema as exact code, then show example values in a separate adjacent block:

```python
class ResearchResult(BaseModel):
    summary: str
    sources: list[str]
    confidence: float
```

Example values:

```json
{
  "summary": "Three studies converge on ...",
  "sources": ["doi:10.1/abc", "doi:10.2/def"],
  "confidence": 0.82
}
```

**When NOT to flag non-determinism:** Pure SDK configuration (agent creation, tool registration, hook setup) is deterministic. Don't add "typical output" labels to code that produces the same result every time.

### Punctuation

Serial comma, always. Present tense for documentation (not "this will create" but "this creates"). Contractions are fine in tutorials and guides, avoid in reference.

## Layer 5: Authenticity

After drafting, review for signals that the prose was generated without editorial judgment.

### Structural sameness

Does every section follow the same pattern (intro sentence → detailed explanation → concluding sentence)? Break the pattern. Some sections should open with code. Some should open with a question. Some should be three sentences long. Vary the rhythm.

### Perfect-grammar uniformity

Real technical writers use sentence fragments for emphasis. They start sentences with "But." They write "Nope, that won't work" in a troubleshooting section. If every sentence is grammatically complete and structurally parallel, it reads as machine-generated.

Allow fragments. Allow casual asides. Allow opinions stated without qualification.

### Visible editorial judgment

Show that a human made choices. "We chose event-based hooks over middleware because middleware patterns don't compose well in async agent loops" is better than "Hooks use an event-based architecture." The first reveals thinking. The second catalogs facts.

When explaining design decisions, name the alternatives you rejected and why. This signals intellectual honesty and editorial judgment simultaneously.

### Verbosity check

First drafts tend toward verbosity. After drafting, cut aggressively: remove setup sentences that restate what the reader already knows, transitions between sections (headings do that job), and concluding sentences that summarize what was just said. The target is the shortest version that preserves all information and reads naturally. (Heuristic: well-edited technical docs are typically 40-50% shorter than their first draft.)

### Opinionated framing

Replace "you could use X or Y" with "use X. Y works too, but X handles [common case] better." Make a recommendation. If you don't have an opinion, research until you do, or acknowledge the tradeoff directly.

## Agent SDK-Specific Guidance

### Multi-language documentation (Python + TypeScript)

Strands ships both a Python and TypeScript SDK. Most doc pages show code in both languages via tabs. This creates specific challenges.

**When to show both languages:** Concept pages (tutorials, how-to, explanation) should show both languages in tabs when the feature exists in both SDKs. Reference pages are per-language (the Python API reference is separate from the TypeScript API reference).

**When to show one language:** If a feature only exists in one SDK, document it in that language only and note availability: "Available in the Python SDK. TypeScript support is tracked in [issue link]." Don't show empty tabs or placeholder code.

**API parity is a goal, not a guarantee.** The two SDKs may have different parameter names, different import paths, or different API surfaces for the same concept. Never assume that Python code translates directly to TypeScript. Verify each language independently against its own SDK source.

**Language-specific patterns:**
- Python uses `@tool` decorator, TypeScript uses `tool()` function or `ZodTool` class
- Python uses snake_case (`retry_strategy`), TypeScript uses camelCase (`retryStrategy`)
- Python has `from strands import Agent`, TypeScript has `import { Agent } from '@strands-agents/sdk'` (verify current package name)
- Error handling differs: Python raises exceptions, TypeScript may use different patterns

**Prose between tabs should be language-neutral — or use `<Syntax>`.** When shared prose needs to reference a language-specific identifier, use the `<Syntax>` component rather than spelling out both variants manually. This adapts to the reader's language selection and keeps prose clean. For introductory sentences before tabs, you can also write language-neutral prose ("Configure a retry strategy:") and let the code speak for itself.

**Never name the language inside its own tab.** The reader selected the tab; they know which language they're reading. State facts directly without prefixing the language name. The tab itself provides that context.

#### Where divergence content lives in the page structure

The page's heading structure should read the same in both languages. A reader on either tab should see the same table of contents. Divergence is content, not structure — keep it **inside the existing `<Tab>`**: same heading on both sides, with per-tab prose and code carrying the difference.

Avoid:
- **A heading that exists in only one language.** It produces an empty stub in the other language's table of contents and breaks the page's symmetry. Demote it under a shared parent or fold it into the tab.
- **A heading suffixed with a language name** (e.g. `### Subclassing the Retry Strategy (TypeScript)`, `## Tool Caching: Python`). The table of contents should describe the *concept*, not the language.

### Multi-agent patterns

Multi-agent documentation faces a combinatorial problem: patterns compose, so documenting every combination is impossible. Document the building blocks clearly (individual agent setup, tool passing, state sharing) and provide 2-3 composed examples as architecture patterns. Link patterns to each other rather than duplicating setup code.

### Streaming and async

Streaming is where agent frameworks diverge most from traditional APIs. A REST endpoint returns a response; a streaming agent returns a *process*. Documentation must capture the process, not just the result.

**Principle: intermediate states are more valuable than final output for teaching.** A developer debugging a streaming agent needs to understand what happens between the prompt and the response, not just the response itself.

**Ordered examples, not timestamps.** Show the *sequence* of events, not specific times. Timestamps create the illusion of precision when all that matters is order, and they go stale or look invented across different model/tool/hardware combinations.

```
1. Agent receives prompt
2. Agent begins reasoning (streaming text tokens)
3. Agent calls calculator tool
4. Tool returns result
5. Agent incorporates result, continues streaming
6. Agent completes response
```

If the doc genuinely needs to talk about latency (e.g., a streaming-performance page), measure it for that specific page rather than sprinkling fabricated timestamps into general examples.

**Event-type documentation.** When documenting stream events, show what the developer receives at each stage. Don't just document the final aggregated response.

**Bidirectional streaming.** For real-time interfaces (voice, interactive), document both the input and output streams. Show the event loop pattern, not just the output consumption pattern.

### Version sensitivity

Agent SDK APIs change frequently. Don't inline version requirements ("requires strands-agents >= 1.2.0", "new in version X") in the body of docs — they age poorly and create inconsistent claims across the doc set. If a page genuinely needs version-gated content, raise it on the PR rather than encoding the version in prose.

## Documentation for Humans and AI

Developers consume docs in two ways now: reading them directly, and through AI intermediaries (Cursor @docs, GitHub Copilot #fetch, Claude Code MCP). These rules optimize for both audiences simultaneously. Every principle below makes docs better for human readers *and* more accurately parseable by AI tools.

### Self-contained pages

Each page must stand alone. An AI assistant may fetch a single page without navigation context. A human developer may land on any page from a search result.

**Self-containment checklist** (check all five before finalizing any page):

1. **Context at top**: The first paragraph states what this page covers and who it's for, without assuming the reader came from another page.
2. **Prerequisites explicit**: Any required setup, installed packages, or prior knowledge is stated, not implied. Link to the prerequisite page rather than saying "as shown previously."
3. **No forward/backward references as load-bearing walls**: "As we discussed in the previous section" is never the only way to understand a concept. If you reference another page, include enough inline context that the reader can continue without clicking.
4. **Key terms defined or linked on first use**: Don't assume the reader knows "agent loop" means the SDK's reasoning cycle. Define it inline or link to the terminology on first use per page.
5. **Code examples self-contained**: Each code block includes necessary imports and setup. A developer should be able to copy-paste and run without hunting for context in other code blocks on other pages.

### Terminology consistency

AI intermediaries infer relationships between terms. Using "API key," "access token," and "auth credential" interchangeably in the same doc set produces hallucinated conflation in AI-generated code suggestions. One concept, one term, everywhere. Check against `terminology.md` in this directory.

### Code formatting precision

Inline code must be properly backtick-formatted. AI parsers treat unformatted code tokens as prose, leading to mangled suggestions. `Agent()` not Agent(). `tools` parameter not tools parameter.

### Frontmatter metadata

Every doc page should include:
```yaml
---
title: "Page Title"
description: "One-sentence description (140-160 chars)"
---
```

See `mdx-authoring.md` in this directory for the full frontmatter schema including optional fields.

## Self-Check

Before finalizing any piece of documentation, verify:

1. Content type is classified and the correct register is applied.
2. Type-aware constraint overrides checked (passive voice OK in reference, longer sentences OK in explanation).
3. Every section answers exactly one question.
4. First sentence of every section describes the developer's goal (except reference).
5. No banned phrases (AI tells, hype, filler).
6. No em-dashes.
7. No emoji.
8. Active voice throughout (except reference, per overrides).
9. No hedging on factual statements.
10. Terminology matches `terminology.md` in this directory.
11. Code examples are contextually complete (Stripe principle) and self-explanatory (Deno principle).
12. Non-deterministic output is labeled per the patterns in "Documenting non-deterministic behavior."
13. Page passes the self-containment checklist (context at top, prerequisites explicit, no load-bearing cross-references, terms defined, code self-contained).
14. Structural variety exists (not every section follows the same pattern).
15. At least one visible editorial choice (tradeoff named, alternative rejected, opinion stated).
16. Draft reviewed for verbosity: cut setup, transitions, and summaries that don't add information.
