import sys
from types import ModuleType

import pytest
from prompt_toolkit.application import create_app_session
from prompt_toolkit.input import create_pipe_input
from prompt_toolkit.output import DummyOutput

# The standard test environment does not install the native PyAudio dependency.
pyaudio = ModuleType("pyaudio")
pyaudio.PyAudio = object
pyaudio.Stream = object
sys.modules.setdefault("pyaudio", pyaudio)


@pytest.fixture(autouse=True)
def terminal(monkeypatch):
    """Give each test an isolated terminal input."""
    monkeypatch.setenv("TERM", "xterm-256color")
    with create_pipe_input() as input_, create_app_session(input=input_, output=DummyOutput()):
        yield input_
