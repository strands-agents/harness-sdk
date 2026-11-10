# Strandslator Spec

**Status**: Proposed

**Date**: 2026-06-17

**Issue**: https://github.com/strands-agents/harness-sdk/issues/2666

## Overview

This document is a pairing to [0012-strandslator](./0012-strandslator-design.md), which focused on the experimentation behind translation and the context the workflow consumes. Here we specify the system's behaviors and interfaces: what a run takes as input, what it produces, the pipeline that drives the agents, how it runs locally through a CLI, and how that same command runs as a GitHub Action. It is a spec, not an implementation guide. It pins down the externally observable contracts and leaves the internal mechanics to the build.

The guiding principle is that there is one way to run the workflow, and everything else is a wrapper around it. The local CLI is the workflow. The GitHub Action is the local CLI running on a hosted runner.

## Agents

We lean on existing prior art for defining the autonomous agents themselves:

- **[`strands-command`](https://github.com/strands-agents/devtools/tree/main/strands-command).** Already runs Strands agents in GitHub Actions with job separation, permission isolation, artifact-based state handoff, and authorization gating. The closest fit since it solves the same CI problems, though it is comment-driven (`/strands` on issues and PRs) rather than `workflow_dispatch`-driven.
- **[`agent-of-mkmeral`](https://github.com/agent-of-mkmeral).** An opinionated autonomous agent operating via a dedicated GitHub account with fork-based PRs and validation loops.
- **[`gautamsirdeshmukh`](https://github.com/gautamsirdeshmukh).** Working on a template for generating more fully featured and opinionated autonomous agents.

We borrow proven patterns from all three where they fit. Opinionated agent templates matter here: agents pre-configured with sensible defaults (caching, model selection, tool access, prompt structure) are a time and cost saver. When I was prototyping Strandslator, I forgot to enable caching on the Strands agent, which meant unnecessary cost and latency on every run.

## Contract

A run is defined by what it takes in and what it puts out.

**Input.** A source feature and a target language. Both resolve to locations in the monorepo, and the source carries its paired tests, docstrings, and metadata, plus the "strands-md" guides, exactly as specified in [0012](./0012-strandslator-design.md). There are no GitHub issues or other out-of-band inputs.

A run also depends on a precondition: the source feature must be **marked ready for translation** per the "Explicit readiness" principle in [0012](./0012-strandslator-design.md). This spec only requires that the signal exists and that a run refuses to start against a source that is not marked ready.

**Output.** A successful run produces a single target-language PR containing:

- The translated code, tests, and docs.
- The review report and its artifacts described in [0012](./0012-strandslator-design.md): behavior traceability matrix, captured test output, differential results, structural map, decision log, dependency and capability delta, sensitive-surface diff, lint/type-check results, and open questions.

The report is the primary interface for the human on the other end. The run's job is not "produce a diff" but "produce a diff a reviewer can approve quickly." Artifacts must be mechanically derived, not narrated.

## Pipeline

The pipeline runs the Plan, Implement, Validate, Document, and Report agents in sequence, handles kickbacks from Validate back to Plan, and surfaces what is happening to a watching human. Per-agent contracts are specified in [0012](./0012-strandslator-design.md).

- **Kickbacks.** When Validate finds a behavior gap or failing test, it sends the run back to Plan with the findings attached. We bound iterations so a run can't loop forever, and surface a clear failure when the bound is hit.
- **Status updates.** Each step emits structured progress (agent, kickback count, pass/fail) so a human can follow along without reading raw transcripts.
- **Human intervention.** A human can pause a run, inspect or amend the in-progress artifacts and context, and resume.
- **Pause and resume across shutdown.** We checkpoint pipeline state after each completed step so a run can be stopped and picked back up from the last checkpoint, whether that's locally or by re-dispatching in CI.
- **Feature locking.** A run claims its target feature so no other run can work on it concurrently. This prevents two agents from producing conflicting translations of the same feature into the same language. The lock is released when the run completes or is explicitly abandoned.

The pipeline reads input from fixed monorepo paths. Agents may gather additional context on their own (e.g. from the web) during a run.

## CLI

A single CLI command is the primary interface. It runs against the local monorepo checkout and supports starting a fresh run, watching status, pausing, and resuming from a checkpoint.

```
strandslate run --source <feature> --target <language>
strandslate resume <run-id>
strandslate status <run-id>
```

The command could generalize beyond translation. We have other agentic workflows planned (feature development, reviewing, testing) that follow similar orchestration contracts: sequenced agents, checkpointing, kickbacks, status updates. If they share that structure, we could unify them under a single CLI (e.g. `strandly`) with translation as one workflow among many.

## Action

The Action exists because this is where our code lives. It is deliberately thin: the local CLI command running on a hosted runner.

- **Wraps the local command.** The job step is the same `strandslate run` invocation a developer would type.
- **Manual trigger.** `workflow_dispatch`, matching the principle from [0012](./0012-strandslator-design.md) that a human decides when a feature is ready.
- **Source and target inputs.** Exposed as dispatch inputs, passed straight through to the command.
- **Authorization gating.** Following `strands-command`, the workflow gates dispatch against an allowlist of repo roles (`maintain`, `write`, `admin`), with a manual approval gate for anyone else.
- **Permission separation.** The agent runs in a read-only job. Repository changes and deferred GitHub operations are emitted as artifacts, and a separate Finalize job (with write permission, `if: always()`) pushes the branch and opens the PR. This keeps commit and push off the agent's plate and limits blast radius.
- **Resume on failure.** A failed run can be resumed by re-dispatching in CI or by downloading the checkpoint locally and running `strandslate resume`.

The checkpoint needs to be persisted somewhere accessible for resume. In GitHub Actions, `actions/upload-artifact` is one option (with `if: always()` so failed runs still publish). A shared location like S3 is another, and would make checkpoints accessible regardless of where the run executed. The exact storage is runtime-dependent; what matters is that the checkpoint is retrievable after the run ends.

## Context

The pipeline is only as good as the context it reads. Before the workflow can produce reviewable PRs, we need to get the "strands-md" layer and per-feature metadata into shape.

- **Split up AGENTS.md.** The current files mix concerns. Split into focused guides by role (testing, building, security, documentation) at the fixed paths [0012](./0012-strandslator-design.md) assumes, with shared guidance at the repo root and language-specific variants in each package.
- **Update guidelines with current learnings.** Fold what we've learned from experiments and ongoing port work back into the guides so the agents inherit it.
- **Add code metadata files.** Backfill the per-feature metadata described in [0012](./0012-strandslator-design.md), prioritizing features we intend to translate first.

## References

- **[0012 Strandslator Design](./0012-strandslator-design.md).** The companion design covering the translation workflow, input context, agents, and review artifacts.
- **[Adversarial and cross-language differential testing](https://gist.github.com/agent-of-mkmeral/5a4d0ce16a1242a711d77d7e01c19902#6-adversarial--cross-language-differential-testing).** Design notes referenced in [0012](./0012-strandslator-design.md) for the differential testing approach.
- **[strands-command](https://github.com/strands-agents/devtools/tree/main/strands-command).** Prior art for job separation, artifact-based state handoff, and authorization gating.
- **[agent-of-mkmeral](https://github.com/agent-of-mkmeral).** Prior art for opinionated autonomous agents on GitHub.
- **[gautamsirdeshmukh](https://github.com/gautamsirdeshmukh).** Agent template work for fully featured autonomous workflows.
