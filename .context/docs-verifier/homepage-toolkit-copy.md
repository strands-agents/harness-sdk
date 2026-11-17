## Docs Verification: Homepage toolkit copy

**File:** `site/src/components/InteractiveToolkit.astro`
**Verified against:** `aa25f9443` on `codex/homepage-toolkit-hierarchy`
**Result:** 9 claims, 0 findings

### Findings

None.

### Full Claim Inventory

| # | Line | Claim | Accuracy | Checked by | Evidence |
|---|---|---|---|---|---|
| 1 | 51-52 | Strands harness provides tuned defaults, supports production use, and lets developers replace individual components. | correct | read | `harness-ts/README.md:36-42`; `site/src/content/docs/user-guide/harness/production.mdx:13-16`; `site/src/content/docs/user-guide/harness/index.mdx:57-62` |
| 2 | 79-81 | The Strands Harness SDK exposes the model, tools, memory, session management, hooks, and agent loop for direct composition. | correct | read | `site/src/content/docs/user-guide/sdk/index.mdx:16-18`; `strands-py/src/strands/agent/agent.py:250-268` |
| 3 | 108-110 | Strands Box runs agent work in operating-system-enforced sandboxes with filesystem, network, and policy controls. | correct | read | `site/.build/external-docs/strands-box/content/quickstart.md:15-17`; `site/.build/external-docs/strands-box/content/security.md:15-19`; `site/.build/external-docs/strands-box/content/security.md:32-50` |
| 4 | 150-152 | Strands Evals runs evaluation experiments, detects failures, and measures agent resilience before deployment. | correct | read | `site/src/content/docs/user-guide/evals-sdk/index.mdx:10-12`; `site/src/content/docs/user-guide/evals-sdk/detectors/failure_detection.mdx:9`; `site/src/content/docs/user-guide/evals-sdk/chaos_testing.mdx:9-30` |
| 5 | 195-197 | Strands Decider routes, classifies, or scores known outcomes with a small decision model that reports confidence. | correct | read | `site/.build/external-docs/strands-decider/content/overview.md:15-18`; `site/.build/external-docs/strands-decider/content/overview.md:25-31` |
| 6 | 55-57 | The Python harness package installs as `strands-harness`. | correct | read | `harness-py/pyproject.toml:5-8` |
| 7 | 55-57 | The TypeScript harness package installs as `@strands-agents/harness`. | correct | read | `harness-ts/package.json:1-4` |
| 8 | 84-86 | The Python SDK package installs as `strands-agents`. | correct | read | `strands-py/pyproject.toml:6-9` |
| 9 | 84-86 | The TypeScript SDK package installs as `@strands-agents/sdk`. | correct | read | `strands-ts/package.json:1-4` |

Not claims: action labels, accessibility labels, typography, spacing, and the compact install-command presentation.

### Commands Run

| Command | Result |
|---|---|
| `npm run build` | pass, 1261 pages, no broken links |
| `npm test -- --run test/homepage-metadata.test.ts` | pass, 9 tests |
| `npm run typecheck` | pass |
| `npx prettier --check src/components/InstallCommand.astro src/components/InteractiveToolkit.astro test/homepage-metadata.test.ts` | pass |
