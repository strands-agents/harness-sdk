"""Tests for the env-gated OTEL setup.

The SDK's ``StrandsTelemetry`` is patched out in most of these: they pin the harness's gating decision (which
exporters get wired, and how often), not the SDK's exporter wiring.
"""

from unittest.mock import MagicMock

import pytest
from opentelemetry import propagate
from opentelemetry import trace as trace_api
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider

from strands_harness import telemetry


@pytest.fixture
def installed_provider(monkeypatch):
    """Simulate a host (e.g. ADOT) that already owns the OTel globals, without tripping the real set-once latch."""
    monkeypatch.setattr(trace_api, "get_tracer_provider", lambda: SDKTracerProvider())
    set_tracer_provider = MagicMock()
    monkeypatch.setattr(trace_api, "set_tracer_provider", set_tracer_provider)
    textmap = propagate.get_global_textmap()
    yield set_tracer_provider
    propagate.set_global_textmap(textmap)


@pytest.fixture
def strands_telemetry(monkeypatch):
    instance = MagicMock()
    factory = MagicMock(return_value=instance)
    monkeypatch.setattr(telemetry, "StrandsTelemetry", factory)
    return factory, instance


def test_no_selector_configures_nothing(strands_telemetry):
    factory, _ = strands_telemetry
    telemetry.setup_telemetry()
    factory.assert_not_called()


def test_an_endpoint_alone_does_not_enable_tracing(strands_telemetry, monkeypatch):
    factory, _ = strands_telemetry
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    telemetry.setup_telemetry()
    factory.assert_not_called()


def test_selector_otlp_wires_the_otlp_exporter(strands_telemetry, monkeypatch):
    factory, instance = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "otlp")
    telemetry.setup_telemetry()
    factory.assert_called_once()
    instance.setup_otlp_exporter.assert_called_once()
    instance.setup_console_exporter.assert_not_called()


def test_selector_console_wires_the_console_exporter(strands_telemetry, monkeypatch):
    _, instance = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "console")
    telemetry.setup_telemetry()
    instance.setup_console_exporter.assert_called_once()
    instance.setup_otlp_exporter.assert_not_called()


def test_selector_lists_both_exporters(strands_telemetry, monkeypatch):
    _, instance = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "otlp, console")
    telemetry.setup_telemetry()
    instance.setup_otlp_exporter.assert_called_once()
    instance.setup_console_exporter.assert_called_once()


def test_selector_none_disables_tracing(strands_telemetry, monkeypatch):
    factory, _ = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "none")
    telemetry.setup_telemetry()
    factory.assert_not_called()


def test_unsupported_exporter_warns_and_is_skipped(strands_telemetry, monkeypatch, caplog):
    factory, _ = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "zipkin")
    with caplog.at_level("WARNING"):
        telemetry.setup_telemetry()
    factory.assert_not_called()
    assert "zipkin" in caplog.text


def test_unsupported_exporter_still_wires_the_supported_ones(strands_telemetry, monkeypatch):
    _, instance = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "zipkin,otlp")
    telemetry.setup_telemetry()
    instance.setup_otlp_exporter.assert_called_once()


def test_setup_runs_once_per_process(strands_telemetry, monkeypatch):
    factory, instance = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "otlp")
    telemetry.setup_telemetry()
    telemetry.setup_telemetry()
    telemetry.setup_telemetry()
    factory.assert_called_once()
    instance.setup_otlp_exporter.assert_called_once()


def test_an_installed_tracer_provider_is_left_alone(strands_telemetry, installed_provider, monkeypatch):
    factory, _ = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "otlp")
    telemetry.setup_telemetry()
    factory.assert_not_called()


def test_an_installed_tracer_provider_keeps_its_propagator(installed_provider, monkeypatch):
    """The owner's global textmap (e.g. ADOT's X-Ray composite) survives setup, with the real SDK in the loop."""
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "console")
    textmap = propagate.get_global_textmap()
    telemetry.setup_telemetry()
    assert propagate.get_global_textmap() is textmap
    installed_provider.assert_not_called()
