import sys
from types import ModuleType

# The standard test environment does not install the native PyAudio dependency.
pyaudio = ModuleType("pyaudio")
pyaudio.PyAudio = object
pyaudio.Stream = object
sys.modules.setdefault("pyaudio", pyaudio)
