# Agent Guidelines

Guidelines for AI agents that interact with Strands repositories — PR reviews, issue triage, documentation, and autonomous improvements.

Derived from the discussion in [strands-agents/docs#523](https://github.com/strands-agents/docs/pull/523).

## Add Value or Stay Silent

If an agent doesn't have something concrete to contribute, it should not act. Silence is better than noise.

An agent should have a reason to act before acting: a reproducible test case, an actionable review suggestion, a clarifying question that moves the discussion forward, or a well-defined issue ready for implementation. When in doubt, flag for human review rather than acting independently.

## Keep It Short

Agent output should be concise. Lead with what matters, then stop. If there's additional context that might be useful, use progressive disclosure — a short summary up front with detailed analysis in a collapsible `<details>` block.

Agents should read like a helpful teammate, not a lecture. Avoid excessive positive feedback, avoid restating the obvious, and avoid walls of text. Focus on what needs to change or what's worth calling out.

## Approvals Need Reasoning

When an agent doesn't approve something, it must clearly justify why — this is where the real value lies. For approvals, the bar depends on trust: early on, include brief reasoning so reviewers can calibrate the agent's judgment. As confidence grows, lighter approvals are fine, provided the agent is never the sole approver.

## Scope Credentials to the Task

Give agents the minimum permissions they need, nothing more. For task-specific agents (review, triage, docs), use tokens scoped to exactly those capabilities. For general-purpose agents where scoping is harder, use an external bot account (e.g. `strands-agent`) with community-level permissions rather than personal or maintainer accounts.

**Never give agents maintainer tokens.** Maintainer tokens allow destructive actions (force-push, delete branches, modify settings) that may be irreversible.

Security isn't just about tokens. Before deploying an agent, think through what failure looks like — spamming issues, pushing to wrong branches, runaway loops — and put explicit guardrails in place, even if the mitigation is just a system prompt. Document the tradeoffs.

## Throttle Autonomous Activity

Agents that act without explicit human triggering (scheduled, event-driven, continuous) should work at a pace humans can follow and respond to. If maintainers can't keep up with an agent's output, the agent is moving too fast.

Prefer business-hours operation so maintainers can partner with agents in real time. Limit the number of active open items (PRs, issues) an agent maintains simultaneously. Specific rate limits will evolve as we learn — we haven't yet determined a robust framework for autonomous agents, and we should be vocal, kind, and patient with experimentation.

## Own What You Deploy

Every autonomous agent needs a named owner — a person, not a team. The owner is responsible for:

- Access to logs and controls for the agent
- A documented procedure to disable it quickly
- Cleaning up mistakes — deleting bad comments, closing bad PRs, reverting changes
- Iterating on the agent until it's genuinely useful; launching isn't enough

If the owner leaves or becomes unavailable, ownership must transfer. An agent without an owner gets disabled.

## Monitor What Agents Do

Treat agents like any other contributor — their actions should be visible through existing tools (PR history, comment logs, audit trails). We don't build agent-specific monitoring systems when existing features suffice, but visibility into what an agent did, when, and on which repos is non-negotiable.

## Maintainers Can Pull the Cord

Any repository maintainer can disable any agent operating on their repo, immediately and without approval. Disabling must be fast — minutes, not hours. No negotiation required. Repository health takes precedence over agent operation.

## Know That Your Agent Works

Before deploying an agent to interact with the community, validate that it actually does what you intend. This can be automated evals, manual testing, or whatever makes sense for the problem space — the method matters less than the outcome. The agent should demonstrably work and not produce garbage. If a human contribution at the same quality level would be rejected, the agent's should be too.

Get lightweight team buy-in before letting an autonomous agent loose on the repos. And keep evaluating — an agent that was good enough at launch may not stay good enough.

## Pre-Deployment Checklist

Before deploying an agent to Strands repositories:

- [ ] The agent adds concrete value — not just noise
- [ ] Output is concise and reads like a helpful teammate
- [ ] Credentials follow principle of least privilege; failure modes documented
- [ ] Named owner with access to logs, controls, and a documented disable procedure
- [ ] Activity is throttled to a pace humans can keep up with
- [ ] Actions are visible through existing tools
- [ ] The agent has been validated (automated or manual) and team has signed off
- [ ] Maintainers know how to shut it down immediately
