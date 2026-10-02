# Team Documentation

This folder contains internal documentation about how the Strands team builds and maintains the SDK. These documents help contributors understand our design philosophy and decision-making process.

## Contents

| Document | Description |
|----------|-------------|
| [TENETS.md](./TENETS.md) | Core principles that guide SDK design and implementation |
| [DECISIONS.md](./DECISIONS.md) | Record of design and API decisions with rationale |
| [API_BAR_RAISING.md](./API_BAR_RAISING.md) | Process for reviewing and approving API changes |
| [FEATURE_LIFECYCLE.md](./FEATURE_LIFECYCLE.md) | How features are added, marked experimental, and deprecated under semantic versioning |
| [PR.md](./PR.md) | Pull request description guidelines (applies to both SDKs) |
| [COMPATIBILITY.md](./COMPATIBILITY.md) | What changes are not considered breaking under semantic versioning (both SDKs; Strands harness and the CLI are 0.x — see [Strands harness versioning](../site/src/content/docs/user-guide/harness/versioning.mdx)) |
| [COMPLEXITY.md](./COMPLEXITY.md) | Why PRs are labeled by cognitive complexity and how to keep code under the thresholds |
| [AGENT_GUIDELINES.md](./AGENT_GUIDELINES.md) | Guidelines for AI agents that interact with Strands repositories |
| [designs/](./designs/) | Design proposals for significant features (RFC-style) |

## For Contributors

When proposing changes to the SDK, please review these documents to understand:

- **Tenets** — The principles your contribution should align with
- **Decisions** — Past decisions that may inform your approach
- **API Bar Raising** — The review process for API changes
- **Agent Guidelines** — Conventions for agents operating on our repos

If your contribution results in a new decision that could guide future work, consider adding it to [DECISIONS.md](./DECISIONS.md).
