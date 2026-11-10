# Consolidate Strands SDK Repos into a Mono Repository

**Status**: Proposed

**Date**: 2026-05-05

## Overview

This document proposes consolidating the core Strands Agents repositories — both SDK implementations, docs, samples, and closely related tooling — into a single mono repository. The primary motivation is development velocity: a single team shipping features across Python and TypeScript, with heavy agentic development, benefits from co-location more than it suffers from the tradeoffs. This is an unusual choice in the SDK ecosystem, and the document surveys industry practice to explain why the standard arguments against it don't apply to our team structure.

## Context

Strands Agents is spread across 12 repos under [strands-agents](https://github.com/strands-agents). The SDK has a Python and TypeScript implementation, a docs site, shared tools, samples, and various supporting infra — all in separate repos. As development has ramped up, the friction of bouncing between these repos has become a real bottleneck.

During active development, we're constantly switching between repos. A single feature might touch both SDKs and the docs site, which means coordinated branches, separate PRs, and careful merge ordering. This slows everyone down, humans and agents alike.

- **Context switching**: devs and agents lose context every time they jump between repos. Setting up a new worktree means cloning N repositories and making sure they're all on the right branches — that's friction that scales with the number of repos involved.
- **Fragmented PRs**: one logical change becomes multiple PRs that have to be reviewed and merged in the right order.
- **Docs lag behind code**: docs live in a separate repo, so they end up being a follow-up step rather than part of the feature branch. We also can't always finish doc work until the code merges (or do complex branch pointing).
- **Duplicated CI/tooling**: shared workflows and configs get duplicated or need a separate `devtools` repo to coordinate.
- **Agent productivity**: agentic tools work best with the full project context in one checkout. Splitting the SDK across repos means the agent doesn't have the full picture out of the gate.

All of these problems are individually fixable. We can set up multi-repo clones, maintain cross-repo scripts, configure agents with multi-repo context. But each of those is overhead we have to build and maintain per-developer. The question is: why solve these problems individually when we can fix them as a group?

## Decision

We have a single team working across both languages, where every member is expected to implement features in all SDKs. Docs are tightly coupled to those implementations, and both humans and agents benefit from co-location.

Given all of that, we should consolidate the core SDK repos into a single mono repository.

### Which Repos Move

The candidates for consolidation are the repos tightly coupled to the SDK, the ones where we're doing a lot of overlapping work:
- `sdk-python`, `sdk-typescript`, `docs`: these are the core. Cross-repo work here is constant.
- `samples`, `mcp-server`, parts of `devtools`: probably move these too. They're closely tied to SDK development.

The repos that stay independent are the ones where there isn't a lot of overlap with day-to-day SDK work:
- `evals`, `agent-builder`, `agent-sop`, `tools`: these are more standalone projects.
- `.github`, `extension-template-python`: org-level config and templates.

## Consequences

### What becomes easier

- **Agentic development**: agents don't need multi-repo setups or special configuration to have full context. Porting code from Python to TypeScript (or vice versa) is much easier when the agent has both implementations open. Generating docs is more useful when the agent has the source code right there.
- **Unified PRs**: documentation lives in the feature branch alongside the code. Doc development can be done in tandem with implementation rather than being a separate step.
- **Centralized information**: one place for skills, agents, patterns, etc.

### What becomes harder

**Overlap and confusion** is the main concern. No major SDK project puts multiple language implementations in a single cross-language monorepo (see [Appendix A](#appendix-a-how-do-other-sdk-projects-handle-this)), so there's inherent unfamiliarity here.

Additional friction:

- **File discovery noise**: searching for a single construct returns many results. Even navigating to a file will surface many of the same files across SDK implementations. This is probably the biggest day-to-day annoyance.
- **CI complexity**: multiple different things being built and tested in one repo. Pipelines require more custom code/configs to handle per-project builds, and this usually requires different tooling which can be more complex to set up and maintain.
- **Migration effort**: real work to get it all working. Changes the ground underneath existing PRs. Issues need to be bulk migrated. Versioning/history gets noisier since git log fills up with commits on unrelated trees.
- **GitHub is built around repos, not projects**: a monorepo flattens several repo-level abstractions that don't have good sub-repo equivalents.
	- *Releases*: tags and GitHub Releases share one timeline, even when sub-projects release independently.
	- *Issues*: users filing a Python SDK bug land in the same tracker as TypeScript and docs issues — no implicit scoping.
	- *Community signal*: stars, watchers, and forks collapse into one number. We lose visibility into which SDK is driving adoption or interest.

### Recommendation

The cons are real but manageable — CI complexity is solvable with path-based triggers, GitHub UX limitations can be mitigated with labels and naming conventions, and the migration is a one-time cost. The speed gains from co-location are ongoing: every feature, every port, every doc update benefits from having everything in one checkout. For a single team shipping across multiple languages with heavy agentic development, that daily velocity improvement outweighs the friction.

Additionally, **WASM is already pushing us here**. The TypeScript SDK has started moving towards a monorepo structure on its own because the WASM work requires co-locating TypeScript and Python code. `sdk-typescript` already has folders for the projected Python API from TS (`strands-ts`). Continue this pattern and go all in on a mono repository.

## Considerations

### What do other SDK projects do?

No major SDK project puts multiple language implementations in a single cross-language monorepo. The industry standard is monorepo-per-language (Azure, Google Cloud, LangChain) or fully separate repos per language. See [Appendix A](#appendix-a-how-do-other-sdk-projects-handle-this) for the full survey.

But those projects have dedicated teams per language. Azure has a Python team and a separate JS team. Google Cloud has separate teams per language. Their reasons for staying separate — independent contributor pools, independent release cadences, independent backlogs — don't apply to us. We're a single team implementing the same features across multiple languages, shooting for feature parity. That's a fundamentally different workflow, and it's the reason co-location helps us where it wouldn't help them.

This whole argument falls apart if that stops being true. If we eventually have dedicated per-language teams, or want the SDKs to diverge, then co-location is just noise and we should revisit.

### Will the repo be too big?

The combined repos total ~227 MB with ~2,000 commits. Industry monorepo problems don't manifest until 10+ GB / 100K+ files / 500K+ commits — we're 50–250x below every known threshold. Even with aggressive growth over 2+ years, Strands would remain in the "trivially small" category for Git.

The `samples` and `docs` repos are the largest (~130 MB and ~85 MB) due to binary assets — these should use Git LFS as a best practice regardless of repo structure.

See [Appendix B: Monorepo Size Research](#appendix-b-monorepo-size-research) for detailed thresholds, case studies, and projections.

### What happens to git history?

Git histories from each repo can be merged into the monorepo using standard techniques (`git merge --allow-unrelated-histories` with subtree moves, or tools like `git filter-repo` to rewrite paths before merging). This preserves full commit history, blame, and bisect across all projects. It's a well-documented, routine operation — many organizations do this when consolidating repos.

## Appendix A: How Do Other SDK Projects Handle This?

<details>
<summary>Click to expand</summary>

### The Short Answer

**Almost no one puts multiple language SDKs in a single cross-language monorepo.** The dominant pattern in the industry is a monorepo *per language* — one repo containing all packages for a given language, but separate repos for each language implementation. A few projects use fully separate repos per language with no monorepo at all. Cross-language monorepos are rare and tend to be application-level, not SDK-level.

That said, the projects that *do* consolidate across languages report significant velocity gains, especially in the context of agentic development. The question isn't whether the industry does this — it's whether the industry's reasons for *not* doing it apply to us.

### Survey of SDK Repository Strategies

Every multi-language SDK project we found uses separate repos per language. None put Python + TypeScript (or any two languages) in a single cross-language monorepo.

**Per-language repos (hand-written SDKs):**
- **Azure SDKs** — monorepo per language (`azure-sdk-for-python`, `azure-sdk-for-js`, etc.) with a shared guidelines repo. ([source](https://devblogs.microsoft.com/azure-sdk/building-the-azure-sdk-repository-structure/))
- **Google Cloud SDKs** — separate repo per language (`google-cloud-python`, `google-cloud-node`, etc.)
- **Firebase SDKs** — separate repo per language, each a monorepo of product packages within that language.
- **OpenTelemetry** — separate repo per language, with a shared spec repo defining the cross-language API contract.
- **LangChain** — monorepo per language (`langchain` for Python, `langchainjs` for TS). ([source](https://python.langchain.com/v0.2/docs/contributing/repo_structure/))

**Per-language repos (auto-generated SDKs) — less comparable to us:**
- **AWS SDKs** — separate repo per language, code-generated from [Smithy](https://smithy.io) models.
- **Stripe SDKs** — separate repo per language, code-generated from an OpenAPI spec.
- **OpenAI SDKs** — separate repo per language, code-generated via [Stainless](https://www.stainlessapi.com/).
- **Pulumi** — per-language SDKs generated from provider schemas.

The auto-generated SDKs are worth calling out because their repo-per-language structure is a natural consequence of the code generation pipeline, not a deliberate architectural choice. Each language SDK is an output artifact. Cross-language consistency comes from the shared model/spec, not from repo co-location — and there's no human writing both implementations, so the "context switching" problem doesn't exist. This makes them a weak counterexample to our proposal.

**Single-language projects** (CrewAI, OpenAI Agents SDK, Vercel AI SDK) aren't comparable — they don't face the cross-language question at all.

### Key Takeaway

Nobody at scale puts multiple hand-written language SDKs in the same repo. The reasons are practical: different CI toolchains, different release cadences, different contributor pools, and package manager ecosystems that expect language-specific repos. Companies like Google and Microsoft use massive cross-language monorepos *internally*, but their open-source SDKs are still split by language — those internal monorepo benefits come from custom tooling (Bazel, Citc, Piper) that doesn't exist in the OSS ecosystem.

### How Others Solve Cross-Language Consistency Without Co-Location

If consistency is a primary reason for a monorepo, it's worth understanding how other projects achieve it across separate repos — and where their approach breaks down for us.

**Formal specification + review board (Azure, OpenTelemetry).** Azure has the most mature process. They maintain a shared [design guidelines repo](https://azure.github.io/azure-sdk/general_introduction.html) with both general and per-language rules. An Architecture Board reviews every SDK before beta and GA release across all Tier 1 languages (.NET, Java, JS/TS, Python). Their explicit priority order: consistency within the language > consistency with the service > consistency between languages. OpenTelemetry takes a similar approach — a [specification repo](https://github.com/open-telemetry/opentelemetry-specification) defines the cross-language API contract using RFC-style language (MUST, SHOULD, MAY), and each language SIG implements against it. ([source](https://azure.github.io/azure-sdk/policies_reviewprocess.html))

**Shared serialization format (LangChain).** LangChain Python and LangChainJS use the same serializable format for prompts, chains, and agents, so artifacts can be shared between languages. But in practice, the TypeScript implementation [consistently lags behind Python](https://octomind.dev/blog/on-type-safety-in-langchain-ts) in features and documentation. Multiple developers have noted that LangChainJS feels like a port rather than a co-designed SDK. The separate repos make it easy for the two implementations to drift.

**Code generation from a shared model (AWS, Stripe, OpenAI).** These projects sidestep the consistency problem entirely — a single source of truth (Smithy model, OpenAPI spec) generates all language SDKs mechanically. Consistency is guaranteed by the generator, not by human coordination.

**Why these approaches haven't pushed anyone to co-locate:**

The only project that has explicitly documented *why* they chose per-language repos is Azure. Their [blog post on repository structure](https://devblogs.microsoft.com/azure-sdk/azure-sdk-packaging-tools-and-repository-structure/) explains the decision was driven by **package management toolchains**: each language ecosystem (NuGet, Maven, npm, PyPI) has different packaging formats, discovery mechanisms, and cardinality constraints (e.g., Swift Package Manager enforces one package per repo). Azure's conclusion was to align repo structure with the idioms of each ecosystem rather than fight the tooling. The consistency problem is handled separately through the Architecture Board and shared guidelines repo.

For OpenTelemetry and LangChain, we couldn't find documented rationale for why they chose separate repos. It's likely a combination of the same toolchain concerns plus the fact that these are large open-source projects with many contributors — but that's inference, not evidence. We don't actually know whether they considered and rejected a cross-language monorepo, or whether it simply never came up.

**Where this breaks down for us:** Azure's toolchain argument is real — Python and TypeScript have fundamentally different build/test/publish pipelines. But it's a solvable problem with path-based CI, not a hard blocker. The more interesting question is whether the consistency mechanisms these projects use (spec repos, architecture boards, shared serialization formats) would work for us. They're designed for large organizations with dedicated per-language teams. We have a small team where the same people implement features in both Python and TypeScript. Our consistency problem isn't "how do two separate teams stay aligned" — it's "how does one person (or one agent) efficiently port a feature from one implementation to the other." A spec repo and review board don't help with that. Having both implementations visible in the same checkout does.

The LangChain example is the most cautionary for us. They have a similar profile (Python-first, TypeScript port, overlapping concerns) and chose separate repos. The result is that TypeScript [consistently lags behind Python](https://octomind.dev/blog/on-type-safety-in-langchain-ts) in features and documentation, and multiple developers have noted that LangChainJS feels like a port rather than a co-designed SDK. We can't prove separate repos *caused* that drift, but it's a pattern worth noting.

### The Agentic Development Argument

This is where the standard industry wisdom may not apply to us. The strongest argument for consolidation isn't about CI or versioning — it's about agent context.

**Evidence that monorepos help agents:**
- AI Hero Studio [documented](https://aihero.studio/blog/platform/agent-factory-monorepo) shipping a complete feature (backend, frontend, voice integration, website) in a single 3-hour agent session from a monorepo — something that would have required multi-day coordination across separate repos.
- A [2026 analysis](https://tianpan.co/blog/2026-04-17-coding-agents-monorepo-context-window) of coding agents in monorepos found that the core failure mode is agents calling interfaces that were renamed in other parts of the codebase they can't see. Cross-repo splits make this worse because the agent literally cannot access the other repo's current state.
- Research on agent-assisted PRs ([arxiv](https://arxiv.org/abs/2509.14745)) shows 83.8% of agent-assisted PRs are accepted, with 54.9% merged without modification — but this works best when the agent has full context of the change surface.

**The counterargument:** Large monorepos can *hurt* agents too. Context windows have limits (100K–2M tokens), and a 50-service monorepo can exceed what an agent can effectively attend to. The "lost in the middle" problem means agents treat content near the middle of long contexts less reliably than content at the edges. For Strands specifically, the combined SDK + docs + samples is likely well within manageable context size, but it's worth monitoring.

### What This Means for the Proposal

**We'd be doing something unusual.** No major SDK project puts Python and TypeScript implementations in the same repo. The industry consensus is monorepo-per-language with a shared spec/contract repo.

**The industry's reasons may not be our reasons.** The standard arguments against cross-language monorepos assume:
- Large, separate contributor communities per language (we have a small, overlapping team)
- Independent release cadences (we release both SDKs in lockstep for feature parity)
- No need for cross-language context during development (we're constantly porting features between Python and TypeScript)
- Human-only development workflows (we're heavily invested in agentic development)

If the primary driver is **conventional best practice**, the monorepo-per-language model (Azure/LangChain style) is the safer choice with well-understood tradeoffs.

</details>

## Appendix B: Monorepo Size Research

<details>
<summary>Click to expand</summary>

*Research conducted 2026-05-05*

### Current Strands Repo Sizes (via GitHub API)

| Repo | Size | Commits |
|------|------|---------|
| sdk-python | 3.9 MB | ~685 |
| sdk-typescript | 2.8 MB | ~416 |
| docs | 84.5 MB | ~527 |
| samples | 130 MB | ~141 |
| tools | 734 KB | ~164 |
| mcp-server | 39 KB | — |
| devtools | 190 KB | — |
| agent-builder | 70 KB | — |
| agent-sop | 477 KB | — |
| **Combined** | **~227 MB** | **~2,000** |

### Platform Limits

**GitHub:**
- Recommended on-disk size: < 10 GB
- Hard limit: 100 GB (warning at 75 GB)
- Single file: < 100 MB enforced, < 50 MB recommended
- Directory width: < 3,000 entries
- Branches: < 5,000

**Azure DevOps:** Recommends < 10 GB for optimal performance.

### Performance Thresholds by Dimension

**Working tree (git status, git add, checkout) — driven by file count:**

| File Count | Impact |
|-----------|--------|
| < 10,000 | No noticeable issues |
| 10,000–50,000 | Slight slowdown without FSMonitor; imperceptible with it |
| 50,000–100,000 | `git status` takes 2–5 seconds without optimization |
| 100,000–500,000 | Requires FSMonitor + sparse-checkout |
| 500,000+ | Requires Scalar or VFS for Git |

**History operations (git log, git blame) — driven by commit count:**

| Commit Count | Impact |
|-------------|--------|
| < 50,000 | No issues |
| 50,000–500,000 | `git log --graph` slows without commit-graph cache |
| 500,000–1M+ | Noticeable delays; commit-graph essential |
| 10M+ | Requires history pruning |

**Clone time — driven by repo size:**

| Repo Size | Approximate Clone Time |
|-----------|----------------------|
| < 1 GB | Seconds to low minutes |
| 1–5 GB | 2–10 minutes |
| 5–20 GB | 10–30 minutes |
| 20–50 GB | 30–60 minutes |
| 50–100 GB | 1+ hours |

### Case Studies

**Dropbox (March 2026)** — [source](https://dropbox.tech/infrastructure/reducing-our-monorepo-size-to-improve-developer-velocity)
- 87 GB monorepo, growing 20–60 MB/day
- Clone took > 1 hour; CI jobs repeatedly paying that cost
- Approaching GitHub's 100 GB hard limit
- Root cause: Git's delta compression heuristics interacting poorly with i18n directory structure (16-char path suffix matching paired unrelated files)
- Fix: Server-side repack with tuned window/depth parameters → reduced to 20 GB (77% reduction)
- Lesson: Size problems can be structural (how Git compresses), not just volumetric

**Grab (September 2025)** — [source](https://engineering.grab.com/taming-monorepo-beast)
- 214 GB, 13M commits, 12M references, 444K files
- Clone: 8+ minutes; replication lag: up to 4 minutes
- GitLab HA completely broken — all traffic forced to single primary node
- Fix: Custom migration script preserving tags + 1 month of history → 87 GB, 15.8K commits
- Result: 99.4% improvement in replication, 36% faster clones
- Lesson: Commit count and reference count matter as much as raw size

**Canva (June 2022)** — [source](https://www.canva.dev/blog/engineering/we-put-half-a-million-files-in-one-git-repository-heres-what-we-learned/)
- 500K files, 60M lines of code, hundreds of engineers
- Thousands of PRs/week, tens of thousands of commits/week
- `git status` became the primary bottleneck, especially on macOS
- Fix: FSMonitor, sparse-checkout, custom tooling
- Lesson: File count is the primary working-tree performance driver

**Microsoft Windows (2017)** — [source](https://devblogs.microsoft.com/bharry/the-largest-git-repo-on-the-planet/)
- 300 GB, 3.5M files, push every 20 seconds from 4,000 developers
- Standard Git completely unusable
- Created GVFS (Git Virtual File System), later evolved into Scalar
- Virtualizes the working tree so Git only downloads/stats files you access
- Lesson: At extreme scale you need a virtual filesystem layer — but this is orders of magnitude beyond any SDK project

**Chromium** — [benchmarked by git-tower](https://www.git-tower.com/blog/git-performance)
- ~500K files
- `git status`: ~3.5 seconds without optimization
- With FSMonitor: < 1 second
- Lesson: Modern Git features handle even very large repos well

### What Actually Causes Problems

The research consistently shows that **size alone is not the issue**. The problematic dimensions are:

1. **File count in working tree** (> 100K files → `git status` slowdown)
2. **Commit/reference count** (> 1M commits → history operations slow)
3. **Large binary files without LFS** (bloat history, poor delta compression)
4. **CI clone overhead** (fresh clones on every job multiply any size issue)
5. **Concurrent developer load** (> 500 devs pushing frequently → server-side pressure)

Things that are NOT problematic:
- Multiple language directories in one repo (no performance impact)
- Moderate file counts (< 50K is fine without any optimization)
- Moderate history (< 100K commits is fine)

### Available Mitigations (in order of when you'd need them)

1. **Git LFS** — for binary assets > 1 MB (best practice from day 1)
2. **`.gitignore` hygiene** — exclude build artifacts, node_modules, __pycache__
3. **FSMonitor** (`core.fsmonitor true`) — free speedup at > 50K files
4. **Commit-graph** (`fetch.writeCommitGraph true`) — speeds history at > 50K commits
5. **Sparse-checkout** — only check out needed directories (> 100K files)
6. **Partial clone** (`--filter=blob:none`) — skip downloading blobs until needed
7. **Shallow clone for CI** (`--depth=1`) — CI doesn't need full history
8. **Scalar** — Microsoft's tool for repos approaching millions of files

For Strands, only #1 and #2 are relevant today.

</details>
