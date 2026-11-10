"""Run the real voice sidecar with generated microphone input and captured speaker output."""

import asyncio
import base64
import importlib.util
import json
import os
import wave
from pathlib import Path
from typing import Any

SIDECAR_PATH = Path(__file__).parents[2] / "src/agent/voice-sidecar.py"
spec = importlib.util.spec_from_file_location("voice_sidecar", SIDECAR_PATH)
assert spec is not None and spec.loader is not None
sidecar: Any = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)

DIRECTORY = Path(os.environ["STRANDS_TEST_VOICE_DIRECTORY"])


def record(event):
    with (DIRECTORY / "voice-events.jsonl").open("a") as output:
        output.write(json.dumps(event) + "\n")


class GeneratedAudioInput:
    def __init__(self):
        self.audio = b""
        self.offset = 0

    async def start(self, agent):
        config = agent.model.get_audio_config()["input"]
        if config != {"format": "pcm", "sample_rate": 16000, "channels": 1}:
            raise ValueError(f"Expected 16 kHz mono PCM input, got {config}")
        response = sidecar.boto3.client(
            "polly", region_name=os.environ.get("AWS_REGION", "us-east-1")
        ).synthesize_speech(
            Engine="neural",
            VoiceId="Matthew",
            OutputFormat="pcm",
            SampleRate="16000",
            Text="Read the word in the workspace file and tell me what it says.",
        )
        with response["AudioStream"] as stream:
            speech = stream.read()
        (DIRECTORY / "input.pcm").write_bytes(speech)
        self.audio = bytes(32000) + speech

    async def stop(self):
        record({"type": "fixture_input_stopped"})

    async def __call__(self):
        await asyncio.sleep(0.01)
        chunk = self.audio[self.offset : self.offset + 320].ljust(320, b"\0")
        self.offset += 320
        return sidecar.AudioDelta(format="pcm", source={"bytes": chunk})


class CapturedAudioOutput:
    def __init__(self):
        self.audio_bytes = 0
        self.output = None

    async def start(self, agent):
        config = agent.model.get_audio_config()["output"]
        self.output = wave.open(str(DIRECTORY / "output.wav"), "wb")
        self.output.setnchannels(config["channels"])
        self.output.setsampwidth(2)
        self.output.setframerate(config["sample_rate"])

    async def stop(self):
        if self.output is not None:
            self.output.close()
        record({"type": "fixture_output_stopped"})

    async def __call__(self, event):
        if isinstance(event, sidecar.BidiAudioDeltaEvent):
            audio = base64.b64decode(event.audio)
            assert self.output is not None
            self.output.writeframesraw(audio)
            self.audio_bytes += len(audio)


capture = CapturedAudioOutput()
original_emit = sidecar.emit


def observed_emit(event_type, **payload):
    original_emit(event_type, **payload)
    record({"type": event_type, **payload, "audio_bytes": capture.audio_bytes})


sidecar.emit = observed_emit
sidecar.AudioIO.input = lambda _audio: GeneratedAudioInput()
sidecar.AudioIO.output = lambda _audio: capture
sidecar.audio_devices = lambda: [{"index": 0, "input_channels": 1, "output_channels": 1}]

if __name__ == "__main__":
    record({"type": "fixture_started", "pid": os.getpid()})
    code = sidecar.main()
    record({"type": "fixture_exit", "code": code})
    raise SystemExit(code)
