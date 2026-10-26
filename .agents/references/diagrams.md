# Diagrams

How to design and author diagrams for the Strands docs. The rules are adapted from
[diagram-design](https://github.com/cathrynlavery/diagram-design) (MIT) and restyled in
the Strands brand. It's a working draft: when a rule produces a bad diagram, change the
rule here.

## Two formats

| Format | Use it for | How |
|---|---|---|
| **`<Diagram>` SVG** (preferred) | Concept pages and anything a reader will look at often: the agent loop, multi-agent patterns, lifecycles, architecture | Hand-authored SVG in `site/src/assets/diagrams/<name>.svg`, rendered by `site/src/components/Diagram.astro` |
| **Mermaid fence** | Quick or short-lived diagrams, and ones that change with every release | ` ```mermaid ` code block. The site renders it client-side with brand colors |

Never use ASCII art or box-drawing characters.

## Should this be a diagram at all?

Ask: *would a reader learn more from this than from a well-written paragraph?*

- A list of things → table or bullets.
- Attribute comparisons → table.
- One box and one arrow → write the sentence.
- More than 9 nodes → two diagrams, an overview and a detail view.

**Deletion is usually the best edit.** Every node is a distinct idea. Two nodes that
always appear together are one node. Every line carries information; if the layout
already shows the relationship, remove the line. The diagram is done when nothing more
can be removed. Target density is about 4 out of 10: technically complete, readable
without a legend.

Budget per diagram: ≤ 9 nodes, ≤ 12 arrows, ≤ 2 accent elements, ≤ 2 notes.

## Pick one type

Write the diagram's story in one sentence first, for example: *"The model and tools
alternate until the model stops asking for tools."* Then pick the type whose shape
matches that sentence.

| The story is about… | Type | Example |
|---|---|---|
| A cycle that repeats until a condition | **Loop** | `agent-loop.svg`, `goal-loop-validation.svg`, `graph-feedback-loop.svg` |
| One component calling several others | **Fan-out / architecture** | `agents-as-tools.svg`, `graph-parallel-aggregation.svg` |
| One component choosing among 2–3 outcomes | **Decision fan-out** | `steering-before-tool-call.svg` |
| Stages that run one after another | **Pipeline** | `graph-sequential-pipeline.svg`, `workflow-sequential.svg` |
| What runs where, across a boundary | **Architecture with boundary** | `sandbox-execution-boundary.svg`, `graph-remote-agents.svg` |
| Messages between actors over time, in phases | **Sequence** | `skills-progressive-disclosure.svg`, `swarm-handoffs.svg` |
| Which events fire, in what order, at each stage | **Lifecycle** | `hooks-events-single-agent-python.svg` |
| Branching decisions with several checks | **Flowchart** | `human-in-the-loop-approval-flow.svg` |
| How one approach differs from another | **Before/after pair** | `migrate-langgraph-shared-state.svg` + `migrate-langgraph-strands-state.svg` |
| States and the events that move between them | **State machine** | — |
| Stacked abstraction levels | **Layer stack** | — |

**Reuse before you draw.** If an existing diagram already tells the story (both
quickstarts use `agent-loop.svg`), point to it with a `<Diagram>` and write an `alt`
that fits the new page. Don't make a near-copy.

One primary layout direction per diagram: left to right *or* top to bottom.

## How the pipeline works

```mdx
import Diagram from '@components/Diagram.astro'

<Diagram
  name="agent-loop"
  alt="The agent loop. A request goes to the model. While the model asks for tools…"
/>
```

- `name`: file name in `site/src/assets/diagrams/` without `.svg`. Use kebab-case and
  name it for the concept, not the page.
- `alt` (required): a complete text version of the diagram, written as prose. It
  becomes the SVG's accessible name **and** replaces the diagram in the page's `.md`
  twin and `llms-full.txt`, so an agent reading the markdown must get the whole idea from
  it. Name every node and say what flows between them.
- `caption` (optional): a visible line under the diagram. Usually leave it out, since
  the surrounding prose should introduce the diagram.

The SVG is **inlined**, not loaded through `<img>`, so its classes pick up
`site/src/styles/diagrams.css`. All colors live there and resolve from Starlight's
theme tokens, which is how one file serves both light and dark mode. The component
prefixes every `id` with `dg-<name>-`, so marker IDs never collide between diagrams on
the same page.

**SVG files contain geometry and class names only.** No `fill="#…"`, no `style=`, no
`<style>`, no fonts, no background rect.

The one exception is a diagram that also has to render on its own, outside the site
(for example a blog figure people open or share directly). It may carry a `dg-bg` rect
and a `<style>` of fallback colors, with every selector wrapped in `:where(.<name> …)`
so it has zero specificity and `diagrams.css` always wins on the site.
`redteam-judge-vs-tool-check.svg` is the example.

## Classes

| Class | Use |
|---|---|
| `dg-node` | Default box: a step, component, or agent |
| `dg-node is-focal` | The one or two things the reader should look at first. Green tint and stroke |
| `dg-node is-input` | Users, requests, external systems. Quieter than the system itself |
| `dg-node is-hub` | Accumulated state at the center of a loop. Inverted fill; use `is-hub-text` on its labels |
| `dg-node is-optional` | Conditional or optional step (dashed) |
| `dg-node is-event` | Lifecycle event chip: one event name per chip in a centered `dg-code` (baseline `y + 18`), 28px tall, or 44px with a `dg-sub` qualifier inside (baseline `y + 34`). Same width for every chip in a diagram; stack them 12px apart inside a stage `dg-zone`. Tinted so it never reads as a zone |
| `dg-zone` | Grouping region: "these belong together", a scope, a phase band |
| `dg-zone is-boundary` | Trust, process, or sandbox boundary (dashed, no fill). A sandbox with nothing drawn inside it can carry a `dg-name` + `dg-sub` directly instead of an eyebrow |
| `is-danger-text` | Text modifier for an error: a breach or a violation. Red; works on any text class |
| `dg-bg` | Background rect, only for a diagram that must also render outside the site (see below) |
| `dg-edge` | Default connector |
| `dg-edge is-accent` | The headline path, at most one or two per diagram. Pair it with the accent marker |
| `dg-edge is-dashed` | Returns, async, optional, write-backs, queries to a decision service (a policy engine "ask"), and conditional edges (pair a conditional edge with an `IF …` label). It combines with `is-accent` for a headline conditional path |
| `dg-lifeline` | Sequence diagram lifeline |
| `dg-mask` / `dg-mask is-on-zone` | Opaque rect behind a label that sits over a line. Use `is-on-zone` inside a zone |
| `dg-name` | Node name: sans, 14px, 600, sentence case. Add `is-focal-text` on focal nodes |
| `dg-sub` | One-line description under a name: sans, 12px, muted |
| `dg-code` | Technical identifier under a name (function, class, event): mono, 11.5px |
| `dg-label` | Edge label: mono, 10px, UPPERCASE, ≤ 14 characters. Also used as a small tag above a node (`ENTRY POINT`, `LOCAL`) |
| `dg-msg` | Sequence message: sans, 12px, sentence-case phrase. `is-accent` for the headline call |
| `dg-eyebrow` | Zone or phase label: mono, 10px, UPPERCASE, tracked |
| `dg-note` | Editorial aside in italics. At most two |

If you need a role that isn't here, add a class to `diagrams.css` built from the
existing `--dg-*` tokens. Don't hard-code a color in the SVG.

## Color and emphasis

- **Red means an error.** Use `is-danger-text` only for a breach or a violation. It isn't a second accent; green still marks what to look at.
- **Accent is editorial, not decoration.** Use green on one or two elements only: the
  focal node or the headline path. If you want to accent four things, you haven't
  decided what matters.
- Shape and position carry the type, not color. Inputs are quieter (`is-input`), not a
  different hue.
- No shadows, glows, or gradients. Radius is 6 on nodes and 8 on zones, never more
  than 10.
- Vary box widths to show hierarchy. Identical boxes everywhere is an anti-pattern,
  except when the stages really are equal (a pipeline of peers): then equal boxes are
  the honest drawing.
- A diagram needs no accent if nothing in it is more important than the rest. Don't
  accent one of several identical events (one handoff out of four).

## Typography

- **Names are sans** (`dg-name`, `dg-sub`, `dg-msg`). **Mono only for technical
  content**: code identifiers (`dg-code`) and the small UPPERCASE labels (`dg-label`,
  `dg-eyebrow`).
- Write labels in uppercase in the SVG source itself; don't rely on `text-transform`.
- An identifier can't go in an uppercase slot (zone eyebrow, edge label), because
  re-casing it would change it. Use a plain phrase there (`ATTACK LOOP`, not
  `REDTEAMEXPERIMENT`) and put the identifier in a `dg-code` line or the `alt`.
- Keep code identifiers exactly as they appear in code, never re-cased. If Python and
  TypeScript names differ (`tool_use` vs `toolUse`), use a language-neutral phrase
  (`TOOL CALLS`) or put the identifier in the prose instead.
- Use canonical terms from `terminology.md`.
- Never shrink type to make things fit. Cut content, or split the diagram.

## Geometry

- **Canvas:** `viewBox="0 0 720 H"` with `width="720" height="H"`. 720 matches the
  docs content column, so the SVG renders at about 1:1 and the sizes above are real
  pixels. Leave a 16px margin and nothing outside the viewBox. On narrow screens the
  figure scales down to fit the column (readers can pinch-zoom; the SVG stays sharp), so
  a phone shows it at roughly half size. That's one more reason to keep diagrams within
  budget and never go below the class text sizes.
- **4px grid:** node x, y, width, height, gaps, and padding are multiples of 4.
- **Node sizes:** heights of 48 (name only), 56–64 (name + sub), or 80 (focal);
  widths of 104–264. Gaps between nodes of at least 24.
- **Text width estimate:** sans ≈ 0.6 × font-size per character, mono ≈ 0.62 ×. The
  tracked uppercase styles are wider: `dg-label` ≈ 0.68 × and `dg-eyebrow` ≈ 0.74 ×. Add
  8px padding per side and round the box up to a multiple of 4.
- **Text placement in a box at center `cy`:**
  - Name only, including a diamond's label: baseline `cy + 5`.
  - Name and sub: baselines `cy - 3` and `cy + 15`.
  - Name and two code lines, or name + sub + code: baselines `cy - 11`, `cy + 7` and
    `cy + 23`.
  - **Stage of events:** a `dg-zone` with a `dg-eyebrow` at `+16`/`+20`, holding one
    `dg-node is-event` chip per event (see the classes table), stacked 12px apart. A
    nested group (for example `EACH TOOL CALL`) is a `dg-zone` inside the stage with its
    own eyebrow. Never list identifiers as plain text lines inside a box: if readers
    must tell items apart from labels, give each item a chip.
- **Paint order (file order):** zones → zone labels → edges → label masks and labels →
  nodes → node text. Edges come before nodes so boxes cover the line ends cleanly.

## Connectors

1. **Orthogonal only.** Straight lines when both ends share an x or y, otherwise
   right-angle elbows with an `r=8` quarter curve. No diagonals and no free curves.
   Sequence self-messages are a U-shaped elbow. The only documented exception is the
   ring arc of a parametric loop with five or more stations.
2. **Leave and enter perpendicular** to the edge, at least 8px from a corner.
3. **Fan attach points:** N connectors on one edge of length L attach at `L·k/(N+1)`,
   at least 12px apart. Never share a point.
4. **No stacked strokes.** Keep parallel routes at least 12px apart. Never route
   through a box that isn't an endpoint.
5. **Labels sit above horizontal segments** and beside vertical ones, with a 6–10px gap
   from the line and centered on the segment. Never on the line, never vertical text.
6. **One arrowhead per path** (`marker-end`, never `marker-start`). Two directions means
   two paths, at least 24px apart.
7. Don't draw both directions when one is obvious. A call implies its return; draw the
   return only when it carries information, and dash it.

Marker (copy exactly; the component namespaces the id):

```svg
<defs>
  <marker id="arrow" viewBox="0 0 8 6" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
    <path class="dg-head" d="M0,0 L8,3 L0,6 Z"/>
  </marker>
  <!-- only if the diagram has an accent edge -->
  <marker id="arrow-accent" viewBox="0 0 8 6" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
    <path class="dg-head is-accent" d="M0,0 L8,3 L0,6 Z"/>
  </marker>
</defs>
```

End a path 2px short of the target's border so the arrowhead tip touches it.

Path patterns:

```svg
<!-- straight -->
<path class="dg-edge" d="M144,104 H214" marker-end="url(#arrow)"/>
<!-- two-bend elbow, right then down, mid = (x1 + x2) / 2 -->
<path class="dg-edge" d="M x1,y1 H mid-8 Q mid,y1 mid,y1+8 V y2-8 Q mid,y2 mid+8,y2 H x2" marker-end="url(#arrow)"/>
<!-- self-loop on a sequence lifeline at x (label to the right, at x+44) -->
<path class="dg-edge" d="M x,y H x+24 Q x+32,y x+32,y+8 V y+12 Q x+32,y+20 x+24,y+20 H x+2" marker-end="url(#arrow)"/>
<!-- loop back over a node row: drop from the source bottom, run under, rise into the target bottom -->
<path class="dg-edge is-dashed" d="M x1,y V y+32 Q x1,y+40 x1-8,y+40 H x2+8 Q x2,y+40 x2,y+32 V y+2" marker-end="url(#arrow)"/>
<!-- edge label above a horizontal line at y -->
<rect class="dg-mask" x="cx-w/2" y="y-20" width="w" height="12" rx="2"/>
<text class="dg-label" x="cx" y="y-11" text-anchor="middle">TOOL CALLS</text>
```

## Type notes

**Loop.** With two stations (model ⇄ tools), draw two parallel horizontal arrows
labeled with what flows each way, inside a zone that names the loop, and an exit
arrow labeled with the stop condition. With 5–8 stations, place them clockwise on a
circle around one hub that holds accumulated state.

**Fan-out / architecture.** The caller is focal. Put the callees in a zone that says
what they have in common. Fan the connectors from one edge of the caller. Name each
callee in sans and show its identifier in `dg-code`.

**Sequence.**
- Actors go in a top row, with no duplicate row at the bottom. Dashed lifelines run to
  the end.
- Messages are horizontal; time flows down. Keep at least 32px between messages.
- Calls are solid, returns dashed. Accent goes on the one message that is the point of
  the diagram.
- Group messages into numbered phase bands (`dg-zone` plus `dg-eyebrow`, e.g.
  `1 · DISCOVERY`) that match the headings or list in the prose. Mask phase labels
  where they cross a lifeline.
- Keep message labels inside a band, at least 8px from its border. If a label would sit
  on a border, move the message or drop the bands.
- Caps: 5 actors, 12 messages.

**Decision fan-out.** One handler, 2–3 outcomes, left to right. The handler is focal,
and it fans out with r=8 elbows to one box per outcome, each exit labeled with the action
(`PROCEED`, `GUIDE`). Accent the outcome the page is about. Use this instead of a
flowchart when there's a single decision.

**Lifecycle.** Every event is its own `is-event` chip, and nothing else is a chip. Stages
are zones named with an eyebrow, holding their chips in firing order (no arrows between
consecutive chips; the stacking shows the sequence). Edges carry only conditions: an
event that fires on a path is a chip placed on that path, never an edge label. Put a
qualifier that tells two identical events apart inside the chip as a `dg-sub`, never as
loose text beside it. A loop zone wraps the repeating stages. Diagrams inside language
tabs may use language-specific identifiers. Verify every event name and its order
against the source.

**Trace waterfall.** Time runs left to right with a `TIME` axis arrow at the bottom. The
parent span is one full-width bar on top; child spans sit in a zone below, one row each,
offset by when they start. Bars are `dg-node` rects 36px tall (an exception to the 48px
minimum) with a left-aligned `dg-code` label at `x + 16`, baseline `y + 23`.

**Before/after pair.** Two diagrams on the same canvas size with the same node positions.
Change only what differs, so the reader's eye finds the difference. Mark something that
doesn't exist on one side with a `dg-note` where it used to be ("No shared state
object"), not an empty box.

**Flowchart.**
- Top to bottom. Start and end are pills (`rx` = half the height, with `is-input`),
  steps are rectangles, decisions are diamonds with at most three exits.
- Label every exit (`YES` / `NO`). Accent goes on the happy path or the most
  consequential decision.

## Template

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 200" width="720" height="200">
  <!-- Type: … Story: … -->
  <defs>
    <marker id="arrow" viewBox="0 0 8 6" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto" markerUnits="userSpaceOnUse">
      <path class="dg-head" d="M0,0 L8,3 L0,6 Z"/>
    </marker>
  </defs>

  <!-- Zones -->
  <!-- Edges -->
  <path class="dg-edge" d="M160,100 H254" marker-end="url(#arrow)"/>
  <!-- Edge labels -->
  <!-- Nodes -->
  <rect class="dg-node is-input" x="16" y="68" width="144" height="64" rx="6"/>
  <text class="dg-name" x="88" y="97" text-anchor="middle">Request</text>
  <text class="dg-sub" x="88" y="115" text-anchor="middle">prompt + history</text>

  <rect class="dg-node is-focal" x="256" y="60" width="176" height="80" rx="6"/>
  <text class="dg-name is-focal-text" x="344" y="97" text-anchor="middle">Agent</text>
  <text class="dg-code" x="344" y="115" text-anchor="middle">agent.invoke()</text>
</svg>
```

## Review checklist

Run through this before you ship a diagram, and when you review one.

**Content**
- [ ] A paragraph or table wouldn't do the job better.
- [ ] One type, one direction, with a one-sentence story you can state.
- [ ] Removing any node, arrow, or label would lose information.
- [ ] It matches the prose: same terms, same phases, same order.
- [ ] Labels are language-neutral (or the page is single-language).
- [ ] `alt` describes the full idea in prose.

**Style**
- [ ] Accent on at most two elements.
- [ ] No hard-coded colors, styles, or fonts in the SVG.
- [ ] Names in sans; mono only for identifiers and UPPERCASE labels.
- [ ] No text smaller than the class sizes above.

**Geometry**
- [ ] On the 4px grid, inside the viewBox, 720 wide.
- [ ] Orthogonal connectors with `r=8` elbows; no diagonals.
- [ ] No crossings or stacked strokes.
- [ ] Every label is clear of lines, with a mask where it crosses one.

**Render check**
- [ ] Rendered in **both** light and dark mode and checked on screen (see the
      `docs-diagrams` skill for the screenshot script).
- [ ] The page's `.md` twin shows `> **Diagram:** …` where the figure was.
