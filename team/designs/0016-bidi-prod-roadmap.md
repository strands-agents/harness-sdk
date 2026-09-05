# Bidirectional Streaming — Graduation Roadmap

**Status**: Proposed

**Date**: 2026-07-22

**Issue**: [#1722](https://github.com/strands-agents/harness-sdk/issues/1722)

## Problem

Bidirectional streaming (`strands.experimental.bidi`) is the largest experimental surface in the Strands Python SDK — 22 source files, 3 model providers, the full event type system, and 10 hook events. The experimental status blocks production adoption: teams cannot commit to an API that may break without notice between minor versions.

### Current State

- Bidi is excluded from all SDK quality gates: mypy (`pyproject.toml:224`), ruff (`:237`), pytest (`:261`), and coverage (`:271`).
- Documentation is marked `experimental: true`.
- The deprecated `stop_conversation` tool still ships with backward-compatibility shims.
- `BidiTextIO` prints "Preview: {token}" to stdout for every streaming token unconditionally.
- `BidiGeminiLiveModel` is broken with current-generation Gemini 3.1 Flash Live models.
- Nova Sonic v2 async tool calling (model continues speaking while tools run) is not supported — tools block the conversation.
- There is no packaged browser transport IO adapter.
- There is no OpenTelemetry instrumentation for bidi sessions.

## Goals and Non-Goals

**Goals:**
- Graduate bidi out of experimental per the [Feature Lifecycle](./team/FEATURE_LIFECYCLE.md) criteria
- Achieve production quality: all providers working, quality gates passing, instrumentation present
- Ship with a packaged browser transport so the most common deployment scenario works out of the box
- Minimize time-to-GA — target 4 weeks

**Non-Goals:**
- Unify `Agent` and `BidiAgent` (v2 scope)
- Add new IO adapters beyond the browser transport (VideoIO, additional WebSocket modes)
- Integrate with other experimental features (steering)
- Support multi-agent orchestration primitives for bidi
- Third-party platform integrations (Pipecat, LiveKit)

## Proposal

### Graduation Blockers

| # | Issue | Size | Estimate | Description |
|---|-------|------|----------|-------------|
| 1 | Remove build config carve-outs ([#1459](https://github.com/strands-agents/harness-sdk/issues/1459)) | S | 2-3d | Remove bidi exclusions from mypy, ruff, pytest, coverage in `pyproject.toml`. Fix resulting type/lint errors. Must land first so CI catches issues in subsequent PRs. Existing test suite (125 unit tests + integration tests across all 3 providers) is adequate — the work is making them pass in the default env. |
| 2 | Protect parallel invocations ([#1470](https://github.com/strands-agents/harness-sdk/issues/1470)) | S | 2-3d | Add concurrency guards to `BidiAgent` matching standard Agent protections. Extend existing `_message_lock` and `_started` patterns to prevent race conditions in `send()` and the event queue. |
| 3 | Gemini 3.1 Flash Live fix ([#1999](https://github.com/strands-agents/harness-sdk/issues/1999)) | S | 1-2d | Fix three bugs: use `send_realtime_input` mid-session, omit `session_resumption` when no handle exists, correct default API version to `v1beta`. Workaround already validated. |
| 4 | Nova Sonic v2 async tool calling ([#2021](https://github.com/strands-agents/harness-sdk/issues/2021)) | M | 4-5d | Decouple tool execution from result delivery in `_run_tool()` so the model continues speaking while tools run. Current `_TaskPool` runs tools concurrently — change is to not block audio output on `toolResult` send. |
| 5 | Telemetry and observability ([#1726](https://github.com/strands-agents/harness-sdk/issues/1726)) | M | In review | [PR #3282](https://github.com/strands-agents/harness-sdk/pull/3282) — OTEL spans for session lifecycle, model events, tool execution. No remaining implementation work. |
| 6 | Reduce verbose output ([#1330](https://github.com/strands-agents/harness-sdk/issues/1330)) | XS | <1d | Replace `print()` in `io/text.py` with `logger.debug()`. Hook system already provides programmatic event access. |
| 7 | Remove deprecated `stop_conversation` tool | XS | <1d | Remove `bidi/tools/stop_conversation.py` and its backward-compatibility shim in `loop.py`. Already deprecated with warnings directing users to `strands_tools.stop` or `request_state["stop_event_loop"] = True`. |
| 8 | Browser transport ([#1724](https://github.com/strands-agents/harness-sdk/issues/1724) / [#1727](https://github.com/strands-agents/harness-sdk/issues/1727)) | L | 1-2 weeks | See [Browser Transport](#browser-transport) section below. |
| 9 | Documentation and launch content | M | 3-4d | Audit docs for accuracy, add API reference for public types, write migration guide, publish GA blog post. |
| 10 | Real-world validation sample | M | 3-4d | Web-based sample app demonstrating browser audio → BidiAgent → model → tool execution → audio response. Uses the browser transport from blocker #8. |

### Browser Transport

`BidiAgent.send()` already accepts plain dicts and `agent.receive()` yields JSON-serializable events — so connecting a WebSocket to a bidi agent is possible today in ~10 lines of application code (FastAPI, etc.). However, there is no packaged IO adapter for this, and raw WebSockets lack the media-optimized transport that production voice applications need (echo cancellation, codec negotiation, NAT traversal, jitter buffering).

**Primary path: WebRTC via IVS**

The IVS team is implementing `BidiWebRtcIO` per the [WebRTC design document](./bidi-webrtc-design.md). Timeline: 1-2 weeks, fits within the graduation window. WebRTC provides native echo cancellation, codec negotiation, NAT traversal, and low latency — the standard for production browser-based voice.

**Fallback: WebSocket IO**

Independent of WebRTC, a `BidiWebSocketIO` adapter (3-4 days) packages the WebSocket wiring into a standard `BidiInput`/`BidiOutput` implementation so users don't write boilerplate. WebSocket does not include NAT traversal or browser-native echo cancellation (those are WebRTC-specific capabilities). It can serve as either a standalone option or a contingency if WebRTC isn't ready at GA time.

Either way, GA ships with a packaged browser transport.

### Timeline

**Target: 4 weeks**

**Staffing:** 1-2 Strands engineers on core blockers. IVS team owns WebRTC in parallel. Nova Sonic team may take async tool calling (#2021). Telemetry is already in review ([PR #3282](https://github.com/strands-agents/harness-sdk/pull/3282)).

**Dependencies:**
- #1459 (build config) lands first — enables CI for all subsequent PRs.
- All other blockers are independent after #1459.
- WebRTC runs fully in parallel with no dependencies on other blockers.
- Validation sample depends on browser transport (#8) being available.

### Execution Plan

Once blockers are resolved:

1. Move `strands.experimental.bidi` → `strands.bidi`.
2. Leave a deprecation shim at the old import path for one minor version.
3. Publish documentation and migration guide.

## Post-Graduation

Net-new capabilities that can ship incrementally after the API is stable.

| Item | Size | Estimate | Rationale |
|------|------|----------|-----------|
| Conversation Management ([#1311](https://github.com/strands-agents/harness-sdk/issues/1311)) | M | 3-5d | Performance optimization — providers already cap history internally |
| Steering ([#1458](https://github.com/strands-agents/harness-sdk/issues/1458)) | L | 5-8d | Depends on another experimental feature; architectural design needed |
| Consolidate Agent/BidiAgent ([#1479](https://github.com/strands-agents/harness-sdk/issues/1479)) | XL | 10+d | Breaking change — explicitly v2 |
| WebSocket IO ([#1727](https://github.com/strands-agents/harness-sdk/issues/1727)) | M | 4-5d | Additive IO adapter (if WebRTC ships as primary, WebSocket becomes post-GA) |
| VideoIO ([#1723](https://github.com/strands-agents/harness-sdk/issues/1723)) | M | 3-5d | Additive IO adapter |
| Multi-agent ([#1728](https://github.com/strands-agents/harness-sdk/issues/1728)) | L | 5-8d | Higher-level pattern — agent-as-tool works today |
| Pipecat/LiveKit ([#1725](https://github.com/strands-agents/harness-sdk/issues/1725)) | M | 4-5d | Third-party integration |
| Evaluations ([#1729](https://github.com/strands-agents/harness-sdk/issues/1729)) | L | 8-10d | Quality measurement, not stability prerequisite |
| Echo suppression ([#1737](https://github.com/strands-agents/harness-sdk/issues/1737)) | M | 3-5d | BidiAudioIO-specific — production uses WebRTC/headsets |
| Expert Tool enhancements | S-M | 2-4d | Nova Sonic-specific, already implemented |
| Session Segmentation | M | 4-5d | Nova Sonic-specific, builds on existing reconnection |
| 8-min timeout UX | S | 2-3d | Enhancement to existing working reconnection |

## Consequences

**What becomes easier:**
- Teams can adopt bidi in production without the "experimental" caveat or risk of unannounced breaking changes.
- The standard quality gates (mypy, ruff, coverage) catch regressions going forward.
- Browser-based voice applications work out of the box with a packaged IO adapter.
- Operators can instrument and monitor bidi sessions with standard OTEL tooling.

**What becomes harder or requires more care:**
- Breaking changes to the bidi API now require the full deprecation process (deprecation warning for one minor version before removal in a major).
- New features in bidi are held to production standards from day one (type-checked, tested, documented).

## Summary

| Category | Count | Estimate | Items |
|----------|-------|----------|-------|
| **GA blockers** | 10 | ~4 weeks (1-2 engineers + IVS team) | Build config, parallel invocations, Gemini fix, async tools, telemetry (in review), verbose output, remove `stop_conversation`, browser transport, documentation, validation sample |
| **Post-GA** | 12+ | — | Conversation management, steering, Agent consolidation, WebSocket IO, VideoIO, multi-agent, Pipecat/LiveKit, evaluations, echo suppression, Expert Tool, session segmentation, timeout UX |

