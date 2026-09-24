# WebRTC Transport for Strands Bidirectional Streaming

**Status**: Proposed

**Date**: 2026-07-21

## Overview

This document proposes adding WebRTC support to Strands bidirectional streaming through a new IO adapter layer. The design introduces a `SignalingProvider` protocol that abstracts WebRTC infrastructure providers (IVS, KVS, LiveKit, etc.) and a `BidiWebRtcIO` adapter that translates between WebRTC media/data and Strands bidi events. No changes are required to the core bidi architecture — BidiAgent, the agent loop, and BidiModel remain untouched.

---

## Problem Statement

Strands bidirectional streaming enables real-time audio/text/image interaction with AI models (Nova Sonic, Gemini Live, OpenAI Realtime) through a model-agnostic IO layer. Today, the only IO adapters are server-local: PyAudio for mic/speaker and prompt_toolkit for stdin/stdout.

There is no built-in way to connect a browser client to a bidi agent. Users wanting browser-based voice applications must build their own real-time media transport from scratch — NAT traversal, codec negotiation, echo cancellation, jitter buffering — before they can wire a microphone to a Strands agent. WebRTC solves this problem as a browser-native standard, but Strands has no WebRTC IO adapter.

---

## Use Cases

- Browser-based voice assistants
- Contact center and customer support agents
- Multi-modal web apps streaming audio and video to a bidi agent
- Mobile web applications
- Deployments behind NATs and corporate firewalls

---

## Current Strands Bidi Architecture

```
┌─────────────┐       ┌──────────────┐       ┌──────────────────┐       ┌──────────────┐
│  BidiInput  │─poll─▶│  BidiAgent   │─send─▶│  _BidiAgentLoop  │─send─▶│  BidiModel   │
└─────────────┘       └──────────────┘       └──────────────────┘       └──────────────┘
                             ▲                        │                         │
┌─────────────┐              │                   _event_queue                   │
│ BidiOutput  │◀──yield──────┘                        ▲                         │
└─────────────┘                            _run_model() consumes ◀──receive─────┘
```

**IO Protocols** — pull-based input, push-based output:

```python
class BidiInput(Protocol):
    async def start(self, agent: BidiAgent) -> None: ...
    async def stop(self) -> None: ...
    async def __call__(self) -> BidiInputEvent: ...

class BidiOutput(Protocol):
    async def start(self, agent: BidiAgent) -> None: ...
    async def stop(self) -> None: ...
    async def __call__(self, event: BidiOutputEvent) -> None: ...
```

IO adapters are interchangeable. The agent, loop, and model layers are unaware of what transport feeds them.

**Current developer experience** — local mic/speaker with PyAudio:

```python
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiAudioIO, BidiTextIO
from strands.experimental.bidi.models import BedrockNovaSonicModel

agent = BidiAgent(model=BedrockNovaSonicModel(), tools=[my_tool], system_prompt="You are a helpful assistant.")
audio_io = BidiAudioIO()
text_io = BidiTextIO()

# Mic audio in, speaker audio + transcript text out
await agent.run(
    inputs=[audio_io.input()],
    outputs=[audio_io.output(), text_io.output()],
)
```

---

## WebRTC as a Transport

### What It Is

WebRTC (Web Real-Time Communication) is a browser-native standard for peer-to-peer real-time media and data transport. It handles codec negotiation, NAT traversal, encryption, jitter buffering, echo cancellation, and adaptive bitrate — all built into the browser with no plugins required.

In the context of Strands bidi, WebRTC replaces the "last mile" between a browser client and the Python server running the bidi agent. Rather than streaming base64-encoded PCM over WebSockets (high latency, no built-in echo cancellation, no NAT traversal), the browser establishes a WebRTC peer connection to the server, which then bridges audio into the bidi agent's IO layer.

### What's Involved

There are three phases to establishing a WebRTC connection:

**1. Signaling (application-defined, not part of WebRTC)**

The application provides an out-of-band channel (typically HTTP or WebSocket) to exchange:
- **SDP (Session Description Protocol)** — Describes what media codecs each side supports and initial network information. One side creates an "offer," the other responds with an "answer."
- **ICE candidates** — Network address/port combinations discovered progressively ("trickle ICE").

This is analogous to Strands bidi's model `start()` phase — negotiating capabilities before data flows.

**2. Connection Establishment (ICE/STUN/TURN)**

Once signaling exchanges the offer, answer, and candidates, the WebRTC stack tries to establish a direct network path:
- **STUN server** — A lightweight public server that tells each peer its public IP and port (NAT hole-punching). Stateless, used only for discovery.
- **TURN server** — A relay fallback for when direct connection is impossible (symmetric NATs, corporate firewalls). All media routes through it.
- **ICE (Interactive Connectivity Establishment)** — The algorithm that tries multiple candidate pairs (host, server-reflexive, relay) and selects the best working path.

**3. Media and Data Transfer (steady state)**

Once connected, two transport mechanisms are available:

- **Media tracks** (RTP/RTCP) — Audio and video streams. The browser handles encoding (Opus for audio, VP8/H.264 for video), packetization, loss recovery, and adaptive bitrate automatically. Purpose-built for continuous, latency-critical, loss-tolerant data.
- **Data channels** (SCTP) — Arbitrary binary or text messages. Reliable and ordered (like TCP). For discrete messages that must arrive completely: text, events, images, tool calls.

### Provider WebRTC Landscape

| Provider | Native WebRTC? | Who is the WebRTC peer? |
|----------|---------------|------------------------|
| OpenAI | Yes | OpenAI itself (browser connects directly) |
| Nova Sonic | Yes (via AWS KVS) | Developer's server |
| Gemini | No | Third-party platform (LiveKit, Daily, etc.) |

### Amazon KVS WebRTC

Amazon Kinesis Video Streams (KVS) WebRTC is a fully managed AWS service that provides WebRTC signaling, STUN, and TURN infrastructure. Unlike IVS (which is purpose-built for interactive video), KVS WebRTC is a lower-level service focused on peer-to-peer connectivity for IoT devices, cameras, and custom media applications.

**Core concepts:**

- **Signaling channel** — A resource that enables peers to exchange SDP offers/answers and ICE candidates. Applications connect as either a "master" (one per channel) or "viewer" (up to 10 per channel).
- **Master** — The peer that initiates and accepts connections. In the Strands context, the server acts as the master.
- **Viewer** — A peer that connects to the master. Browser clients connect as viewers.

**How peers connect:** The master calls `ConnectAsMaster` on a signaling channel and waits. Viewers call `ConnectAsViewer` and exchange SDP/ICE with the master over the signaling channel's WebSocket. KVS provides STUN/TURN endpoints for NAT traversal. Once ICE completes, media flows directly between peers.

**SDKs:** JavaScript (web), C (embedded/IoT), Android, iOS.

### Amazon IVS Real-Time Streaming

Amazon Interactive Video Service (IVS) Real-Time Streaming is a fully managed AWS service that provides WebRTC infrastructure. It handles signaling, STUN, TURN, and peer connection management so developers don't operate their own WebRTC servers.

**Core concepts:**

- **Stage** — A virtual room that participants join. Each stage supports multiple concurrent peer connections with managed media routing.
- **Participant token** — A short-lived credential (created via `CreateParticipantToken` API) that authorizes a peer to join a stage with specified capabilities (publish, subscribe, or both).
- **Strategy** — Client-side declaration of what to publish and who to subscribe to. The IVS SDK handles connection state transitions automatically based on the strategy.

**How peers connect:** A participant (browser or server) obtains a token, joins the stage using the IVS SDK, and the service handles SDP/ICE negotiation between participants internally. Once connected, audio/video flows over WebRTC media tracks between participants in the stage.

**SDKs:** JavaScript (web), Android, iOS, and a server-side broadcast SDK. The web SDK uses standard `MediaStreamTrack` objects from `getUserMedia()`.

---

## Proposed Design

### Architecture

```
┌────────────────────┐            ┌───────────────────────────────────────┐
│  Browser Client    │            │  Strands Server                       │
│                    │  WebRTC    │                                       │
│  getUserMedia()    │◀═media════▶│  BidiWebRtcIO                        │
│  + IVS/KVS SDK    │  tracks    │    │  input()  → BidiInput            │
│  + data channel   │◀═data═════▶│    │  output() → BidiOutput           │
│                    │  channel   │    │                                  │
└────────────────────┘            │    ▼                                  │
                                  │  BidiAgent (any BidiModel)            │
                                  └───────────────────────────────────────┘
```

The Strands server is the user's Python application that hosts a `BidiAgent` — it acts as the WebRTC peer, receiving browser audio on the media track, resampling it, and feeding it into the agent. Model responses flow back out the media track; text/events flow over the data channel.

### Core Principle: Separation of Concerns

The three WebRTC phases described above (signaling, connection establishment, media/data transfer) split into two architectural concerns:

1. **Establishment (phases 1 + 2)** — Provider-specific. Signaling and ICE are handled differently by every service: IVS uses Stages and participant tokens, KVS uses signaling channels and master/viewer roles, LiveKit uses rooms and server-generated tokens. Each has different APIs, authentication, and SDP/ICE exchange mechanisms. This is the part that changes when you switch WebRTC infrastructure — the same way `BidiModel` implementations change when you switch between Nova Sonic, OpenAI, and Gemini.

2. **Steady-state (phase 3)** — Provider-agnostic. Once the peer connection is established, every WebRTC connection provides the same primitives: send/receive media frames on a track, send/receive messages on a data channel. The bytes flowing through the connection are identical regardless of which service negotiated it — the same way `BidiOutputEvent` is identical regardless of which model produced it.

`SignalingProvider` is to WebRTC infrastructure what `BidiModel` is to AI providers — a protocol that abstracts provider-specific details behind a uniform interface. `BidiWebRtcIO` consumes that interface and translates between WebRTC frames and bidi events (resampling audio, serializing events to JSON). It never changes, just as `BidiAgent` never changes when you swap models.

| Layer | Responsibility | Analogy |
|-------|---------------|---------|
| `SignalingProvider` | Negotiate + connect + expose media/data | Like `BidiModel` — one implementation per provider (IVS, KVS, LiveKit) |
| `BidiWebRtcIO` | Translate WebRTC ↔ BidiAgent events | Like `BidiAgent` — shared, provider-agnostic |

### SignalingProvider Protocol

Each instance represents one WebRTC peer connection to one remote client. The `kind` parameter on media methods defaults to `"audio"` and supports `"video"` as a future extension.

```python
from typing import Literal, Protocol, runtime_checkable

MediaKind = Literal["audio", "video"]

@runtime_checkable
class SignalingProvider(Protocol):
    """Full WebRTC lifecycle for a single peer connection."""

    async def start(self) -> None:
        """Negotiate SDP/ICE and establish the peer connection."""
        ...

    async def stop(self) -> None:
        """Close the peer connection and release resources."""
        ...

    async def receive_media(self, kind: MediaKind = "audio") -> bytes:
        """Receive next media frame from the remote peer. Blocks until available."""
        ...

    async def send_media(self, data: bytes, kind: MediaKind = "audio") -> None:
        """Send a media frame to the remote peer."""
        ...

    async def receive_data(self) -> str:
        """Receive next data channel message (JSON). Blocks until available."""
        ...

    async def send_data(self, message: str) -> None:
        """Send a data channel message to the remote peer."""
        ...
```

### BidiWebRtcIO

Follows the same `input()` / `output()` factory pattern as `BidiAudioIO` and `BidiTextIO`. Contains all shared logic — audio resampling, event routing, buffer management.

```python
class BidiWebRtcIO:
    """Bridges a SignalingProvider to BidiInput/BidiOutput.

    Consumes a SignalingProvider and translates between WebRTC
    media/data and BidiAgent events. Provider-agnostic — the same
    instance works regardless of which service negotiated the connection.
    """

    def __init__(self, signaling: SignalingProvider, **config) -> None:
        self._signaling = signaling
        self._config = config

    def input(self) -> BidiInput:
        """Returns a BidiInput that reads audio from the media track
        and text/image from the data channel."""
        ...

    def output(self) -> BidiOutput:
        """Returns a BidiOutput that sends audio to the media track
        and events to the data channel."""
        ...
```

**Input behavior:** Calls `signaling.receive_media()` to get audio frames, resamples to model format, produces `BidiAudioInputEvent`. Reads `signaling.receive_data()` for text/image input.

**Output behavior:** Routes events by type:
- `BidiAudioStreamEvent` → resample to WebRTC format + `signaling.send_media()`
- `BidiResponseInterruptEvent` → clear audio buffer + `signaling.send_data()`
- All other events (transcripts, tool calls, lifecycle) → `signaling.send_data()` as JSON

### IVS Integration

The IVS integration implements `SignalingProvider` using Amazon IVS Real-Time Streaming as the managed WebRTC infrastructure. The Strands server joins an IVS Stage as a server-side participant, establishing a WebRTC peer connection with browser clients that join the same stage.

#### IvsSignalingProvider

This implementation fulfills the `SignalingProvider` contract using IVS APIs and infrastructure:

```python
class IvsSignalingProvider(SignalingProvider):
    """IVS Real-Time Streaming implementation of SignalingProvider.

    Joins an IVS Stage as a server-side participant using aiortc for
    the local WebRTC peer connection. IVS manages signaling, STUN, and TURN.
    """

    def __init__(self, stage_arn: str, participant_token: str, region: str | None = None):
        ...
```

**What `start()` must do:**

1. Connect to the IVS Stage using the participant token (the token must have PUBLISH + SUBSCRIBE capabilities).
2. Wait for a remote participant (browser client) to join the stage.
3. Exchange SDP offer/answer through IVS signaling.
4. Complete ICE negotiation using IVS-provided STUN/TURN endpoints.
5. Establish the WebRTC peer connection with an audio media track and a data channel.
6. Return only after the peer connection is in `connected` state and media/data can flow.

**What `stop()` must do:**

1. Close the WebRTC peer connection.
2. Leave the IVS Stage.
3. Release all resources (signaling connection, media tracks, buffers).

**What `receive_media()` must do:**

1. Read the next audio frame from the remote participant's media track.
2. Decode from Opus (handled by aiortc).
3. Return raw PCM bytes to the caller.

**What `send_media()` must do:**

1. Accept raw PCM bytes from the caller.
2. Write to the local audio output track (aiortc handles Opus encoding and transmission).

**What `receive_data()` / `send_data()` must do:**

1. Read/write JSON string messages on the WebRTC data channel established during `start()`.

**Key implementation considerations:**

- The participant token is short-lived — the application layer is responsible for generating tokens via `CreateParticipantToken` before constructing the provider.
- IVS stages support multiple viewers, but this implementation handles exactly one peer connection (1:1 with the browser client). Multi-client scenarios use multiple `IvsSignalingProvider` instances.
- The server-side participant uses `aiortc` (Python WebRTC library) to manage the local peer connection, media tracks, and data channels. IVS provides the signaling transport and STUN/TURN infrastructure.

#### BidiIvsIO

A constructor shortcut that pre-wires `IvsSignalingProvider` into `BidiWebRtcIO` so users don't need to construct the signaling provider separately:

```python
class BidiIvsIO(BidiWebRtcIO):
    """IVS convenience wrapper — equivalent to BidiWebRtcIO(signaling=IvsSignalingProvider(...))."""

    def __init__(self, stage_arn: str, participant_token: str, region: str | None = None, **config):
        super().__init__(
            signaling=IvsSignalingProvider(stage_arn=stage_arn, participant_token=participant_token, region=region),
            **config,
        )
```

---

## Developer Experience

### Minimal — Server

```python
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiIvsIO
from strands.experimental.bidi.models import BedrockNovaSonicModel

# Configure model and IO independently
agent = BidiAgent(
    model=BedrockNovaSonicModel(),
    tools=[my_tool],
    system_prompt="You are a helpful assistant.",
)
ivs_io = BidiIvsIO(stage_arn="arn:aws:ivs:us-east-1:123:stage/abc", participant_token="eyJ...")

# Run — agent receives browser audio via WebRTC, responds via WebRTC
await agent.run(inputs=[ivs_io.input()], outputs=[ivs_io.output()])
```

### Swap Model — Same IO

```python
from strands.experimental.bidi.models import OpenAIRealtimeModel

# Same IVS IO works with any model — transport is decoupled from inference
agent = BidiAgent(model=OpenAIRealtimeModel(transcription_model_id="gpt-transcribe"), tools=[...])
await agent.run(inputs=[ivs_io.input()], outputs=[ivs_io.output()])
```

### Composable Outputs

```python
from strands.experimental.bidi.io import BidiTextIO

# Multiple outputs receive the same events — useful for logging or multi-channel delivery
text_io = BidiTextIO()
await agent.run(
    inputs=[ivs_io.input()],
    outputs=[ivs_io.output(), text_io.output()],
)
```

### Web App (FastAPI)

```python
import asyncio
from fastapi import FastAPI
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.io import BidiIvsIO

app = FastAPI()

@app.post("/session")
async def create_session():
    # Create an IVS Stage for this session
    stage = ivs_client.create_stage(Name="bidi-session")
    arn = stage["stage"]["arn"]

    # Generate tokens — one for the browser, one for the server
    browser_token = ivs_client.create_participant_token(StageArn=arn, Capabilities=["PUBLISH", "SUBSCRIBE"])
    server_token = ivs_client.create_participant_token(StageArn=arn, Capabilities=["PUBLISH", "SUBSCRIBE"])

    # Start the bidi agent in the background, connected via IVS
    ivs_io = BidiIvsIO(stage_arn=arn, participant_token=server_token["participantToken"]["token"])
    agent = BidiAgent(model=model, tools=[...])
    asyncio.create_task(agent.run(inputs=[ivs_io.input()], outputs=[ivs_io.output()]))

    # Return the browser token so the client can join the same stage
    return {"token": browser_token["participantToken"]["token"]}
```

### Browser Client (IVS Web SDK)

```javascript
import { Stage, LocalStageStream, SubscribeType } from 'amazon-ivs-web-broadcast';

// Fetch session token from the server
const { token } = await fetch('/session', { method: 'POST' }).then(r => r.json());

// Capture microphone audio
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const audioTrack = new LocalStageStream(stream.getAudioTracks()[0]);

// Define IVS strategy — publish mic audio, subscribe to agent audio
const stage = new Stage(token, {
    stageStreamsToPublish: () => [audioTrack],
    shouldPublishParticipant: () => true,
    shouldSubscribeToParticipant: () => SubscribeType.AUDIO_VIDEO,
});

// When the agent's audio track arrives, play it through an <audio> element
stage.on(StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED, (participant, streams) => {
    if (!participant.isLocal) {
        document.getElementById('agent-audio').srcObject = new MediaStream(
            streams.filter(s => s.streamType === 'audio').map(s => s.mediaStreamTrack)
        );
    }
});

await stage.join();
```

---

## Package Structure

```
strands/experimental/bidi/io/
├── audio.py              # Existing: PyAudio
├── text.py               # Existing: stdin/stdout
└── webrtc/
    ├── __init__.py       # Exports BidiWebRtcIO, SignalingProvider
    ├── _io.py            # BidiWebRtcIO
    ├── _signaling.py     # SignalingProvider protocol
    ├── _audio.py         # Resampling utilities
    └── ivs.py            # BidiIvsIO, IvsSignalingProvider
```

Future providers (KVS, LiveKit, Daily) = one new file each, implementing `SignalingProvider`.

---

## Dependencies

| Dependency | Purpose | Required? |
|-----------|---------|-----------|
| `aiortc` | Python WebRTC peer connection | For any WebRTC IO |
| `av` (PyAV) | Audio resampling | Transitive via aiortc |
| `numpy` | Audio buffer manipulation | Yes |
| `boto3` | IVS API calls | Only for IVS |

All lazy-loaded — importing strands bidi without WebRTC dependencies still works.

---

## Design Decisions

1. **Server-as-peer** — The only model-agnostic architecture. Works with all three providers unchanged.
2. **SignalingProvider is the only extension point** — Swap infrastructure without touching IO logic or agent code.
3. **Media track for audio, data channel for everything else** — Preserves WebRTC's optimized real-time pipeline for audio; reliable delivery for events.
4. **BidiInput/BidiOutput unchanged** — WebRTC is purely an IO-layer concern. No core bidi changes.
5. **1:1 signaling provider to client** — Multi-client = multiple agents. Application layer handles routing.
6. **Client-side code is out of scope** — The SDK provides the server adapter. Browser code uses IVS/KVS SDKs directly.

---

## Open Questions

1. **IVS server-side participation** — IVS documentation covers only the browser SDK. Server-side participation via aiortc + IVS signaling APIs needs validation.
2. **VAD** — Optional server-side voice activity detection before sending to model? Recommendation: disabled by default (rely on model VAD), configurable.
