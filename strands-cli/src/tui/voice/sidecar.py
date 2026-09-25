# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = [
#   "strands-agents[bidi,bidi-aec,bidi-pyaudio] @ git+https://github.com/strands-agents/harness-sdk.git@647128383ea9ba4598d3cf47e376642091d339d9#subdirectory=strands-py",
# ]
# ///

"""Nova Sonic audio sidecar for the Strands CLI voice runtime."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import math
import os
import signal
import sys
import time
from array import array
from pathlib import Path
from typing import Any

import boto3
import pyaudio  # pyright: ignore[reportMissingModuleSource]
from strands import tool
from strands.experimental.bidi import (
    AudioProcessorConfig,
    BidiAgent,
    BidiAudioInputEvent,
    BidiAudioIO,
    BidiAudioStreamEvent,
    BidiConnectionCloseEvent,
    BidiConnectionRestartEvent,
    BidiConnectionStartEvent,
    BidiErrorEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
    BidiResponseStartEvent,
    BidiTextInputEvent,
    BidiTranscriptStreamEvent,
    BidiUsageEvent,
)
from strands.experimental.bidi.models import BidiNovaSonicModel
from strands.experimental.bidi.types.events import BidiOutputEvent
from strands.experimental.bidi.types.io import BidiInput, BidiOutput
from strands.experimental.hooks.events import BidiAfterToolCallEvent, BidiBeforeToolCallEvent
from strands.hooks import HookProvider

DEFAULT_MODEL = "amazon.nova-2-sonic-v1:0"
DEFAULT_ENDPOINTING_SENSITIVITY = "LOW"
DEFAULT_SYSTEM_PROMPT = """
You are Strands harness, a concise coding assistant in a live voice conversation.
Keep spoken answers short unless the user asks for detail.
Use current_working_directory whenever the user asks where you are working.
The user may speak over you or send typed text during the conversation.
""".strip()
SIDECAR_SYSTEM_PROMPT = """
You are a speech transcription transport for a separate coding agent.
Listen carefully to the user and keep each response to one short acknowledgement.
Do not answer questions, use tools, or attempt coding work.
""".strip()
SPEAK_PROMPT = """
Read the coding assistant response below aloud naturally.
Preserve its meaning and do not add commentary.
Skip markdown punctuation, URLs, and code syntax that would be awkward to speak.

<coding_assistant_response>
{text}
</coding_assistant_response>
""".strip()
INPUT_LEVEL_FLOOR_DB = -60.0
INPUT_LEVEL_INTERVAL_SECONDS = 0.08


def emit(event_type: str, **payload: Any) -> None:
    print(json.dumps({"type": event_type, **payload}, default=str, separators=(",", ":")), flush=True)


@tool
def current_working_directory() -> str:
    """Return the absolute working directory for this voice session."""
    return str(Path.cwd())


class TypedTextInput(BidiInput):
    """Read optional text input while microphone streaming remains active."""

    def __init__(self) -> None:
        self._lines: asyncio.Queue[str] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._file_descriptor = sys.stdin.fileno()

    async def start(self, agent: BidiAgent) -> None:
        del agent
        self._loop = asyncio.get_running_loop()
        self._loop.add_reader(self._file_descriptor, self._read_line)
        print("text> ", end="", file=sys.stderr, flush=True)

    async def stop(self) -> None:
        if self._loop is not None:
            self._loop.remove_reader(self._file_descriptor)
            self._loop = None

    async def __call__(self) -> BidiTextInputEvent:
        text = (await self._lines.get()).strip()
        if not text:
            return await self()
        print("text> ", end="", file=sys.stderr, flush=True)
        return BidiTextInputEvent(text=text)

    def _read_line(self) -> None:
        line = sys.stdin.readline()
        if line:
            self._lines.put_nowait(line)


class MutableAudioInput(BidiInput):
    """Replace captured audio with silence while the sidecar is muted."""

    def __init__(self, input_: BidiInput, report_levels: bool) -> None:
        self._input = input_
        self._muted = False
        self._report_levels = report_levels
        self._smoothed_level = 0.0
        self._last_level_emit = 0.0

    async def start(self, agent: BidiAgent) -> None:
        await self._input.start(agent)

    async def stop(self) -> None:
        await self._input.stop()

    async def __call__(self) -> BidiAudioInputEvent:
        event = await self._input()
        if not isinstance(event, BidiAudioInputEvent):
            raise TypeError(f"Expected audio input, received {type(event).__name__}.")
        audio = base64.b64decode(event.audio)
        self._report_input_level(audio)
        if not self._muted:
            return event
        return BidiAudioInputEvent(
            audio=base64.b64encode(bytes(len(audio))).decode("utf-8"),
            format=event.format,
            sample_rate=event.sample_rate,
            channels=event.channels,
        )

    def set_muted(self, muted: bool) -> None:
        self._muted = muted
        if muted:
            self._smoothed_level = 0.0
            self._emit_input_level(0.0, INPUT_LEVEL_FLOOR_DB)

    def _report_input_level(self, audio: bytes) -> None:
        if not self._report_levels or self._muted:
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

    def _emit_input_level(self, level: float, db: float) -> None:
        if self._report_levels:
            emit("input_level", level=round(level, 3), db=round(db, 1))


class SidecarControl:
    """Read newline-delimited control messages from the Node parent process."""

    def __init__(self) -> None:
        self._commands: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._file_descriptor = sys.stdin.fileno()

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._loop.add_reader(self._file_descriptor, self._read_line)

    async def stop(self) -> None:
        if self._loop is not None:
            self._loop.remove_reader(self._file_descriptor)
            self._loop = None

    async def next(self) -> dict[str, Any]:
        return await self._commands.get()

    def _read_line(self) -> None:
        line = sys.stdin.readline()
        if not line:
            self._commands.put_nowait({"type": "stop", "reason": "stdin_closed"})
            return
        try:
            command = json.loads(line)
        except json.JSONDecodeError as error:
            emit("control_error", message=str(error))
            return
        if isinstance(command, dict):
            self._commands.put_nowait(command)


class JsonEventOutput(BidiOutput):
    """Project useful Bidi events to JSON without dumping audio payloads."""

    def __init__(self) -> None:
        self._audio_started = False
        self._last_usage_total = -100

    async def __call__(self, event: BidiOutputEvent) -> None:
        if isinstance(event, BidiConnectionStartEvent):
            emit("connection_start", connection_id=event.connection_id, model=event.model)
        elif isinstance(event, BidiConnectionRestartEvent):
            emit("connection_restart", error=str(event.timeout_error))
        elif isinstance(event, BidiResponseStartEvent):
            self._audio_started = False
            emit("response_start", response_id=event.response_id)
        elif isinstance(event, BidiAudioStreamEvent):
            if not self._audio_started:
                self._audio_started = True
                emit(
                    "audio_output_start",
                    format=event.format,
                    sample_rate=event.sample_rate,
                    channels=event.channels,
                )
        elif isinstance(event, BidiTranscriptStreamEvent):
            emit(
                "transcript",
                role=event.role,
                text=event.text,
                is_final=event.is_final,
                current_transcript=event.current_transcript,
            )
        elif isinstance(event, BidiInterruptionEvent):
            self._audio_started = False
            emit("interruption", reason=event.reason)
        elif isinstance(event, BidiResponseCompleteEvent):
            self._audio_started = False
            emit("response_complete", response_id=event.response_id, stop_reason=event.stop_reason)
        elif isinstance(event, BidiUsageEvent):
            if event.total_tokens - self._last_usage_total >= 100:
                self._last_usage_total = event.total_tokens
                emit(
                    "usage",
                    input_tokens=event.input_tokens,
                    output_tokens=event.output_tokens,
                    total_tokens=event.total_tokens,
                )
        elif isinstance(event, BidiConnectionCloseEvent):
            emit("connection_close", connection_id=event.connection_id, reason=event.reason)
        elif isinstance(event, BidiErrorEvent):
            emit("error", code=event.code, message=event.message, details=event.details)


class ControlledAudioOutput(BidiOutput):
    """Play only responses explicitly requested by the Node parent process."""

    def __init__(self, output: BidiOutput) -> None:
        self._output = output
        self._response_id: str | None = None
        self._play_current = False
        self._audio_started = False
        self._armed = False
        self._idle = asyncio.Event()
        self._idle.set()

    async def start(self, agent: BidiAgent) -> None:
        await self._output.start(agent)

    async def stop(self) -> None:
        await self._output.stop()

    async def __call__(self, event: BidiOutputEvent) -> None:
        if isinstance(event, BidiResponseStartEvent):
            if not self._idle.is_set() and event.response_id == self._response_id:
                return
            self._response_id = event.response_id
            self._idle.clear()
            self._play_current = self._armed
            self._armed = False
            self._audio_started = False
            return
        if isinstance(event, BidiAudioStreamEvent):
            if not self._play_current:
                return
            if not self._audio_started:
                self._audio_started = True
                emit("speech_output_start")
            await self._output(event)
            return
        if isinstance(event, BidiTranscriptStreamEvent):
            if event.role == "assistant" and event.is_final and not self._idle.is_set():
                if self._play_current:
                    emit("speech_output_complete", response_id=self._response_id)
                self._finish_response()
            return
        if isinstance(event, BidiInterruptionEvent):
            await self._output(event)
            if self._play_current:
                emit("speech_output_interrupted", reason=event.reason)
            self._finish_response()
            return
        if isinstance(event, BidiResponseCompleteEvent):
            if self._play_current:
                emit("speech_output_complete", response_id=event.response_id)
            self._finish_response()

    async def wait_until_idle(self) -> None:
        await self._idle.wait()

    def arm_next_response(self) -> None:
        self._armed = True

    async def stop_speaking(self) -> None:
        was_speaking = self._play_current or self._armed
        await self._output(BidiInterruptionEvent(reason="user_speech"))
        self._play_current = False
        self._audio_started = False
        self._armed = False
        if was_speaking:
            emit("speech_output_stopped")

    def _finish_response(self) -> None:
        self._response_id = None
        self._play_current = False
        self._audio_started = False
        self._armed = False
        self._idle.set()


class ToolEventHooks(HookProvider):
    """Emit definitive tool lifecycle events from hooks."""

    def register_hooks(self, registry: Any, **_: Any) -> None:
        registry.add_callback(BidiBeforeToolCallEvent, self._before_tool)
        registry.add_callback(BidiAfterToolCallEvent, self._after_tool)

    def _before_tool(self, event: BidiBeforeToolCallEvent) -> None:
        emit(
            "tool_start",
            tool_use_id=event.tool_use.get("toolUseId"),
            name=event.tool_use.get("name"),
            input=event.tool_use.get("input", {}),
        )

    def _after_tool(self, event: BidiAfterToolCallEvent) -> None:
        emit(
            "tool_finish",
            tool_use_id=event.tool_use.get("toolUseId"),
            name=event.tool_use.get("name"),
            result=event.result,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Exercise Strands Bidi with Nova Sonic and local audio.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--region", help="AWS region; defaults to the active AWS configuration.")
    parser.add_argument("--voice", default="tiffany")
    parser.add_argument(
        "--endpointing-sensitivity",
        choices=["HIGH", "MEDIUM", "LOW"],
        default=DEFAULT_ENDPOINTING_SENSITIVITY,
    )
    parser.add_argument("--input-device", type=int)
    parser.add_argument("--output-device", type=int)
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--sidecar", action="store_true", help="Run as the Strands CLI transcription sidecar.")
    parser.add_argument(
        "--check", action="store_true", help="Validate credentials and audio devices without connecting."
    )
    return parser.parse_args()


def audio_devices() -> list[dict[str, Any]]:
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


def preflight(args: argparse.Namespace) -> tuple[str, list[dict[str, Any]]]:
    credentials = boto3.Session().get_credentials()
    if credentials is None:
        raise RuntimeError("AWS credentials were not found.")

    region: str = (
        args.region
        or boto3.Session().region_name
        or os.getenv("AWS_REGION")
        or os.getenv("AWS_DEFAULT_REGION")
        or "us-east-1"
    )
    devices = audio_devices()
    if not any(device["input_channels"] > 0 for device in devices):
        raise RuntimeError("No microphone input device was found.")
    if not args.sidecar and not any(device["output_channels"] > 0 for device in devices):
        raise RuntimeError("No speaker output device was found.")

    emit(
        "preflight",
        ok=True,
        model=args.model,
        region=region,
        cwd=str(Path.cwd()),
        input_device=args.input_device,
        output_device=args.output_device,
        device_count=len(devices),
    )
    return region, devices


async def run_voice(args: argparse.Namespace, region: str) -> None:
    model = BidiNovaSonicModel(
        model_id=args.model,
        provider_config={
            "audio": {"voice": args.voice},
            "turn_detection": {"endpointingSensitivity": args.endpointing_sensitivity},
        },
        client_config={"region": region},
    )
    audio = BidiAudioIO(
        processor=AudioProcessorConfig(),
        input_device_index=args.input_device,
        output_device_index=args.output_device,
    )
    agent = BidiAgent(
        model=model,
        tools=[] if args.sidecar else [current_working_directory],
        system_prompt=SIDECAR_SYSTEM_PROMPT if args.sidecar else DEFAULT_SYSTEM_PROMPT,
        hooks=[] if args.sidecar else [ToolEventHooks()],
        name="Strands Voice",
    )
    audio_input = MutableAudioInput(audio.input(), report_levels=args.sidecar)
    text_input = TypedTextInput()
    audio_output = audio.output()
    controlled_audio_output = ControlledAudioOutput(audio_output)
    json_output = JsonEventOutput()
    sidecar_control = SidecarControl() if args.sidecar else None
    inputs = [audio_input] if args.sidecar else [audio_input, text_input]
    outputs = [controlled_audio_output if args.sidecar else audio_output, json_output]
    stop_requested = asyncio.Event()
    loop = asyncio.get_running_loop()

    def request_stop(reason: str) -> None:
        if stop_requested.is_set():
            return
        emit("session_stop_requested", reason=reason)
        stop_requested.set()

    for signal_number in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signal_number, request_stop, signal.Signals(signal_number).name.lower())

    async def run_input(input_: BidiInput) -> None:
        while True:
            await agent.send(await input_())

    async def run_output() -> None:
        async for event in agent.receive():
            await asyncio.gather(*(output(event) for output in outputs))
        request_stop("connection_closed")

    async def run_controls() -> None:
        assert sidecar_control is not None
        while True:
            command = await sidecar_control.next()
            command_type = command.get("type")
            if command_type == "set_muted":
                muted = bool(command.get("muted"))
                audio_input.set_muted(muted)
                emit("mute_changed", muted=muted)
            elif command_type == "speak":
                text = str(command.get("text", "")).strip()
                if not text:
                    emit("control_error", message="The speak command requires non-empty text.")
                    continue
                await controlled_audio_output.wait_until_idle()
                controlled_audio_output.arm_next_response()
                await agent.send(BidiTextInputEvent(text=SPEAK_PROMPT.format(text=text)))
                emit("speech_output_queued")
            elif command_type == "stop_speaking":
                await controlled_audio_output.stop_speaking()
            elif command_type == "stop":
                request_stop(str(command.get("reason", "parent_request")))
                return
            else:
                emit("control_error", message=f"Unknown control message: {command_type}")

    emit(
        "session_start",
        model=args.model,
        region=region,
        voice=args.voice,
        endpointing_sensitivity=args.endpointing_sensitivity,
    )
    if not args.sidecar:
        print(
            "Voice session starting. Speak normally, type at the text> prompt, interrupt while the assistant speaks, "
            "and press Ctrl+C to stop.",
            file=sys.stderr,
            flush=True,
        )
    workers: list[asyncio.Task[None]] = []
    stop_waiter: asyncio.Task[bool] | None = None
    started = False
    try:
        await agent.start()
        started = True
        for channel in [*inputs, *outputs]:
            await channel.start(agent)
        if sidecar_control is not None:
            await sidecar_control.start()

        workers = [
            *(asyncio.create_task(run_input(input_)) for input_ in inputs),
            asyncio.create_task(run_output()),
            *([asyncio.create_task(run_controls())] if sidecar_control is not None else []),
        ]
        stop_waiter = asyncio.create_task(stop_requested.wait())
        done, _ = await asyncio.wait([stop_waiter, *workers], return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if task is stop_waiter or task.cancelled():
                continue
            task.result()
    finally:
        if stop_waiter is not None:
            stop_waiter.cancel()
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        if stop_waiter is not None:
            await asyncio.gather(stop_waiter, return_exceptions=True)
        for channel in [*inputs, *outputs, *([sidecar_control] if sidecar_control is not None else [])]:
            try:
                await channel.stop()
            except Exception as error:
                emit("cleanup_error", component=type(channel).__name__, message=str(error))
        if started:
            # The experimental Nova client can hang while writing protocol end events after cancellation.
            # Clearing the connection ID skips those writes; BidiAgent.stop still closes the stream and loop.
            if hasattr(agent.model, "_connection_id"):
                agent.model._connection_id = None  # pyright: ignore[reportAttributeAccessIssue]
            try:
                await asyncio.wait_for(agent.stop(), timeout=10)
            except TimeoutError:
                emit("cleanup_error", component="BidiAgent", message="Timed out while stopping the agent loop.")
            except Exception as error:
                emit("cleanup_error", component="BidiAgent", message=str(error))
        emit("session_stopped")


def main() -> int:
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
        emit("session_stop", reason="keyboard_interrupt")
        return 0
    except Exception as error:
        emit("fatal_error", code=type(error).__name__, message=str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
