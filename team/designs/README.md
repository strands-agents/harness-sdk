# Design Documents

This folder contains design documents for significant features and changes to Strands Agents. These documents capture the problem, the proposal and the alternatives weighed against it, and the consequences of architectural choices.

For lightweight architecture decision records, see [DECISIONS.md](../DECISIONS.md).

## What is a design document?

A design document proposes a significant change or new feature. It describes the problem, proposed solution, and tradeoffs. Once approved and merged, it becomes an accepted design and part of the project's decision history.

## When to write a design document

Write a design document for:

- New major features affecting multiple parts of the SDK
- Breaking changes to existing APIs
- Architectural changes requiring design discussion
- Large contributions (> 1 week of work)
- Features that introduce new concepts

Skip the design process for bug fixes, small improvements, documentation updates, and new extensions in your own repository.

## How to submit a feature proposal/design

Add a new file to `designs/NNNN-feature-name.md` using the template below, and create a pull request with the proposed design. Keep it concise and focused, and follow our `team/AI_USAGE_POLICY.md` if you are authoring this with the help of an agent. Our team will review and provide feedback on the pull request. If the design is approved, you can work with our team to create issues to track the implementation of the design.

## Design document template

```markdown
# [Feature Name]

**Date**: YYYY-MM-DD

## Overview

> (Optional) Give a brief introduction to the proposed feature being introduced. (150 words)

## Problem

> In a few sentences, what is the issue motivating this change? Extended background belongs in Additional Details. (200 words) 
>
> - What task are you trying to accomplish?
> - What makes it difficult or impossible today?
> - Who experiences this problem?

### Current State

> Now show *how* it's hard. Ground the reader in the existing system — how it works today and exactly where it falls short — before proposing to change it. (200 words)
> 
> - How is this handled now — the current API, flow, or workaround?
> - What concretely breaks, and where? Use examples, error messages, or numbers where you can.
> - What are the paper cuts — the small, recurring frictions that add up — not just the outright failures?
> - How often does this come up, and how costly is it when it does?

## Proposal

> What are we proposing, and what else did we weigh? List the options on equal footing with their pros and cons, recommended one first, so the reader can see the choice was made by weighing tradeoffs rather than asserted.

### Recommended: [name]

> Describe the recommended option: what changes, how it integrates, and its tradeoffs. (300 words)

**Pros:**

**Cons:**

### Alternative: [name]

> Describe each alternative on equal footing with the recommended option. (300 words)

- **Pros:**

- **Cons:**

*If there's no genuine alternative — the design space is narrow or one approach clearly dominates — say so in a sentence rather than inventing a strawman. Still spell out the recommended option's own tradeoffs.*

## Developer Experience

> Show what the developer experience looks like for the recommended option. (200 words)

> - Code examples showing typical usage
> - Configuration or setup required
> - Error messages and edge cases

## Additional Details

> (Optional) Use for extended context that doesn't fit above: deep-dive investigations, longer prior-art surveys, or supplementary diagrams. Wrap it in a `<details>` block so the design stays scannable by default.

<details>
<summary>Extended context (optional)</summary>

<!-- Extended content here -->

</details>
```

## Writing the document

Please use the above template as a guide for writing your proposal. 

