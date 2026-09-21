"""Shared test configuration.

Telemetry keys off the standard ``OTEL_TRACES_EXPORTER`` selector, so on a machine that happens to
export it every ``create_harness()`` in this suite would stand up a real exporter — slow, noisy, and
host-dependent. Scrubbing the variable and resetting the harness's process-global setup around each test
keeps telemetry behavior a property of the test, not the host.
"""

import pytest

from strands_harness import telemetry


@pytest.fixture(autouse=True)
def isolate_telemetry(monkeypatch):
    monkeypatch.delenv(telemetry.TRACES_EXPORTER_ENV_VAR, raising=False)
    telemetry._reset()
    yield
    telemetry._reset()
