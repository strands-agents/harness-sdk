---
name: docs-diagrams
description: Design and draw diagrams for the Strands docs site as theme-aware SVGs rendered by the <Diagram> component. Use when a docs page needs a diagram, or when reviewing a diagram's clarity and style. Also triggers on "draw a diagram", "add a diagram", "make this diagram clearer", "diagram for X".
---

# Docs Diagrams

Create clear, editorial diagrams for the docs in the Strands brand. The rules are in
`../../references/diagrams.md`. Read it fully before drawing.

## Inputs

- **Page**: the `.mdx` file the diagram belongs to (required)
- **Source**: the concept to illustrate

## Workflow

### 1. Read the page

Read the prose around where the diagram goes. The diagram must match the text: the same
terms, phase names, and order. Check terms against `../../references/terminology.md`.

### 2. Decide, then state the plan

Before you write any SVG, tell the user:

- **The story:** one sentence saying what the reader should take away.
- **The type:** loop, fan-out, sequence, flowchart, state machine, and so on. Say why it
  fits the story.
- **Cuts:** what you're removing from the source and why. Deletion is usually the best edit.
- **Focal:** which one or two elements get the accent.

If a table or paragraph would do the job better, say so and don't draw.

### 3. Draw

1. Create `site/src/assets/diagrams/<concept-name>.svg`. Start from the template in the
   reference.
2. Lay it out on paper first. Compute box widths from the text-width estimate and keep
   every coordinate on the 4px grid.
3. Write the file in paint order: zones → edges → labels → nodes. Use classes only, with
   no colors or styles in the SVG.
4. Add the component to the page:

   ```mdx
   import Diagram from '@components/Diagram.astro'

   <Diagram name="concept-name" alt="Full prose description of the diagram." />
   ```

   Put the import after the frontmatter, with the page's other imports.

### 4. Look at it

You haven't finished until you've looked at the rendered diagram in both themes.

```bash
npm install && (cd site && npm ci)                    # once, from the repo root
(cd site && npm run dev > /tmp/site-dev.log 2>&1 &)   # once; leave it running (~35s cold start)
node .agents/skills/docs-diagrams/screenshot.mjs /docs/<page-path>/   # from the repo root
```

The script waits up to 90s for the dev server. It captures diagrams in inactive language
tabs too, and waits for Mermaid to finish rendering. If Chromium isn't installed, run
`npx playwright install chromium`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a specific
browser binary.

Open every PNG it prints. **Check that the labels are actually there.** With missing
fonts, boxes render empty but the diagram still looks structurally correct. Fix overlaps,
clipped text, labels touching lines, crossings, and anything that reads worse in dark
mode. Iterate until the review checklist in the reference passes.

Also check the markdown twin, which should show `> **Diagram:** <alt>` where the figure was:

```bash
curl -s http://localhost:4321/docs/<page-path>/index.md | grep -A1 'Diagram:'
```

### 5. Report

Tell the user:

- which diagram you added or replaced, and its type;
- what you cut from the source and why;
- the screenshot paths, so they can see it;
- any rule in `diagrams.md` that didn't work for this case. Propose an edit to the
  reference rather than silently breaking the rule.

## Don'ts

- Don't run several edits on the same file in parallel. They race, and one silently
  overwrites the other. Edit a file sequentially, then re-read it.
- Don't hard-code hex colors, fonts, or `style=` attributes. Add a class to
  `site/src/styles/diagrams.css` if a role is missing.
- Don't add nodes or components the page doesn't describe.
- Don't shrink text to fit. Cut content, or split the diagram into two.
