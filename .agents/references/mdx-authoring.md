# MDX Authoring Patterns

Practical reference for writing documentation in this repo. This site uses Astro + Starlight with MDX.

## Auto-Imported Components

`<Tabs>` and `<Tab>` are globally available — no import statement needed. Tabs with matching labels auto-sync across the page.

```mdx
<Tabs>
  <Tab label="Python">
    ```python
    from strands import Agent
    agent = Agent(tools=[my_tool])
    ```
  </Tab>
  <Tab label="TypeScript">
    ```typescript
    --8<-- "user-guide/concepts/agents/example.ts:basic_agent"
    ```
  </Tab>
</Tabs>
```

`<Syntax>` is also globally available. Use it when shared prose needs to reference a language-specific identifier — any method name, parameter, class name, or short expression that differs between Python and TypeScript:

```mdx
Use <Syntax py=".as_tool()" ts=".asTool()" /> to customize the tool name.
The <Syntax py="Agent.retry_strategy" ts="Agent.retryStrategy" /> parameter controls retry behavior.
```

Renders as inline `<code>` by default. Pass `plain` for plain text. Reacts live to the global language toggle — no page reload.

**When to use `<Syntax>` vs `<Tabs>`:**
- `<Syntax>`: single identifier or short expression that differs by language, embedded in a prose sentence.
- `<Tabs>`: code blocks, multi-line examples, or content that's structurally different between languages.

Never spell out both language variants manually in prose. Use `<Syntax>` instead.

For other Starlight components (`Aside`, `Card`, `CardGrid`, `LinkCard`, `Icon`, `Badge`), use explicit imports:

```mdx
import { Card, CardGrid } from '@astrojs/starlight/components';
```

## Snippet Inclusion

Code lives in runnable source files; the MDX page references named regions of those files. Snippet source files live alongside the page that includes them, with the same base name (`agent-loop.mdx` pulls from `agent-loop.ts`). **Imports go in a sibling `*_imports.ts` file**; the body lives in the main `.ts` file. The MDX block pulls both — imports first, then body — so a single rendered code block shows imports + usage.

Snippet names use `snake_case` (build-time identifiers, not source code) and follow `<feature>_<variant>` for bodies, plus `_imports` suffix for the matching import set.

**1. Imports file** — one snippet per import set, named `<name>_imports`. Add `// @ts-nocheck` at the top *only* when the same identifier is intentionally re-imported across multiple snippets in this file:

```typescript
// traces_imports.ts
// --8<-- [start:code_configuration_option1_imports]
import { Agent } from '@strands-agents/sdk'
// --8<-- [end:code_configuration_option1_imports]
```

**2. Body file** — runnable code, body snippets wrapped in functions for scoping (see "TypeScript Snippet Scoping" below):

```typescript
// traces.ts
async function codeConfigurationOption1() {
  // --8<-- [start:code_configuration_option1]
  const agent = new Agent({
    systemPrompt: 'You are a helpful AI assistant',
  })
  // --8<-- [end:code_configuration_option1]
}
```

**3. MDX page** — pull both into **one** code block. Both `--8<--` directives go inside a single ` ```typescript ` fence, separated by a blank line. The reader sees imports above the body in one continuous, copy-pasteable code box:

````markdown
```typescript
--8<-- "user-guide/observability-evaluation/traces_imports.ts:code_configuration_option1_imports"

--8<-- "user-guide/observability-evaluation/traces.ts:code_configuration_option1"
```
````

**Common mistake — do not** wrap each include in its own fence. Two fences render as two disconnected code blocks with a visible gap, which breaks the copy-paste-as-one-unit affordance:

````markdown
<!-- WRONG: renders as two disconnected blocks -->
```typescript
--8<-- "user-guide/observability-evaluation/traces_imports.ts:code_configuration_option1_imports"
```

```typescript
--8<-- "user-guide/observability-evaluation/traces.ts:code_configuration_option1"
```
````

Only the code between markers is rendered. Paths inside the `--8<--` directive are always resolved relative to `site/src/content/docs/`.

**When to skip the imports file:** the page renders no TypeScript snippets, *or* every snippet body genuinely has zero external imports. Otherwise, write the imports file — relying on the imports at the top of the body `.ts` is wrong, since those lines live above the `[start:...]` marker and never appear in rendered docs.

## Callout Syntax

Starlight-native admonitions. **Use sparingly** — callouts are visually loud and reset the reader's flow. In most cases inline prose is the better choice; reach for a callout only when the information genuinely needs to break frame. Overusing `caution`/`danger` in particular trains readers to ignore them.

When you do use one, pick the level that matches consequence:

- `:::note` — context the reader needs but might miss; non-actionable. *Use for:* clarifications, links to related concepts.
- `:::tip` — an optional improvement or shortcut. *Use for:* performance hints, idiomatic alternatives, "you can also…" suggestions.
- `:::caution` — something that will work but has a non-obvious gotcha or cost. Strongest when the failure is silent or hard to diagnose (wrong-but-not-broken output, a config that degrades behavior without erroring) and the reader could plausibly hit it on the happy path.
- `:::danger` — even rarer. Only for actions that destroy work, lose data, or have no recovery path.

```markdown
:::note[Optional Title]
Informational content.
:::

:::tip
Helpful suggestion.
:::

:::caution
Proceed carefully.
:::

:::danger[Breaking Change]
This will break existing code.
:::
```

## Frontmatter Schema

Required fields:

```yaml
---
title: "Page Title"
description: "Short description for SEO (140-160 chars)"
---
```

Optional fields (validated by Zod in `site/src/content.config.ts`):

| Field | Type | Purpose |
|-------|------|---------|
| `languages` | `string \| string[]` | Feature only available in specific SDK language(s) |
| `community` | `boolean` | Marks page as community-contributed |
| `experimental` | `boolean` | Marks feature as experimental |
| `integrationType` | enum | `model-provider`, `tool`, `session-manager`, `memory-store`, `storage`, `integration`, `plugin`, `observability`, `agent-extension`, `intervention` |
| `category` | `string` | For TypeScript API doc grouping |
| `redirectFrom` | `string[]` | Old slugs that should redirect here |
| `tags` | `Tag[]` | From `site/src/config/tags.yml`; drives the build-time "Related pages" block |
| `sourceLinks` | `{repo, path}[]` | Pointers to SDK implementation; rendered on headless surfaces (index.md, llms-full.txt) |

These render contextual banners automatically (experimental → community → languages). Anything not in this table is silently stripped by Zod at build time, so don't invent fields like `contentType` or `lastReviewed` — add them to the schema first if they'd be useful.

Do not set `languages: [python, typescript]` — listing all supported languages is redundant. Omit the field when a feature is available in all languages.

## TypeScript Snippet Scoping

When a `.ts` file has multiple snippets using the same variable names, wrap each snippet body in a function. Place markers **inside** the function so only the snippet body — not the function declaration — appears in docs:

```typescript
// Correct: function is for scoping only
async function exampleScope() {
  // --8<-- [start:example]
  const result = await agent.invoke('Hello')
  console.log(result)
  // --8<-- [end:example]
}
```

TypeScript uses `isolatedModules: true` — multiple top-level snippets that redeclare the same identifiers will fail type-checking without scoping. Body files generally should *not* need `// @ts-nocheck`; if they do, the snippets aren't scoped correctly.

Markers must be on their own line as line comments — anything else on the line and the build won't detect them. A typo in the snippet name fails to render the block; verify each `--8<--` reference resolves to a real `[start:…]`/`[end:…]` pair.

## Relative Links

Use relative file paths. They resolve automatically via the PageLink component:

```markdown
[Custom tools](../tools/custom-tools.md)
[Tools overview](../tools/index.md)
```

## API Reference Shorthand

Link to generated API docs without fragile relative paths:

```markdown
[@api/python/strands.agent.agent](AgentResult)
[@api/typescript/Agent#constructor](Agent constructor)
```

## Line Length

90 characters maximum for files under `site/src/content/docs/`. Template literal contents in snippet files must also stay under 90 characters. Prettier does not enforce this automatically.

## Validating Changes

Run from `site/`:

- `npm run typecheck:snippets` type-checks snippet files under `src/content/docs/`
- `npm run typecheck` type-checks other TypeScript
- `npm run format` applies Prettier formatting to doc snippet files
- `npm test` runs the site's unit tests
- `npm run dev` previews at http://localhost:4321/ to confirm snippets render

## Gotchas

- **Snippet dedent**: Leading whitespace is automatically stripped from included snippets. If the snippet reference in markdown is indented, content indents to that level.
- **Tab indentation**: Content inside `<Tab>` must not have leading blank lines or it may not render correctly.
- **API docs are symlinked**: `site/src/content/docs/api/python/_generated` and `typescript/_generated` are symlinks to `site/.build/api-docs/`. Never edit these directly — they are auto-generated.
- **No `TabItem`**: The auto-imported component is `Tab`, not `TabItem` (even though Starlight's native component is called TabItem).
- **Code theme**: Uses GitHub Light/Dark themes. Follows Starlight's `[data-theme]` attribute.
- **Formatting**: No semicolons, single quotes, 2-space indent, trailing commas ES5 style (enforced by Prettier).
