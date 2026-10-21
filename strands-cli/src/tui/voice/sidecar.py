# /// script
# requires-python = ">=3.12,<3.15"
# dependencies = [
#   "strands-agents[bidi,bidi-aec,bidi-io,bidi-openai,bidi-pyaudio]==1.60.0",
# ]
# ///

"""Bidirectional audio sidecar for the Strands CLI voice runtime."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import os
import signal
import sys
import threading
import time
from array import array
from pathlib import Path
from typing import Any, Literal, cast

import boto3
import pyaudio  # pyright: ignore[reportMissingModuleSource]
from strands import tool
from strands.bidi import BidiAgent  # pyright: ignore[reportMissingImports]
from strands.bidi.io import AudioIO, AudioProcessorConfig, ConsoleIO  # pyright: ignore[reportMissingImports]
from strands.bidi.models import BedrockNovaSonicModel, OpenAIRealtimeModel  # pyright: ignore[reportMissingImports]
from strands.bidi.types import (  # pyright: ignore[reportMissingImports]
    AudioDelta,
    BidiAudioDeltaEvent,
    BidiBargeInEvent,
    BidiConnectionRestartEvent,
    BidiConnectionStartEvent,
    BidiConnectionStopEvent,
    BidiOutputEvent,
    BidiResponseStartEvent,
    BidiResponseStopEvent,
    BidiToolUseBlocksEvent,
    BidiTranscriptBlockEvent,
    BidiTranscriptDeltaEvent,
    InputStream,
    OutputStream,
)
from strands.types.tools import ToolResultBlock, ToolSpec  # pyright: ignore[reportAttributeAccessIssue]

DEFAULT_MODELS = {
    "bedrock": "amazon.nova-2-5-sonic",
    "openai": "gpt-realtime-2.1",
}
DEFAULT_VOICES = {
    "bedrock": "tiffany",
    "openai": "coral",
}
OPENAI_TRANSCRIPTION_MODEL = "gpt-transcribe"
DEFAULT_ENDPOINTING_SENSITIVITY = "LOW"
OPENAI_SILENCE_DURATION_MS = {
    "HIGH": 350,
    "MEDIUM": 500,
    "LOW": 800,
}
SYSTEM_PROMPT = """
You are Strands Voice, the user's persistent real-time conversational supervisor over the active
Strands harness coding agent.

At the beginning of every response, call route_voice_turn exactly once:
- conversation: casual conversation, a general question you can answer confidently, or a
  clarification that needs no workspace state, live information, tools, or external action.
- status: a question about what the harness agent is doing, what happened, or whether work finished.
- delegate: any request to inspect, change, run, search, research, create, fix, continue, or otherwise
  act through the harness agent.
- cancel: a clear request to stop the harness agent's current work.
- narration: only for an internal grounded harness update.

For delegation, preserve the user's complete request. The harness agent owns files, tools, approvals,
coding work, and detailed execution. Do not claim that work started, changed, finished, or failed
unless the routing result says so. After routing, respond naturally and briefly. Continue talking
with the user while harness work runs. If the user interrupts you, stop speaking and listen.
""".strip()
NARRATION_PROMPT = """
Route this internal request as narration, then give the user a concise, natural update. Preserve the
grounded facts, omit awkward markdown and code syntax, and do not invent progress.

<harness_update>
{text}
</harness_update>
""".strip()
INPUT_LEVEL_FLOOR_DB = -60.0
INPUT_LEVEL_INTERVAL_SECONDS = 0.08


def emit(event_type: str, **payload: Any) -> None:
    """Write one event to the Node parent process."""
    print(json.dumps({"type": event_type, **payload}, default=str, separators=(",", ":")), flush=True)


class SupervisorBridge:
    """Resolve BiDi routing tools through the Node conversation manager."""

    def __init__(self) -> None:
        self._next_request_id = 0
        self._pending: dict[str, asyncio.Future[Any]] = {}

    async def request(self, action: str, **payload: Any) -> Any:
        """Send one supervisor request and await its correlated result."""
        self._next_request_id += 1
        request_id = f"supervisor-{self._next_request_id}"
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        emit("supervisor_request", request_id=request_id, action=action, **payload)
        try:
            return await asyncio.wait_for(future, timeout=30)
        finally:
            self._pending.pop(request_id, None)

    def resolve(self, command: dict[str, Any]) -> None:
        """Resolve a pending request from a parent control message."""
        request_id = str(command.get("request_id", ""))
        future = self._pending.get(request_id)
        if future is None or future.done():
            return
        if command.get("ok") is True:
            future.set_result(command.get("result"))
        else:
            future.set_exception(RuntimeError(str(command.get("error", "The harness action failed."))))

    def cancel(self) -> None:
        """Cancel unresolved requests during shutdown."""
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        self._pending.clear()


_supervisor_bridge: SupervisorBridge | None = None


def supervisor_bridge() -> SupervisorBridge:
    """Return the bridge for the active sidecar session."""
    if _supervisor_bridge is None:
        raise RuntimeError("The voice supervisor is not connected.")
    return _supervisor_bridge


VoiceTurnIntent = Literal["conversation", "status", "delegate", "cancel", "narration"]


@tool
async def route_voice_turn(intent: VoiceTurnIntent, request: str) -> Any:
    """Route every voice turn before responding.

    Args:
        intent: Whether this turn is conversation, status, delegation, cancellation, or narration.
        request: The user's complete request or the supplied grounded harness update.
    """
    text = request.strip()
    if intent == "conversation":
        return {"mode": "conversation", "instruction": "Answer the user directly, naturally, and briefly."}
    if intent == "status":
        return await supervisor_bridge().request("get_current_work")
    if intent == "cancel":
        return await supervisor_bridge().request("cancel_current_work")
    if not text:
        raise ValueError("The routed request cannot be empty.")
    if intent == "delegate":
        return await supervisor_bridge().request("send_instruction", instruction=text)
    return {
        "mode": "narration",
        "instruction": "Summarize this grounded update naturally without adding facts.",
        "content": text,
    }


class RoutedNovaSonicModel(BedrockNovaSonicModel):
    """Require one routing tool call before each spoken response."""

    def _get_prompt_start_event(self, tools: list[ToolSpec]) -> str:
        event = json.loads(super()._get_prompt_start_event(tools))
        tool_configuration = event["event"]["promptStart"].get("toolConfiguration")
        if tool_configuration is not None:
            tool_configuration["toolChoice"] = {"tool": {"name": "route_voice_turn"}}
        return json.dumps(event, separators=(",", ":"))


class RoutedOpenAIRealtimeModel(OpenAIRealtimeModel):
    """Require routing for user turns and allow speech after the routing result."""

    def __init__(self, **kwargs: Any) -> None:
        self._route_result_pending = False
        super().__init__(**kwargs)

    async def _send_tool_result(self, tool_result: ToolResultBlock) -> None:
        # The SDK may defer response.create until the active response stops.
        self._route_result_pending = True
        await super()._send_tool_result(tool_result)

    async def _send_event(self, event: dict[str, Any]) -> None:
        routed_response = self._route_result_pending and event.get("type") == "response.create"
        if routed_response:
            event = {**event, "response": {**event.get("response", {}), "tool_choice": "none"}}
        await super()._send_event(event)
        if routed_response:
            self._route_result_pending = False


class MutableAudioInput:
    """Capture microphone audio while allowing mute and level reporting."""

    def __init__(self, input_stream: InputStream) -> None:
        self._input_stream = input_stream
        self._muted = False
        self._smoothed_level = 0.0
        self._last_level_emit = 0.0

    async def start(self, agent: BidiAgent) -> None:
        """Start microphone capture."""
        await self._input_stream.start(agent)

    async def stop(self) -> None:
        """Stop microphone capture."""
        await self._input_stream.stop()

    async def __call__(self) -> AudioDelta:
        """Return captured audio, replacing it with silence while muted."""
        event = await self._input_stream()
        if not isinstance(event, AudioDelta):
            raise TypeError(f"Expected audio input, received {type(event).__name__}.")
        audio = event.source.get("bytes")
        if not isinstance(audio, bytes):
            raise TypeError("Expected microphone audio bytes.")
        self._report_input_level(audio)
        if not self._muted:
            return event
        return AudioDelta(format=event.format, source={"bytes": bytes(len(audio))})

    def set_muted(self, muted: bool) -> None:
        """Enable or disable microphone audio."""
        self._muted = muted
        if muted:
            self._smoothed_level = 0.0
            self._emit_input_level(0.0, INPUT_LEVEL_FLOOR_DB)

    def _report_input_level(self, audio: bytes) -> None:
        if self._muted:
            return
        now = time.monotonic()
        if now - self._last_level_emit < INPUT_LEVEL_INTERVAL_SECONDS:
            return
        self._last_level_emit = now
        if len(audio) < 2:
            self._smoothed_level = 0.0
            self._emit_input_level(0.0, INPUT_LEVEL_FLOOR_DB)
            return

        samples = array("h")
        samples.frombytes(audio[: len(audio) - (len(audio) % 2)])
        if sys.byteorder != "little":
            samples.byteswap()

        rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples)) / 32768.0
        db = max(INPUT_LEVEL_FLOOR_DB, 20.0 * math.log10(max(rms, 1e-6)))
        level = (db - INPUT_LEVEL_FLOOR_DB) / -INPUT_LEVEL_FLOOR_DB
        smoothing = 0.45 if level > self._smoothed_level else 0.2
        self._smoothed_level += (level - self._smoothed_level) * smoothing
        smoothed_db = INPUT_LEVEL_FLOOR_DB + self._smoothed_level * -INPUT_LEVEL_FLOOR_DB
        self._emit_input_level(self._smoothed_level, smoothed_db)

    @staticmethod
    def _emit_input_level(level: float, db: float) -> None:
        emit("input_level", level=round(level, 3), db=round(db, 1))


class SidecarControl:
    """Read newline-delimited control messages from the Node parent process."""

    def __init__(self) -> None:
        self._commands: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopped = threading.Event()

    async def start(self) -> None:
        """Start reading control messages."""
        self._loop = asyncio.get_running_loop()
        threading.Thread(target=self._read_lines, name="voice-sidecar-control", daemon=True).start()

    async def stop(self) -> None:
        """Stop reading control messages."""
        self._stopped.set()
        self._loop = None

    async def next(self) -> dict[str, Any]:
        """Wait for the next control message."""
        return await self._commands.get()

    def _read_lines(self) -> None:
        while not self._stopped.is_set():
            line = sys.stdin.readline()
            if not line:
                self._enqueue({"type": "stop"})
                return
            try:
                command = json.loads(line)
            except json.JSONDecodeError as error:
                self._enqueue({"type": "control_error", "message": str(error)})
                continue
            if isinstance(command, dict):
                self._enqueue(command)

    def _enqueue(self, command: dict[str, Any]) -> None:
        loop = self._loop
        if loop is not None and not loop.is_closed():
            loop.call_soon_threadsafe(self._commands.put_nowait, command)


class JsonEventOutput:
    """Project the stable Bidi event stream onto the CLI sidecar protocol."""

    def __init__(self) -> None:
        self._transcripts: dict[str, str] = {}

    async def start(self, agent: BidiAgent) -> None:
        """Prepare event projection."""
        del agent

    async def stop(self) -> None:
        """Clear incomplete transcripts."""
        self._transcripts.clear()

    async def __call__(self, event: BidiOutputEvent) -> None:
        """Emit the subset of events consumed by the Node parent."""
        if isinstance(event, BidiConnectionStartEvent):
            emit("connection_start", connection_id=event.connection_id, model=event.model)
        elif isinstance(event, BidiConnectionRestartEvent):
            self._transcripts.clear()
            emit(
                "connection_restart",
                reason=event.reason,
                turn_interrupted=event.turn_interrupted,
                error=str(event.timeout_error) if event.timeout_error is not None else None,
            )
        elif isinstance(event, BidiTranscriptDeltaEvent):
            transcript = f"{self._transcripts.get(event.content_id, '')}{event.delta}"
            self._transcripts[event.content_id] = transcript
            emit(
                "transcript",
                role=event.role,
                current_transcript=transcript,
                is_final=False,
            )
        elif isinstance(event, BidiTranscriptBlockEvent):
            self._transcripts.pop(event.content_id, None)
            emit(
                "transcript",
                role=event.role,
                current_transcript=event.transcript,
                is_final=True,
            )
        elif isinstance(event, BidiConnectionStopEvent):
            self._transcripts.clear()
            emit("connection_stop", connection_id=event.connection_id, reason=event.reason)


class _SilentOutput:
    """Suppress the console output bundled with AudioIO."""

    async def start(self, agent: BidiAgent) -> None:
        del agent

    async def stop(self) -> None:
        return

    async def __call__(self, event: BidiOutputEvent) -> None:
        del event


class _SilentConsoleIO:
    """Provide AudioIO with a console that never writes to the terminal."""

    def output(self) -> OutputStream:
        """Return a no-op output stream."""
        return _SilentOutput()


class ControlledAudioOutput:
    """Play conversational and narrated replies while spoken output is enabled."""

    def __init__(self, output_stream: OutputStream) -> None:
        self._output_stream = output_stream
        self._response_id: str | None = None
        self._play_current = False
        self._audio_started = False
        self._tool_response = False
        self._enabled = False
        self._interrupted_response_id: str | None = None
        self._idle = asyncio.Event()
        self._idle.set()

    async def start(self, agent: BidiAgent) -> None:
        """Start speaker output."""
        await self._output_stream.start(agent)

    async def stop(self) -> None:
        """Stop speaker output."""
        await self._output_stream.stop()
        self._interrupted_response_id = None
        self._finish_response()

    async def __call__(self, event: BidiOutputEvent) -> None:
        """Route response audio according to the current playback request."""
        if isinstance(event, BidiResponseStartEvent):
            self._response_id = event.response_id
            self._idle.clear()
            self._play_current = self._enabled
            self._audio_started = False
            self._tool_response = False
        elif isinstance(event, BidiToolUseBlocksEvent):
            self._tool_response = True
        elif isinstance(event, BidiAudioDeltaEvent):
            if not self._play_current:
                return
            if not self._audio_started:
                self._audio_started = True
                emit("speech_output_start")
            await self._output_stream(event)
        elif isinstance(event, BidiBargeInEvent):
            await self._output_stream(event)
            if self._response_id is None:
                self._idle.clear()
                return
            if self._audio_started:
                emit("speech_output_interrupted")
            self._interrupted_response_id = self._response_id
            self._finish_response(idle=False)
        elif isinstance(event, BidiResponseStopEvent):
            if event.response_id == self._interrupted_response_id:
                self._interrupted_response_id = None
                self._idle.set()
                return
            if self._tool_response and not self._audio_started:
                self._finish_response(idle=False)
                return
            if self._audio_started:
                emit("speech_output_complete", response_id=event.response_id)
            self._finish_response()
        elif isinstance(event, (BidiConnectionRestartEvent, BidiConnectionStopEvent)):
            await self.stop_speaking()

    async def wait_until_idle(self) -> None:
        """Wait until the model finishes its current response."""
        await self._idle.wait()

    def mark_response_pending(self) -> None:
        """Reserve playback before a programmatic response is submitted."""
        self._finish_response(idle=False)

    def set_enabled(self, enabled: bool) -> None:
        """Enable or suppress speaker output for subsequent responses."""
        self._enabled = enabled

    async def stop_speaking(self) -> None:
        """Clear current and pending spoken output."""
        was_speaking = self._audio_started
        await self._output_stream(BidiBargeInEvent())
        self._interrupted_response_id = None
        self._finish_response()
        if was_speaking:
            emit("speech_output_stopped")

    def _finish_response(self, *, idle: bool = True) -> None:
        self._response_id = None
        self._play_current = False
        self._audio_started = False
        self._tool_response = False
        if idle:
            self._idle.set()
        else:
            self._idle.clear()


def parse_args() -> argparse.Namespace:
    """Parse sidecar configuration."""
    parser = argparse.ArgumentParser(description="Run the Strands CLI bidirectional voice supervisor.")
    parser.add_argument("--provider", choices=["bedrock", "openai"], default="bedrock")
    parser.add_argument("--model")
    parser.add_argument("--region", help="AWS region; defaults to the active AWS configuration.")
    parser.add_argument("--voice")
    parser.add_argument(
        "--endpointing-sensitivity",
        choices=["HIGH", "MEDIUM", "LOW"],
        default=DEFAULT_ENDPOINTING_SENSITIVITY,
    )
    parser.add_argument("--input-device", type=int)
    parser.add_argument("--output-device", type=int)
    parser.add_argument("--spoken-replies", action="store_true")
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument(
        "--check", action="store_true", help="Validate credentials and audio devices without connecting."
    )
    return parser.parse_args()


def audio_devices() -> list[dict[str, Any]]:
    """List local audio devices."""
    audio = pyaudio.PyAudio()
    try:
        devices = []
        for index in range(audio.get_device_count()):
            info = audio.get_device_info_by_index(index)
            devices.append(
                {
                    "index": index,
                    "name": info.get("name"),
                    "input_channels": int(info.get("maxInputChannels", 0)),
                    "output_channels": int(info.get("maxOutputChannels", 0)),
                    "default_sample_rate": int(info.get("defaultSampleRate", 0)),
                }
            )
        return devices
    finally:
        audio.terminate()


def preflight(args: argparse.Namespace) -> tuple[str | None, list[dict[str, Any]]]:
    """Validate credentials, region, and local audio devices."""
    args.model = args.model or DEFAULT_MODELS[args.provider]
    args.voice = args.voice or DEFAULT_VOICES[args.provider]
    region: str | None = None
    if args.provider == "bedrock":
        session = boto3.Session()
        if session.get_credentials() is None:
            raise RuntimeError("AWS credentials were not found. Configure Bedrock with /setup, then try again.")
        region = (
            args.region
            or session.region_name
            or os.getenv("AWS_REGION")
            or os.getenv("AWS_DEFAULT_REGION")
            or "us-east-1"
        )
    elif not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not configured. Add OpenAI credentials with /setup, then try again.")

    devices = audio_devices()
    if not any(device["input_channels"] > 0 for device in devices):
        raise RuntimeError("No microphone input device was found.")
    if not any(device["output_channels"] > 0 for device in devices):
        raise RuntimeError("No speaker output device was found.")

    emit(
        "preflight",
        ok=True,
        provider=args.provider,
        model=args.model,
        region=region,
        cwd=str(Path.cwd()),
        input_device=args.input_device,
        output_device=args.output_device,
        device_count=len(devices),
    )
    return region, devices


async def run_voice(args: argparse.Namespace, region: str | None) -> None:
    """Run the sidecar until the parent, signal, or model ends the session."""
    global _supervisor_bridge
    bridge = SupervisorBridge()
    _supervisor_bridge = bridge
    if args.provider == "bedrock":
        model = RoutedNovaSonicModel(
            model_id=args.model,
            region=region,
            voice=args.voice,
            params={
                "turnDetectionConfiguration": {
                    "endpointingSensitivity": args.endpointing_sensitivity,
                }
            },
        )
    else:
        model = RoutedOpenAIRealtimeModel(
            model_id=args.model,
            transcription_model_id=OPENAI_TRANSCRIPTION_MODEL,
            voice=args.voice,
            params={
                "tool_choice": {"type": "function", "name": "route_voice_turn"},
                "audio": {
                    "input": {
                        "turn_detection": {
                            "silence_duration_ms": OPENAI_SILENCE_DURATION_MS[args.endpointing_sensitivity],
                        }
                    }
                }
            },
        )
    audio = AudioIO(
        audio_processor=AudioProcessorConfig(),
        console=cast(ConsoleIO, _SilentConsoleIO()),
        input_device_index=args.input_device,
        output_device_index=args.output_device,
    )
    agent = BidiAgent(
        model=model,
        tools=[route_voice_turn],
        system_prompt=SYSTEM_PROMPT,
        name="Strands Voice",
    )
    audio_input = MutableAudioInput(audio.input())
    audio_output = ControlledAudioOutput(audio.output())
    audio_output.set_enabled(args.spoken_replies)
    event_output = JsonEventOutput()
    control = SidecarControl()
    narrations: asyncio.Queue[str] = asyncio.Queue()
    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()
    registered_signals: list[signal.Signals] = []

    for signal_number in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signal_number, stop_requested.set)
            registered_signals.append(signal_number)
        except NotImplementedError:
            pass

    async def run_controls() -> None:
        while True:
            command = await control.next()
            command_type = command.get("type")
            if command_type == "set_muted":
                muted = command.get("muted") is True
                audio_input.set_muted(muted)
                emit("mute_changed", muted=muted)
            elif command_type == "set_spoken_replies":
                enabled = command.get("enabled") is True
                audio_output.set_enabled(enabled)
                if not enabled:
                    await audio_output.stop_speaking()
            elif command_type == "narrate":
                text = str(command.get("text", "")).strip()
                if not text:
                    emit("control_error", message="The narration command requires non-empty text.")
                    continue
                await narrations.put(text)
            elif command_type == "supervisor_result":
                bridge.resolve(command)
            elif command_type == "stop_speaking":
                await audio_output.stop_speaking()
            elif command_type == "stop":
                return
            elif command_type == "control_error":
                emit("control_error", message=command.get("message"))
            else:
                emit("control_error", message=f"Unknown control message: {command_type}")

    async def run_narrations() -> None:
        while True:
            text = await narrations.get()
            await audio_output.wait_until_idle()
            audio_output.mark_response_pending()
            try:
                await agent.send(NARRATION_PROMPT.format(text=text))
            except BaseException:
                await audio_output.stop_speaking()
                raise

    tasks: list[asyncio.Task[Any]] = []
    await control.start()
    try:
        tasks = [
            asyncio.create_task(agent.run(inputs=[audio_input], outputs=[audio_output, event_output])),
            asyncio.create_task(run_controls()),
            asyncio.create_task(run_narrations()),
            asyncio.create_task(stop_requested.wait()),
        ]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if task is tasks[3] or task.cancelled():
                continue
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        bridge.cancel()
        _supervisor_bridge = None
        await control.stop()
        for signal_number in registered_signals:
            loop.remove_signal_handler(signal_number)


def main() -> int:
    """Run the voice sidecar."""
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    args = parse_args()

    try:
        region, devices = preflight(args)
        if args.list_devices:
            for device in devices:
                emit("audio_device", **device)
        if args.check or args.list_devices:
            return 0
        asyncio.run(run_voice(args, region))
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        emit("fatal_error", code=type(error).__name__, message=str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
