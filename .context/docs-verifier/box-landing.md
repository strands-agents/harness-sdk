# Box landing page verification

Verified: 2026-11-13

## Scope

- `site/src/pages/box.astro`
- `site/src/pages/box/index.md.ts`
- `site/src/components/box/`
- `site/src/config/box-landing.ts`

## Source of truth

The imported Box documentation is pinned to revision
`6097aed88c4c0e0a3f115efc40ad2b0e0c100c64`.

## Claims

| Landing-page claim | Evidence | Result |
| --- | --- | --- |
| Box runs agents on macOS and Linux under policy. | `site/.build/external-docs/strands-box/content/quickstart.md:15` | Verified |
| `box.toml` defines the workload and direct reach; `policy.dw` decides mediated requests. | `site/.build/external-docs/strands-box/content/quickstart.md:17`, `site/.build/external-docs/strands-box/content/reference/configuration.md:15-17` | Verified |
| Policy covers commands, file operations, network requests, and MCP calls routed through Box. | `site/.build/external-docs/strands-box/content/reference/configuration.md:393`, `site/.build/external-docs/strands-box/content/reference/configuration.md:648-680`, and the Box policy reference | Verified |
| Requests without a matching permit are refused. | `site/.build/external-docs/strands-box/content/reference/configuration.md:89`, `site/.build/external-docs/strands-box/content/guides/write-a-policy.md:145` | Verified |
| Box records policy decisions and the governing rule or refusal reason. | `site/.build/external-docs/strands-box/content/guides/write-a-policy.md:160-213` | Verified |
| Supported landing-page platforms are Apple silicon macOS and ARM64 Linux. | `site/.build/external-docs/strands-box/content/quickstart.md:58-63` | Verified |

## Code examples

The `box.toml` and `policy.dw` examples are excerpts from the imported Box
quickstart and policy tutorial. The runnable agent commands exactly match the
imported guides:

- Claude Code:
  `site/.build/external-docs/strands-box/content/guides/run-claude-code.md:230`
- Codex CLI:
  `site/.build/external-docs/strands-box/content/guides/run-codex-cli.md:214`
- Strands Agent:
  `site/.build/external-docs/strands-box/content/guides/run-strands-harness.md:228`

Each runnable example links to its complete setup guide; the landing page does
not present these commands as standalone setup instructions.

## Mechanical verification

- Repository pre-push checks
- Astro production build and broken-link checker
- Site type checking
- Site test suite, including Box page rendering and example switching/copying
- Desktop visual inspection in dark mode
