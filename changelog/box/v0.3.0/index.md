# Box v0.3.0

Released 2026-11-23
Release: https://github.com/strands-agents/box/releases/tag/v0.3.0 · Package: https://github.com/strands-agents/box/releases/tag/v0.3.0

## Features
- name what a file needs of box in one \[requires\] table (https://github.com/strands-agents/box/pull/557)
- remove box clean, now that box profile clean removes boxes (https://github.com/strands-agents/box/pull/574)
- show the welcome on updates too (https://github.com/strands-agents/box/pull/596)
- add an @box/rg tool pack for Codex (https://github.com/strands-agents/box/pull/612)
- run Claude Code on a claude.ai subscription (https://github.com/strands-agents/box/pull/611)
- bring the host's Kiro CLI settings into the box (https://github.com/strands-agents/box/pull/565)

## Fixes
- use one ownership rule for box runs list \<name\> and box profile clean \<name\> (https://github.com/strands-agents/box/pull/575)
- save run logs and preview errors on exit (https://github.com/strands-agents/box/pull/576)
- fix the first-run nits from the pre-release check (https://github.com/strands-agents/box/pull/608)
- end a terminal run with a short summary, and warn once about a bare aws:// (https://github.com/strands-agents/box/pull/610)
- warn once at startup for each bare aws:// destination (https://github.com/strands-agents/box/pull/613)
- grant launcher shebang interpreters and accept RFC 7230 MCP header names (https://github.com/strands-agents/box/pull/614)
- permit no-op setresuid and setresgid on Linux so make runs (https://github.com/strands-agents/box/pull/554)

## Other
- make the box CLI the entry point on the docs site and in the README (https://github.com/strands-agents/box/pull/568)
