# Box v0.2.1

Released 2026-11-06
Release: https://github.com/strands-agents/box/releases/tag/v0.2.1 · Package: https://github.com/strands-agents/box/releases/tag/v0.2.1

## Features
- remove the startup opt-in requirement (https://github.com/strands-agents/box/pull/234)
- demonstrate deployment retry cooldowns with Claude Code (https://github.com/strands-agents/box/pull/322)
- enable the tool packs feature behind a feature flag (https://github.com/strands-agents/box/pull/281)
- let a macOS write root set file times behind file-attributes (https://github.com/strands-agents/box/pull/305)
- let a macOS box signal its own children (https://github.com/strands-agents/box/pull/308)
- share one phantom across a credential's hosts (https://github.com/strands-agents/box/pull/309)
- add Linux ARM64 support with package validation (https://github.com/strands-agents/box/pull/298)
- add opt-in whole-argument wildcards for stdio MCP commands (https://github.com/strands-agents/box/pull/317)
- make the Shell execution timeout configurable (https://github.com/strands-agents/box/pull/312)
- use readable Linux package names (https://github.com/strands-agents/box/pull/339)
- add Google Cloud deployment and dynamic shipment policy examples (https://github.com/strands-agents/box/pull/337)

## Fixes
- refuse Linux root sandbox directory writes (https://github.com/strands-agents/box/pull/300)
- verify Claude Code deployment retries on EKS (https://github.com/strands-agents/box/pull/324)
- let a process env set runtime option variables (https://github.com/strands-agents/box/pull/306)
- accept a configured command with several names when this user cannot write it (https://github.com/strands-agents/box/pull/332)
- load per-tool rules on a box whose MCP servers are all http (https://github.com/strands-agents/box/pull/334)
- preserve request identifiers across history events (https://github.com/strands-agents/box/pull/297)
- allow startup while protecting inaccessible executable aliases (https://github.com/strands-agents/box/pull/343)

## Other
- add Linux cloud deployment profiles (https://github.com/strands-agents/box/pull/132)
- run arch-neutral jobs on the org 4-core runner (https://github.com/strands-agents/box/pull/338)
- shorten non-yielding request checks (https://github.com/strands-agents/box/pull/340)
- fold the macOS native and packaging jobs into existing jobs (https://github.com/strands-agents/box/pull/341)
