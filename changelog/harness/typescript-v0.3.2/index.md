# Harness TypeScript v0.3.2

Released 2026-10-29
Release: https://github.com/strands-agents/harness-sdk/releases/tag/harness-typescript/v0.3.2 · Package: https://www.npmjs.com/package/@strands-agents/harness/v/0.3.2

## Fixes
- run web\_fetch's curl through PowerShell when the sandbox speaks it [tool, server] (https://github.com/strands-agents/harness-sdk/pull/5328)
- report the real working directory on Windows [server] (https://github.com/strands-agents/harness-sdk/pull/5473)
- make Gemini effort levels per model; Argon and 3.8 Flash reject minimal (py + ts + cli) [model] (https://github.com/strands-agents/harness-sdk/pull/5456)
- grant the integ role the new smoke-test Bedrock models [model] (https://github.com/strands-agents/harness-sdk/pull/5506)
- make integ test metrics and dashboards trustworthy (https://github.com/strands-agents/harness-sdk/pull/5503)
- grant the integ role the global Claude Haiku 4.5 profile [model] (https://github.com/strands-agents/harness-sdk/pull/5508)
- match Bedrock GPT effort levels per model and extend the gates to Daybreak ids (py + ts + cli) [model] (https://github.com/strands-agents/harness-sdk/pull/5485)

## Other
- bump re-actors/alls-green from 1.2.2 to 1.3.0 (https://github.com/strands-agents/harness-sdk/pull/3963)
- apply area-catalog label to PRs touching catalog entries (https://github.com/strands-agents/harness-sdk/pull/5334)
- bump actions/upload-artifact from 7.0.1 to 7.0.2 (https://github.com/strands-agents/harness-sdk/pull/5099)
- bump actions/download-artifact from 8.0.1 to 8.0.2 (https://github.com/strands-agents/harness-sdk/pull/5097)
- bump astral-sh/setup-uv from 10.0.1 to 10.3.0 (https://github.com/strands-agents/harness-sdk/pull/5098)
- run harness tests against the local SDK on SDK changes (https://github.com/strands-agents/harness-sdk/pull/5333)
- enforce TypeScript formatting (https://github.com/strands-agents/harness-sdk/pull/5468)
- give the web\_fetch end-to-end test a 30 s timeout (https://github.com/strands-agents/harness-sdk/pull/5469)
- close superseded release announcements (https://github.com/strands-agents/harness-sdk/pull/5471)
- add red teaming launch post for Strands Evals (https://github.com/strands-agents/harness-sdk/pull/5543)
- align tool deprecation guidance with strands-py warn rules (https://github.com/strands-agents/harness-sdk/pull/5579)
- cover harness, CLI, and new SDK subsystems in issue classifier (https://github.com/strands-agents/harness-sdk/pull/5592)
- bump the npm\_and\_yarn group across 6 directories with 8 updates (https://github.com/strands-agents/harness-sdk/pull/5512)
- bump actions/setup-python from 7.0.0 to 7.1.0 (https://github.com/strands-agents/harness-sdk/pull/5519)
- bump astral-sh/setup-uv from 10.3.0 to 10.3.2 (https://github.com/strands-agents/harness-sdk/pull/5518)
- paginate issue events and comments in auto-close (https://github.com/strands-agents/harness-sdk/pull/5607)
- read Node from .node-version and raise it to 22.23.4 (https://github.com/strands-agents/harness-sdk/pull/5616)
- pick Node for previews independently of the PR branch (https://github.com/strands-agents/harness-sdk/pull/5638)
- raise the TypeScript integ metrics test-name cap to 2000 (https://github.com/strands-agents/harness-sdk/pull/5646)
