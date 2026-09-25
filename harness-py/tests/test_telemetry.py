"""Tests for the env-gated OTEL setup.

The SDK's ``StrandsTelemetry`` is patched out: these pin the harness's gating decision (which exporters
get wired, and how often), not the SDK's exporter wiring.
"""

from unittest.mock import MagicMock

import pytest

from strands_harness import telemetry


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
