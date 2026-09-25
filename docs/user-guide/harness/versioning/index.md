## Overview

Strands harness is a **0.x product**, versioned separately from the [Strands Harness SDK](/docs/user-guide/sdk/versioning-and-support/index.md). It ships opinionated defaults (tools, prompt, context management, sessions, memory) that will change shape as we learn what works. Keeping it at 0.x lets those defaults evolve without forcing major releases on SDK users who never touch the harness.

This page covers `strands-harness` (Python) and `@strands-agents/harness` (TypeScript). The [Strands CLI](https://github.com/strands-agents/harness-sdk/tree/main/strands-cli#versioning) follows the same rule.

## Version numbers

Versions are `0.MINOR.PATCH`.

-   **Patch (0.x.Y)**: bug fixes *and* new features, including new built-in tools and plugins.
-   **Minor (0.X.0)**: breaking changes. Every minor release lists what broke and how to move.
-   **No major releases pre-1.0.** Reaching 1.0 is a separate decision made on customer signal, not on a date. At 1.0, Strands harness adopts the [SDK versioning policy](/docs/user-guide/sdk/versioning-and-support/index.md).

The Python and TypeScript packages are versioned and released independently. Matching version numbers do not mean matching features.

## What counts as breaking

A change is breaking if code or configuration that follows the documentation stops working, or starts doing something different, without you changing it:

-   Removing or renaming a public factory option, config key, or exported symbol
-   Removing or renaming a built-in tool or plugin
-   Changing the value of a documented default (for example the default model, or a default tool’s permissions) so an existing agent behaves differently, or so a default tool can reach something it could not before

These are **not** breaking and may change in any release:

-   Fixing behavior to match what the documentation says, even though output changes
-   System prompt text, tool descriptions, and tuning that is not a documented default
-   Adding new built-in tools or plugins. Opting out is a configuration change, not a version change.
-   Anything under `@strands-agents/harness/internal`. It exists for the Strands CLI and is not a versioned surface.
-   Changes covered by the SDK’s [pay-for-play exception](/docs/user-guide/sdk/versioning-and-support/index.md#opt-in-breaking-changes)

## Relationship to the Strands Harness SDK

Each Strands harness release pins a version range of the Strands Harness SDK. Raising the minimum SDK version within the same SDK major ships as a patch; if that conflicts with your own SDK pin, pip or npm reports it at install time. If an SDK major release forces a harness change, that change ships as a harness minor.

## Deprecation

Where practical, a feature is deprecated in one minor release and removed in the next, with a warning that names the replacement. Pre-1.0 there is no fixed support window for deprecated features.

## Staying informed

-   **Release notes**: [GitHub Releases](https://github.com/strands-agents/harness-sdk/releases), tagged `harness-python/v*` and `harness-typescript/v*`
-   **Pin to a minor** to avoid breaking changes: `strands-harness~=0.1.0` (pip) or `@strands-agents/harness@~0.1.0` (npm). Patch releases still add features and built-in tools.