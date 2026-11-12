# Shell v0.6.0

Released 2026-11-04
Release: https://github.com/strands-agents/shell/releases/tag/v0.6.0 · Package: https://github.com/strands-agents/shell/releases/tag/v0.6.0

## Features
- accept legacy -N line counts in head and tail (https://github.com/strands-agents/shell/pull/171)
- add the builtin builtin (https://github.com/strands-agents/shell/pull/174)
- stop re-resolving every prefix of a missing path (https://github.com/strands-agents/shell/pull/175)
- make the interactive CLI an optional default feature (https://github.com/strands-agents/shell/pull/172)
- let a kernel run commands Shell doesn't implement (https://github.com/strands-agents/shell/pull/190)

## Fixes
- honor -- in unset and unalias (https://github.com/strands-agents/shell/pull/168)
- report a failed redirect on a builtin (https://github.com/strands-agents/shell/pull/169)
- treat localhost with a trailing dot like localhost (https://github.com/strands-agents/shell/pull/170)
- report the timeout when a command succeeds past the deadline (https://github.com/strands-agents/shell/pull/173)
- keep output truncation on a UTF-8 character boundary (https://github.com/strands-agents/shell/pull/176)
- stop recursion through pipelines at the depth limit (https://github.com/strands-agents/shell/pull/177)
- return real statuses from compounds in command substitution (https://github.com/strands-agents/shell/pull/179)
- apply the input size limit to multiline input (https://github.com/strands-agents/shell/pull/178)
- report removal refusals, including under -f (https://github.com/strands-agents/shell/pull/180)
- run break, continue and exit inside command substitution (https://github.com/strands-agents/shell/pull/189)
- fail a write that goes past max\_file\_size (https://github.com/strands-agents/shell/pull/198)

## Other
- bump pyo3 from 0.29.2 to 0.29.3 (https://github.com/strands-agents/shell/pull/128)
- bump syn from 3.0.2 to 3.0.9 (https://github.com/strands-agents/shell/pull/153)
- register empty\_pipeline\_stage\_no\_panic (https://github.com/strands-agents/shell/pull/152)
- give each test its own temporary directory (https://github.com/strands-agents/shell/pull/154)
- bump pyo3 from 0.29.3 to 0.30.1 (https://github.com/strands-agents/shell/pull/164)
- pin the public Python API of strands\_shell (https://github.com/strands-agents/shell/pull/159)
- pin the public TypeScript API of @strands-agents/shell (https://github.com/strands-agents/shell/pull/160)
- fix three limit and credential tests (https://github.com/strands-agents/shell/pull/162)
- wait for the bind\_direct write-back instead of sleeping 50 ms (https://github.com/strands-agents/shell/pull/163)
- make three curl tests exercise the behavior they name (https://github.com/strands-agents/shell/pull/158)
- make mcp\_shell\_timeout actually expire and check recovery (https://github.com/strands-agents/shell/pull/157)
- pin the Rust API a custom Kernel depends on (https://github.com/strands-agents/shell/pull/161)
- run MCP tests against the binary Cargo built (https://github.com/strands-agents/shell/pull/155)
- run doc tests and node-feature unit tests in the Rust job (https://github.com/strands-agents/shell/pull/156)
- make strands-box-maintainers the code owners (https://github.com/strands-agents/shell/pull/167)
- bump rustls from 0.23.40 to 0.23.46 (https://github.com/strands-agents/shell/pull/141)
- bump tokio from 1.53.1 to 1.53.3 (https://github.com/strands-agents/shell/pull/165)
- bump toml from 1.1.2+spec-1.1.0 to 1.1.8+spec-1.1.0 (https://github.com/strands-agents/shell/pull/148)
- bump serde\_json from 1.0.151 to 1.0.154 (https://github.com/strands-agents/shell/pull/149)
- bump napi-derive from 3.6.11 to 3.6.12 (https://github.com/strands-agents/shell/pull/143)
- bump rustyline from 18.0.0 to 19.0.0 (https://github.com/strands-agents/shell/pull/166)
- bump inventory from 0.3.24 to 0.3.25 (https://github.com/strands-agents/shell/pull/146)
- bump typescript from 6.0.3 to 7.0.2 (https://github.com/strands-agents/shell/pull/54)
- bump actions/checkout from 6 to 7 (https://github.com/strands-agents/shell/pull/40)
- bump napi from 3.14.2 to 3.15.0 (https://github.com/strands-agents/shell/pull/182)
- bump tokio from 1.53.3 to 1.54.1 (https://github.com/strands-agents/shell/pull/183)
- bump napi-derive from 3.6.12 to 3.6.13 (https://github.com/strands-agents/shell/pull/184)
