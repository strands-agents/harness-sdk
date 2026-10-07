# TUI integration tests

These tests launch the real Ink TUI inside a PTY on POSIX or ConPTY on Windows. They exercise keyboard input, streamed conversation output, slash-command panels, shell commands, resizing, and terminal cleanup against a deterministic backend.

They do not call a live model. The credentialed built-binary E2E suite lives in `test/integration/`.
