# Live CLI integration tests

Run from `strands-cli/` with provider credentials available:

```sh
npm run build
npm run test:integ
```

To run only the self-building lifecycle:

```sh
npm run test:integ -- test/integration/self-building.test.ts
```

`STRANDS_INTEG_MODEL` overrides the default Bedrock Claude Haiku model. These tests make real provider calls.
The terminal driver uses Python 3 on macOS/Linux and ConPTY on Windows.
Python exports require Python 3.10 or newer. The test uses `harness-py/.venv` when available; set
`STRANDS_TEST_PYTHON` to another interpreter if needed. Imports install the archive's dependencies into fresh environments.

The self-building test launches the built CLI in a terminal with its base tools and no MCP servers. It asks the
agent to add and apply a local MCP server through chat, then calls the new tool. It opens `/config`, exports,
and repeats use → `/config` → export after two fresh imports, for both TypeScript and Python archives.
Each launch has a separate CLI home and workspace;
the original server source is deleted before importing.

Every round checks a server-recorded challenge and fresh receipt against the agent's tool result, verifies the
server is packaged, and compares the `/config` document byte for byte with the archived entrypoint. A read-only
observer captures the controller snapshots used by the real TUI; it does not replace the model or command handlers.
Failures retain snapshots and terminal diagnostics in the temporary directory printed by the test.
