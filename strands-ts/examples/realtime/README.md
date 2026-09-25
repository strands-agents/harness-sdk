# Experimental TypeScript Realtime model

This example opens an OpenAI Realtime WebSocket, sends a text question, executes a Strands tool, and receives the spoken response and transcript. It prints audio chunk sizes; it does not open a microphone or play audio.

From the repository root:

```bash
npm ci
npm run build
export OPENAI_API_KEY='your-key'
export OPENAI_REALTIME_MODEL='gpt-realtime'
npx tsx strands-ts/examples/realtime/openai.ts
```

Running the example makes a paid OpenAI API call. It stops after the final response, after 60 seconds, or on Ctrl+C. The deterministic provider tests require no credentials:

```bash
npm test -w strands-ts -- src/experimental/bidi
npm run test:browser -w strands-ts -- src/experimental/bidi
```

## Contract

Import `BidiModel` and event types from `@strands-agents/sdk/experimental/bidi`. Import the optional provider separately from `@strands-agents/sdk/experimental/bidi/models/openai`; importing the core contract does not import OpenAI. Install the `openai` peer dependency when using this provider.

`start({ systemPrompt, tools, messages, cancelSignal })` resolves after the provider acknowledges configuration and history has been sent locally. `send()` accepts Strands `TextBlock`, `ImageBlock`, `ToolResultBlock`, or an `AudioDelta`. `receive()` exposes one asynchronous event stream. Ending its iterator closes that connection. `stop()` releases local resources and initiates socket closure without waiting for a remote acknowledgement. Starting again creates a new conversation; no history or pending tool result is replayed automatically.

The provider uses mono, signed 16-bit little-endian PCM at 24 kHz in both directions. Use `getAudioConfig()` when configuring your audio source and sink. Send microphone chunks independently of the receive loop:

```typescript
await model.send({ type: 'audioDelta', format: 'pcm', source: { bytes: pcm16Bytes } })
```

Server VAD detects speech boundaries. Response creation is serialized locally and waits for pending tool results. A `toolUseStream` event contains complete parsed input and the original provider call ID. The caller validates inputs, authorizes and executes the tool, and sends a `ToolResultBlock` with that ID. All calls in a completed response are registered before any are exposed; continuation waits for every result. Cancelled or incomplete responses never dispatch tool calls. Tool execution itself is outside the model's cancellation and timeout guarantees. The example's direct `tool.invoke()` does not run Agent hooks or maintain Agent conversation history.

`bidiAudioStop` and `bidiResponseStop` indicate generation boundaries, not playback completion. On `bidiBargeIn`, stop and clear your playback queue immediately. The provider removes queued audio and suppresses late audio from the interrupted response. This initial API does not report played offsets or truncate provider conversation history to the audio actually heard; applications requiring that synchronization need a follow-up playback acknowledgement API before production use. Barge-in does not undo tool effects.

PNG/JPEG image bytes and text/tool conversation history are supported. Unsupported image sources and history content fail explicitly. Live audio chunks are not stored or replayed by this model.

## Bounds and failure behavior

- `startupTimeoutMs` defaults to 30,000 and covers authentication, socket opening, and configuration acknowledgement. A late credential resolution closes its resulting socket. An `AbortSignal` can cancel both startup and the live connection.
- `maxBufferedEvents` defaults to 256; `maxBufferedBytes` defaults to 1 MiB. Exceeding the receive queue or pending outbound transport bound fails the session with `ModelError`. These are application queue bounds, not limits on the WebSocket implementation's own inbound buffering.
- `send()` acknowledges local transport acceptance, not a provider acknowledgement. Cancellation, timeout, or disconnect cannot retract a message or tool effect already accepted remotely.
- Provider errors, failed/incomplete responses, transcription failures, and unexpected disconnects terminate the stream. Rate limiting and context overflow use the SDK's specialized model errors with the original error as cause.
- There is no automatic retry, reconnect, overall session-duration cap, or tool-execution deadline. Use an application-owned cancellation signal and tool timeouts. Configuration changes are allowed only between sessions.

For browser use, obtain a short-lived Realtime token from your server and supply an OpenAI client configured with that token and `dangerouslyAllowBrowser: true`. Never embed a long-lived API key in browser code. The provider uses the official OpenAI browser-compatible WebSocket implementation; device capture, resampling, playback, and WebRTC are separate concerns.

## Follow-up scope

This is the model transport layer, not the Python `BidiAgent` equivalent. The native TypeScript agent loop, tool lifecycle hooks, conversation/session persistence, device I/O, reconnect policy, Gemini Live, and Nova Sonic providers remain separate contributions under upstream issue [#3169](https://github.com/strands-agents/harness-sdk/issues/3169). AgentCore hosting and Amazon Connect adapters should consume that upstream API without introducing Connect-specific policies into the SDK.
