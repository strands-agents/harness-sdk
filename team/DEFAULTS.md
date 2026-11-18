# Changing a Default

A default is the most expensive API decision we make. Every user gets it, most never read the
config reference, and the ones who notice usually notice as a cost line or a regression. This
document is the gate a default change passes through: how to classify it, what evidence it needs,
and how it ships in the SDK versus the harness.

It applies to the SDK packages (`strands-py`, `strands-ts`) and to Strands harness
(`harness-py`, `harness-ts`) and the CLI. It sits between
[FEATURE_LIFECYCLE.md](./FEATURE_LIFECYCLE.md) (how features arrive and leave) and
[COMPATIBILITY.md](./COMPATIBILITY.md) (what counts as breaking). Neither of those answers
"should this be on for everyone, and how would we know."

## Tenet pressure

Two tenets pull against each other here, and naming the tension is most of the work:

- **The obvious path is the happy path** argues for turning good things on. A capability nobody
  discovers delivers nothing.
- **Simple at any scale** and **Pay for Play** argue for leaving them off. Every default is a tax on
  users who didn't ask for it — tokens, latency, surface area, surprise.

The resolution: **a default is earned by evidence, not by enthusiasm.** Shipping a capability
off-by-default is cheap and reversible. Shipping it on-by-default is a claim that it helps the
median user, and that claim needs to be measured.

## The promotion ladder

Nothing lands directly on rung 3 or 4. Each rung is a separate decision with a separate bar.

| Rung | State | What it costs the user | Bar |
|---|---|---|---|
| 1 | **Available** — selectable by name, documented, and recommended for the cases it helps | nothing | code and docs review, plus a stated "when" if you recommend it |
| 2 | **In a mode** — part of what a named mode like `"auto"` configures, so anyone who wrote that one keyword gets it | everyone who wrote the keyword pays | this document, at the tier its blast radius sets |
| 3 | **Default** — on for everyone, including users who configured nothing | everyone pays | this document, at the tier its blast radius sets |
| 4 | **Adaptive** — off until the SDK judges the situation calls for it, then on without the user naming it or a mode | only the situations it fires in pay | this document, plus evidence on **both** sides of the trigger and a visible signal |

### An SDK mode is not automatically a harness default

The SDK offers the mode; the harness decides. What picks the harness rung is what the benefit
depends on:

- Nothing situational → **Default** (rung 3).
- A condition the harness can observe → **Adaptive** (rung 4).
- Something only the user knows, such as risk tolerance → **stays a mode** (rung 2), and the
  harness's job is making the keyword discoverable.

A per-turn cost with a situational benefit is the todos trap: Adaptive (rung 4) at best, never
Default (rung 3).

## The decision tree

```mermaid
flowchart TD
    A{"What are you changing?"}
    A -->|"rung 1"| A1["A capability that ships off by default,<br/>e.g. the todos plugin"]
    A1 --> A1b["No evidence needed.<br/>SDK minor, harness patch"]
    A -->|"rung 2"| A2["What a mode expands to, e.g. which strategies<br/>context_manager='auto' configures"]
    A -->|"rung 3 or 4"| A3["The value a user gets when they pass nothing,<br/>e.g. DEFAULT_MODEL, DEFAULT_BUILTIN_PLUGINS"]
    A -->|"not on the ladder"| A4["Prompt text, undocumented tuning, or an 'auto' the model<br/>answers, e.g. ModelCapabilities.prompt_caching.<br/>Ships in any release"]

    A2 --> B
    A3 --> B
    B{"Can a user reach both the old and the<br/>new behavior by configuration?"}
    B -->|no| B1["Stop. Build the knob first,<br/>in its own PR"]

    B -->|yes| C{"Does it change what enters the context window,<br/>the tool loop, or the model call, on a normal turn?"}
    C -->|no| C1["Tests both ways,<br/>and run it end to end"]
    C -->|yes| C2["Matched Harbor runs: same tasks and revision,<br/>2+ model families, accuracy and tokens,<br/>per-benchmark, with spread"]
    C2 --> C3{"Affects every turn<br/>for every user?"}
    C3 -->|yes| C4["Add the full suite, a long-horizon agentic<br/>benchmark, cost per trial, and a named owner"]
    C1 --> D
    C3 -->|no| D
    C4 --> D

    D{"Does the evidence clear the bar?"}
    D -->|no| E{"Does it clear the bar for a condition the SDK<br/>can detect, on both sides of that condition?"}
    E -->|yes| E1["Rung 4, Adaptive — or rung 2, In a mode, with<br/>the expansion conditional on where it wins"]
    E -->|no| E2["Rung 1, Available, recommended where<br/>it helps. Say so in the PR"]

    D -->|yes| F{"Which package, and is the<br/>default documented?"}
    F -->|"SDK, documented"| F1["major, or the<br/>preset-expansion rule"]
    F -->|"SDK, undocumented tuning"| F2["minor"]
    F -->|"harness / CLI, documented"| F3["minor<br/>0.x minor is the breaking channel"]
    F -->|"harness / CLI, undocumented"| F4["patch"]
```

## The bar

A default must **win on at least one axis and lose on neither**:

| Accuracy | Tokens / cost | Where it holds | Verdict |
|---|---|---|---|
| up | down or flat | every family and benchmark | **Default** (rung 3) |
| flat | down | every family and benchmark | **Default** (rung 3) — efficiency alone is a win |
| up | up | every family and benchmark | **In a mode** (rung 2) — paying more for accuracy is the user's call, and a keyword like `effort` is where that choice belongs |
| up | up | some families or benchmarks | **Adaptive** (rung 4) if the SDK can detect the condition, otherwise **In a mode** (rung 2). As a default it taxes every user for a benefit some of them get |
| flat | up | anywhere | ship it **Available** (rung 1), recommended for the specific cases where it earns its tokens |
| down | anything | anywhere | ship it **Available** (rung 1), recommended only for the cases it helps. **Adaptive** (rung 4) if the SDK can detect that condition |

## How it ships

| Package | What changed | Release |
|---|---|---|
| SDK | the value of a documented default, or a default becoming conditional (**Default** / **Adaptive**, rungs 3 and 4) | **major** — [Pay for Play does not cover default behavior](./FEATURE_LIFECYCLE.md#pay-for-play-opt-in-breaking-changes) |
| SDK | what a preset or `"auto"` expands to (**In a mode**, rung 2) | **minor**, named in the release notes |
| SDK | a new capability, off by default, experimental or not (**Available**, rung 1) | minor |
| harness / CLI | the value of a documented default, or a default becoming conditional (**Default** / **Adaptive**, rungs 3 and 4) | **minor** — 0.x minor *is* the breaking channel ([versioning](../site/src/content/docs/user-guide/harness/versioning.mdx)) |
| harness / CLI | a new tool or plugin, off by default (**Available**, rung 1) | patch |

Recommending something in the docs ships no code. Undocumented tuning is not on the ladder at all —
it changes nothing a user configured — and ships in any release.

## Action items

Gaps this document exposes. Each needs an owner and an issue.

- **The SDK needs a defaults home.** Harness defaults live in one file; the SDK's `DEFAULT_*`
  constants are scattered per module and many values exist only in a signature, so a default change
  has no single place to review. Until then, name the constant beside the type it configures.
- **Adaptive (rung 4) is unbuilt.** Neither SDK can turn a capability on by observing the run, so a
  situational win has to settle for rung 1 or get forced to rung 3, where it loses.
- **The evidence has no home.** A PR description is the only record of a benchmark run, and nothing
  indexes it. Defaults outlive their measurements.
- **No current default has cleared this bar.** Every `DEFAULT_*` value predates the document.
  `todos` is the one that was measured, and it failed.

## Worked example: `todos`

The todos plugin shipped in `DEFAULT_BUILTIN_PLUGINS` in both harnesses, rendering the task list
into **every turn**. Measured on Harbor it showed no accuracy benefit on either the Claude or GPT
families and cost tokens — *accuracy flat, tokens up*, the row that is never a Default. It left the
defaults in #5974 and now lives in the SDK as a vended plugin (#6084), at rung 1 — **Available**.
