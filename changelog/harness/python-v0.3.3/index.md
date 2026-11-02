# Harness Python v0.3.3

Released 2026-10-29
Release: https://github.com/strands-agents/harness-sdk/releases/tag/harness-python/v0.3.3 · Package: https://pypi.org/project/strands-harness/0.3.3/

## Fixes
- report the real working directory on Windows [server] (https://github.com/strands-agents/harness-sdk/pull/5473)
- make Gemini effort levels per model; Argon and 3.8 Flash reject minimal (py + ts + cli) [model] (https://github.com/strands-agents/harness-sdk/pull/5456)
- grant the integ role the new smoke-test Bedrock models [model] (https://github.com/strands-agents/harness-sdk/pull/5506)
- make integ test metrics and dashboards trustworthy (https://github.com/strands-agents/harness-sdk/pull/5503)
- grant the integ role the global Claude Haiku 4.5 profile [model] (https://github.com/strands-agents/harness-sdk/pull/5508)
- leave an already-installed tracer provider and its propagators alone [otel] (https://github.com/strands-agents/harness-sdk/pull/5481)
- match Bedrock GPT effort levels per model and extend the gates to Daybreak ids (py + ts + cli) [model] (https://github.com/strands-agents/harness-sdk/pull/5485)

## Other
- run harness tests against the local SDK on SDK changes (https://github.com/strands-agents/harness-sdk/pull/5333)
- enforce TypeScript formatting (https://github.com/strands-agents/harness-sdk/pull/5468)
- close superseded release announcements (https://github.com/strands-agents/harness-sdk/pull/5471)
- add red teaming launch post for Strands Evals (https://github.com/strands-agents/harness-sdk/pull/5543)
- align tool deprecation guidance with strands-py warn rules (https://github.com/strands-agents/harness-sdk/pull/5579)
- cover harness, CLI, and new SDK subsystems in issue classifier (https://github.com/strands-agents/harness-sdk/pull/5592)
- bump actions/setup-python from 7.0.0 to 7.1.0 (https://github.com/strands-agents/harness-sdk/pull/5519)
- bump astral-sh/setup-uv from 10.3.0 to 10.3.2 (https://github.com/strands-agents/harness-sdk/pull/5518)
- paginate issue events and comments in auto-close (https://github.com/strands-agents/harness-sdk/pull/5607)
- read Node from .node-version and raise it to 22.23.4 (https://github.com/strands-agents/harness-sdk/pull/5616)
- pick Node for previews independently of the PR branch (https://github.com/strands-agents/harness-sdk/pull/5638)
- raise the TypeScript integ metrics test-name cap to 2000 (https://github.com/strands-agents/harness-sdk/pull/5646)
