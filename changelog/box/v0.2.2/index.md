# Box v0.2.2

Released 2026-11-10
Release: https://github.com/strands-agents/box/releases/tag/v0.2.2 · Package: https://github.com/strands-agents/box/releases/tag/v0.2.2

## Features
- connect the shell to tool grammars (https://github.com/strands-agents/box/pull/327)
- stream responses with credential redaction (https://github.com/strands-agents/box/pull/345)
- support MCP 2026-07-28 over stdio (https://github.com/strands-agents/box/pull/350)

## Fixes
- clear the degraded mark when a complete policy bundle installs (https://github.com/strands-agents/box/pull/225)
- decide an undeclared name of a grammar-bound file as shell:spawn (https://github.com/strands-agents/box/pull/352)
- decide a union MCP argument by policy (https://github.com/strands-agents/box/pull/360)
- admit hard-linked commands outside workload write grants (https://github.com/strands-agents/box/pull/347)
- keep Core diagnostics out of the active workload terminal (https://github.com/strands-agents/box/pull/353)
- sanitize statfs for Codex database startup (https://github.com/strands-agents/box/pull/356)
- allow root directory write grants (https://github.com/strands-agents/box/pull/348)
- skip hard-link scans when Linux mount and filename checks pass (https://github.com/strands-agents/box/pull/381)
- bind a tool grammar to how box cli binds tools (https://github.com/strands-agents/box/pull/358)
- accept Linux namespace mounts during executable validation (https://github.com/strands-agents/box/pull/382)
- keep a per-tool rule's history across a restart (https://github.com/strands-agents/box/pull/383)

## Other
- unslop docs/design and docs/dev (https://github.com/strands-agents/box/pull/335)
- verify ::response events for tool grammar actions (https://github.com/strands-agents/box/pull/333)
- add LOG\_ONLY mode design doc (https://github.com/strands-agents/box/pull/310)
- fix the tool grammar fixtures for git, cargo and aws (https://github.com/strands-agents/box/pull/325)
- ingress tcp relay design (https://github.com/strands-agents/box/pull/271)
