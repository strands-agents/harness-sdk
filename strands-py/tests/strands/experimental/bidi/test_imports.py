"""Import contract tests for the public bidirectional streaming API."""

import importlib
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

import strands.experimental.bidi

_OWNER_EXPORTS = {
    "agent": {"BidiAgent"},
    "hooks": {
        "BidiAfterConnectionRestartEvent",
        "BidiAgentStopEvent",
        "BidiBeforeConnectionRestartEvent",
        "BidiInterruptionEvent",
        "BidiResponseCompleteEvent",
    },
    "io": {
        "BidiAudioIO",
        "BidiAudioIOConfig",
        "BidiAudioProcessorConfig",
        "BidiTextIO",
    },
    "models": {
        "AudioCapable",
        "AudioConfig",
        "AudioStreamConfig",
        "BedrockNovaSonicAudioConfig",
        "BedrockNovaSonicAudioStreamConfig",
        "BidiConnectionConfig",
        "BidiModel",
        "BidiModelConfig",
        "BidiModelTimeoutError",
        "GoogleGeminiLiveAudioConfig",
        "GoogleGeminiLiveAudioStreamConfig",
        "Restartable",
    },
    "tools": {"stop_conversation"},
    "types": {
        "AudioChannel",
        "AudioFormat",
        "BidiAgentInput",
        "BidiAudioStreamEvent",
        "BidiConnectionCloseEvent",
        "BidiConnectionRestartEvent",
        "BidiConnectionStartEvent",
        "BidiConnectionWarningEvent",
        "BidiContentBlock",
        "BidiContentBlockData",
        "BidiErrorEvent",
        "BidiInput",
        "BidiInterruptionEvent",
        "BidiOutput",
        "BidiOutputEvent",
        "BidiResponseCompleteEvent",
        "BidiResponseStartEvent",
        "BidiTranscriptCompleteEvent",
        "BidiTranscriptStreamEvent",
        "BidiUsageEvent",
        "ModalityUsage",
        "Role",
        "StopReason",
    },
}

_LAZY_MODEL_EXPORTS = {
    "BedrockNovaSonicModel": "strands.experimental.bidi.models.bedrock",
    "GoogleGeminiLiveModel": "strands.experimental.bidi.models.google",
    "OpenAIRealtimeModel": "strands.experimental.bidi.models.openai",
}


def test_root_exports_only_owner_packages():
    tru_exports = set(strands.experimental.bidi.__all__)
    exp_exports = set(_OWNER_EXPORTS)
    assert tru_exports == exp_exports

    for exports in _OWNER_EXPORTS.values():
        for name in exports:
            assert not hasattr(strands.experimental.bidi, name)
    for name in _LAZY_MODEL_EXPORTS:
        assert not hasattr(strands.experimental.bidi, name)


@pytest.mark.parametrize(("owner", "exports"), _OWNER_EXPORTS.items())
def test_owner_package_declares_canonical_exports(owner, exports):
    module = importlib.import_module(f"strands.experimental.bidi.{owner}")

    tru_exports = set(module.__all__)
    exp_exports = exports
    assert tru_exports == exp_exports


@pytest.mark.parametrize(("name", "implementation_module"), _LAZY_MODEL_EXPORTS.items())
def test_model_provider_resolves_from_owner_package(monkeypatch, name, implementation_module):
    sentinel = object()
    module = ModuleType(implementation_module)
    setattr(module, name, sentinel)
    monkeypatch.setitem(sys.modules, implementation_module, module)

    models = importlib.import_module("strands.experimental.bidi.models")

    assert getattr(models, name) is sentinel


def test_root_does_not_reexport_public_symbols():
    assert not hasattr(strands.experimental.bidi, "BidiAgent")


def test_stable_namespace_is_not_available():
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("strands.bidi")


def test_owner_packages_do_not_eagerly_import_optional_dependencies():
    project_root = Path(__file__).resolve().parents[4]
    env = os.environ.copy()
    python_path = str(project_root / "src")
    if existing_python_path := env.get("PYTHONPATH"):
        python_path = os.pathsep.join((python_path, existing_python_path))
    env["PYTHONPATH"] = python_path

    code = """
import sys

import strands.experimental.bidi.io
import strands.experimental.bidi.models

optional_modules = (
    "aws_sdk_bedrock_runtime",
    "google.genai",
    "prompt_toolkit",
    "pyaudio",
    "rich",
    "websockets",
)
loaded = [name for name in optional_modules if name in sys.modules]
if loaded:
    raise AssertionError(f"optional dependencies imported eagerly: {loaded}")
"""
    subprocess.run([sys.executable, "-c", code], check=True, env=env)
