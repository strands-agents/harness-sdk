"""Tests for the env-gated OTEL setup.

The SDK's ``StrandsTelemetry`` is patched out in most of these: they pin the harness's gating decision (which
exporters get wired, and how often), not the SDK's exporter wiring. The OTel API's process-global, set-once
provider slot is stubbed for every test, so the suite neither depends on nor pollutes the real one.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from opentelemetry import propagate
from opentelemetry import trace as trace_api
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

from strands_harness import telemetry


@pytest.fixture(autouse=True)
def otel_slot(monkeypatch):
    """Stand-in for the OTel API's global provider slot: first set wins, get returns the proxy while empty."""
    slot = SimpleNamespace(provider=None, set_attempts=0)

    def set_tracer_provider(provider):
        slot.set_attempts += 1
        if slot.provider is None:
            slot.provider = provider

    monkeypatch.setattr(trace_api, "set_tracer_provider", set_tracer_provider)
    monkeypatch.setattr(trace_api, "get_tracer_provider", lambda: slot.provider or trace_api.ProxyTracerProvider())
    return slot


@pytest.fixture
def installed_provider(otel_slot):
    """A host (e.g. ADOT) already owns the provider slot."""
    otel_slot.provider = SDKTracerProvider()
    return otel_slot.provider


@pytest.fixture
def strands_telemetry(monkeypatch):
    instance = MagicMock()
    factory = MagicMock(return_value=instance)
    monkeypatch.setattr(telemetry, "StrandsTelemetry", factory)
    return factory, instance


@pytest.fixture
def custom_textmap():
    """A host-configured global textmap (what OTEL_PROPAGATORS=...,xray produces), restored afterwards."""
    original = propagate.get_global_textmap()
    textmap = CompositePropagator([])
    propagate.set_global_textmap(textmap)
    yield textmap
    propagate.set_global_textmap(original)


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


def test_exporters_land_on_the_provider_the_harness_installed(strands_telemetry, otel_slot, monkeypatch):
    factory, _ = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "otlp")
    telemetry.setup_telemetry()
    assert isinstance(otel_slot.provider, SDKTracerProvider)
    assert factory.call_args.kwargs["tracer_provider"] is otel_slot.provider


def test_an_installed_tracer_provider_is_left_alone(strands_telemetry, installed_provider, otel_slot, monkeypatch):
    factory, _ = strands_telemetry
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "otlp")
    telemetry.setup_telemetry()
    factory.assert_not_called()
    assert otel_slot.provider is installed_provider
    assert otel_slot.set_attempts == 0


def test_an_installed_tracer_provider_keeps_its_propagator(installed_provider, custom_textmap, monkeypatch):
    """The owner's global textmap (e.g. ADOT's X-Ray composite) survives setup, with the real SDK in the loop."""
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "console")
    telemetry.setup_telemetry()
    assert propagate.get_global_textmap() is custom_textmap


def test_propagators_survive_even_when_the_harness_installs_the_provider(custom_textmap, otel_slot, monkeypatch):
    """OTEL_PROPAGATORS-configured propagators are not replaced just because no provider was installed yet."""
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "console")
    telemetry.setup_telemetry()
    assert propagate.get_global_textmap() is custom_textmap
    processors = otel_slot.provider._active_span_processor._span_processors
    assert [type(p) for p in processors] == [SimpleSpanProcessor]


def test_a_provider_named_in_the_env_is_left_alone(strands_telemetry, otel_slot, monkeypatch):
    """OTel's get_tracer_provider() installs OTEL_PYTHON_TRACER_PROVIDER on first read; that provider is the user's
    explicit choice and owns tracing like a host-installed one."""
    factory, _ = strands_telemetry
    env_provider = SDKTracerProvider()

    def get_tracer_provider():
        if otel_slot.provider is None:
            otel_slot.provider = env_provider
        return otel_slot.provider

    monkeypatch.setattr(trace_api, "get_tracer_provider", get_tracer_provider)
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "otlp")
    telemetry.setup_telemetry()
    factory.assert_not_called()
    assert otel_slot.provider is env_provider
    assert otel_slot.set_attempts == 0
