# TUI integration tests

These tests launch the real Ink TUI inside a PTY on POSIX or ConPTY on Windows. They exercise keyboard input, streamed conversation output, slash-command panels, shell commands, resizing, and terminal cleanup against a deterministic backend.

`npm run test:tui-integration` renders a live table showing every scenario, its purpose, status, and latency.

This is not a comprehensive product E2E suite: it starts the real TUI with a deterministic backend, not the full CLI/provider setup path. The credentialed built-binary E2E suite lives in `test/integration/`.
