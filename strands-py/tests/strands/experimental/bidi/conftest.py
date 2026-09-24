import unittest.mock

import pytest


@pytest.fixture
def mock_audio_processor():
    """Mock the native audio processor constructor for one test."""
    with unittest.mock.patch(
        "strands.experimental.bidi._audio.processor.pywebrtc_audio.AudioProcessor"
    ) as processor_class:
        yield processor_class
