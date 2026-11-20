import sys
from unittest import mock

import pytest
from opentelemetry.processor.baggage import ALLOW_ALL_BAGGAGE_KEYS

import strands.telemetry.config as telemetry_config
from strands.telemetry import StrandsTelemetry
from strands.telemetry.config import (
    _GRPC_PROTOCOL,
    _HTTP_PROTOCOL,
    _resolve_otlp_protocol,
)


@pytest.fixture
def mock_tracer_provider(mock_set_tracer_provider):
    with mock.patch("strands.telemetry.config.SDKTracerProvider") as mock_provider:
        yield mock_provider


@pytest.fixture
def mock_get_tracer_provider():
    with mock.patch("strands.telemetry.config.trace_api.get_tracer_provider") as mock_get_tracer_provider:
        mock_provider = mock.MagicMock()
        mock_get_tracer_provider.return_value = mock_provider
        yield mock_provider


@pytest.fixture
def mock_tracer():
    with mock.patch("strands.telemetry.config.trace_api.get_tracer") as mock_get_tracer:
        mock_tracer = mock.MagicMock()
        mock_get_tracer.return_value = mock_tracer
        yield mock_tracer


@pytest.fixture
def mock_set_tracer_provider():
    with mock.patch("strands.telemetry.config.trace_api.set_tracer_provider") as mock_set:
        yield mock_set


@pytest.fixture
def mock_meter_provider():
    with mock.patch("strands.telemetry.config.metrics_sdk.MeterProvider") as mock_meter_provider:
        yield mock_meter_provider


@pytest.fixture
def mock_metrics_api():
    with mock.patch("strands.telemetry.config.metrics_api") as mock_metrics_api:
        yield mock_metrics_api


@pytest.fixture
def mock_set_global_textmap():
    with mock.patch("strands.telemetry.config.propagate.set_global_textmap") as mock_set_global_textmap:
        yield mock_set_global_textmap


@pytest.fixture
def mock_console_exporter():
    with mock.patch("strands.telemetry.config.ConsoleSpanExporter") as mock_console_exporter:
        yield mock_console_exporter


@pytest.fixture
def mock_reader():
    with mock.patch("strands.telemetry.config.PeriodicExportingMetricReader") as mock_reader:
        yield mock_reader


@pytest.fixture
def mock_console_metrics_exporter():
    with mock.patch("strands.telemetry.config.ConsoleMetricExporter") as mock_console_metrics_exporter:
        yield mock_console_metrics_exporter


@pytest.fixture
def mock_otlp_metrics_exporter():
    with mock.patch(
        "opentelemetry.exporter.otlp.proto.http.metric_exporter.OTLPMetricExporter"
    ) as mock_otlp_metrics_exporter:
        yield mock_otlp_metrics_exporter


@pytest.fixture
def mock_otlp_exporter():
    with mock.patch("opentelemetry.exporter.otlp.proto.http.trace_exporter.OTLPSpanExporter") as mock_otlp_exporter:
        yield mock_otlp_exporter


@pytest.fixture
def mock_batch_processor():
    with mock.patch("strands.telemetry.config.BatchSpanProcessor") as mock_batch_processor:
        yield mock_batch_processor


@pytest.fixture
def mock_simple_processor():
    with mock.patch("strands.telemetry.config.SimpleSpanProcessor") as mock_simple_processor:
        yield mock_simple_processor


@pytest.fixture
def mock_resource():
    with mock.patch("strands.telemetry.config.get_otel_resource") as mock_resource:
        mock_resource_instance = mock.MagicMock()
        mock_resource.return_value = mock_resource_instance
        yield mock_resource


@pytest.fixture
def mock_initialize_tracer():
    with mock.patch("strands.telemetry.StrandsTelemetry._initialize_tracer") as mock_initialize_tracer:
        yield mock_initialize_tracer


def test_init_default(mock_resource, mock_tracer_provider, mock_set_tracer_provider, mock_set_global_textmap):
    """Test initializing the Tracer."""

    StrandsTelemetry()

    mock_resource.assert_called()
    mock_tracer_provider.assert_called_with(resource=mock_resource.return_value)
    mock_set_tracer_provider.assert_called_with(mock_tracer_provider.return_value)
    mock_set_global_textmap.assert_called()


def test_setup_meter_with_console_exporter(
    mock_resource,
    mock_reader,
    mock_console_metrics_exporter,
    mock_otlp_metrics_exporter,
    mock_metrics_api,
    mock_meter_provider,
):
    """Test add console metrics exporter"""
    mock_metrics_api.MeterProvider.return_value = mock_meter_provider

    telemetry = StrandsTelemetry()
    telemetry.setup_meter(enable_console_exporter=True)

    mock_console_metrics_exporter.assert_called_once()
    mock_reader.assert_called_once_with(mock_console_metrics_exporter.return_value)
    mock_otlp_metrics_exporter.assert_not_called()

    mock_metrics_api.set_meter_provider.assert_called_once()


def test_setup_meter_with_console_and_otlp_exporter(
    mock_resource,
    mock_reader,
    mock_console_metrics_exporter,
    mock_otlp_metrics_exporter,
    mock_metrics_api,
    mock_meter_provider,
):
    """Test add console and otlp metrics exporter"""
    mock_metrics_api.MeterProvider.return_value = mock_meter_provider

    telemetry = StrandsTelemetry()
    telemetry.setup_meter(enable_console_exporter=True, enable_otlp_exporter=True)

    mock_console_metrics_exporter.assert_called_once()
    mock_otlp_metrics_exporter.assert_called_once()
    assert mock_reader.call_count == 2

    mock_metrics_api.set_meter_provider.assert_called_once()


def test_setup_meter_forwards_provider_kwargs(
    mock_resource,
    mock_reader,
    mock_metrics_api,
    mock_meter_provider,
):
    """Test that arbitrary kwargs are forwarded to MeterProvider."""
    sentinel_views = [mock.MagicMock()]

    telemetry = StrandsTelemetry()
    telemetry.setup_meter(views=sentinel_views)

    mock_meter_provider.assert_called_once_with(
        resource=mock_resource.return_value,
        metric_readers=[],
        views=sentinel_views,
    )


def test_setup_console_exporter(mock_resource, mock_tracer_provider, mock_console_exporter, mock_simple_processor):
    """Test add console exporter"""

    telemetry = StrandsTelemetry()
    # Set the tracer_provider directly
    telemetry.tracer_provider = mock_tracer_provider.return_value
    telemetry.setup_console_exporter(foo="bar")

    mock_console_exporter.assert_called_once_with(foo="bar")
    mock_simple_processor.assert_called_once_with(mock_console_exporter.return_value)

    mock_tracer_provider.return_value.add_span_processor.assert_called()


def test_setup_otlp_exporter(mock_resource, mock_tracer_provider, mock_otlp_exporter, mock_batch_processor):
    """Test add otlp exporter."""

    telemetry = StrandsTelemetry()
    # Set the tracer_provider directly
    telemetry.tracer_provider = mock_tracer_provider.return_value
    telemetry.setup_otlp_exporter(foo="bar")

    mock_otlp_exporter.assert_called_once_with(foo="bar")
    mock_batch_processor.assert_called_once_with(mock_otlp_exporter.return_value)

    mock_tracer_provider.return_value.add_span_processor.assert_called()


def test_setup_baggage_processor(mock_resource, mock_tracer_provider):
    """Test add baggage span processor."""
    with mock.patch("opentelemetry.processor.baggage.BaggageSpanProcessor") as mock_baggage_processor:
        telemetry = StrandsTelemetry()
        telemetry.tracer_provider = mock_tracer_provider.return_value
        result = telemetry.setup_baggage_processor()

    mock_baggage_processor.assert_called_once_with(ALLOW_ALL_BAGGAGE_KEYS)
    mock_tracer_provider.return_value.add_span_processor.assert_called_once_with(mock_baggage_processor.return_value)
    assert result is telemetry


@pytest.mark.parametrize(
    "baggage_key_predicate",
    [
        lambda key: key.startswith("tenant."),
        [lambda key: key == "session.id", lambda key: key.startswith("tenant.")],
    ],
    ids=["single", "sequence"],
)
def test_setup_baggage_processor_with_predicate(mock_resource, mock_tracer_provider, baggage_key_predicate):
    """Test baggage span processor forwards the given predicate(s) unchanged."""
    with mock.patch("opentelemetry.processor.baggage.BaggageSpanProcessor") as mock_baggage_processor:
        telemetry = StrandsTelemetry()
        telemetry.tracer_provider = mock_tracer_provider.return_value
        result = telemetry.setup_baggage_processor(baggage_key_predicate)

    mock_baggage_processor.assert_called_once_with(baggage_key_predicate)
    mock_tracer_provider.return_value.add_span_processor.assert_called_once_with(mock_baggage_processor.return_value)
    assert result is telemetry


def test_setup_baggage_processor_exception(mock_resource, mock_tracer_provider):
    """Test baggage span processor with exception."""
    with mock.patch(
        "opentelemetry.processor.baggage.BaggageSpanProcessor", side_effect=Exception("Test exception")
    ) as mock_baggage_processor:
        telemetry = StrandsTelemetry()
        telemetry.tracer_provider = mock_tracer_provider.return_value
        # This should not raise an exception
        telemetry.setup_baggage_processor()

    mock_baggage_processor.assert_called_once()


def test_setup_console_exporter_exception(mock_resource, mock_tracer_provider, mock_console_exporter):
    """Test console exporter with exception."""
    mock_console_exporter.side_effect = Exception("Test exception")

    telemetry = StrandsTelemetry()
    telemetry.tracer_provider = mock_tracer_provider.return_value
    # This should not raise an exception
    telemetry.setup_console_exporter()

    mock_console_exporter.assert_called_once()


def test_setup_otlp_exporter_exception(mock_resource, mock_tracer_provider, mock_otlp_exporter):
    """Test otlp exporter with exception."""
    mock_otlp_exporter.side_effect = Exception("Test exception")

    telemetry = StrandsTelemetry()
    telemetry.tracer_provider = mock_tracer_provider.return_value
    # This should not raise an exception
    telemetry.setup_otlp_exporter()

    mock_otlp_exporter.assert_called_once()


def test_resolve_otlp_protocol_default(monkeypatch):
    """No arg, no env -> default http/protobuf."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_PROTOCOL", raising=False)
    assert _resolve_otlp_protocol(None) == _HTTP_PROTOCOL


def test_resolve_otlp_protocol_param_overrides_env(monkeypatch):
    """Explicit arg wins over env var."""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_PROTOCOL", _HTTP_PROTOCOL)
    assert _resolve_otlp_protocol(_GRPC_PROTOCOL) == _GRPC_PROTOCOL


def test_resolve_otlp_protocol_env_fallback(monkeypatch):
    """No arg -> env var consulted."""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_PROTOCOL", _GRPC_PROTOCOL)
    assert _resolve_otlp_protocol(None) == _GRPC_PROTOCOL


def test_resolve_otlp_protocol_invalid_raises(monkeypatch):
    """Unsupported value -> ValueError."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_PROTOCOL", raising=False)
    with pytest.raises(ValueError, match="unsupported OTLP protocol"):
        _resolve_otlp_protocol("http/json")


def test_resolve_otlp_protocol_empty_string_raises(monkeypatch):
    """Explicit empty string is invalid, not a fall-through to the env/default."""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_PROTOCOL", _GRPC_PROTOCOL)
    with pytest.raises(ValueError, match="unsupported OTLP protocol"):
        _resolve_otlp_protocol("")


def _inject_grpc_trace_module():
    """Build a fake grpc trace_exporter module exposing OTLPSpanExporter."""
    fake_module = mock.MagicMock()
    fake_module.OTLPSpanExporter = mock.MagicMock()
    return {"opentelemetry.exporter.otlp.proto.grpc.trace_exporter": fake_module}, fake_module


def _inject_grpc_metric_module():
    """Build a fake grpc metric_exporter module exposing OTLPMetricExporter."""
    fake_module = mock.MagicMock()
    fake_module.OTLPMetricExporter = mock.MagicMock()
    return {"opentelemetry.exporter.otlp.proto.grpc.metric_exporter": fake_module}, fake_module


def test_setup_otlp_exporter_grpc(mock_resource, mock_tracer_provider, mock_batch_processor, monkeypatch):
    """protocol='grpc' imports the gRPC OTLPSpanExporter."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_PROTOCOL", raising=False)
    fake_modules, fake_module = _inject_grpc_trace_module()
    with mock.patch.dict(sys.modules, fake_modules):
        telemetry = StrandsTelemetry()
        telemetry.tracer_provider = mock_tracer_provider.return_value
        telemetry.setup_otlp_exporter(protocol=_GRPC_PROTOCOL, foo="bar")

    # The mock object stays valid after the patch.dict context restores sys.modules,
    # so the call assertion can run outside the `with` block.
    fake_module.OTLPSpanExporter.assert_called_once_with(foo="bar")
    mock_batch_processor.assert_called_once_with(fake_module.OTLPSpanExporter.return_value)


def test_setup_otlp_exporter_grpc_missing_extra_raises(mock_resource, mock_tracer_provider, monkeypatch):
    """gRPC import failure -> ImportError mentioning otel-grpc extra."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_PROTOCOL", raising=False)
    # Force the gRPC import to fail by setting the module entry to None.
    monkeypatch.setitem(sys.modules, "opentelemetry.exporter.otlp.proto.grpc.trace_exporter", None)

    telemetry = StrandsTelemetry()
    telemetry.tracer_provider = mock_tracer_provider.return_value
    with pytest.raises(ImportError, match="otel-grpc"):
        telemetry.setup_otlp_exporter(protocol=_GRPC_PROTOCOL)


def test_setup_otlp_exporter_http_missing_extra_raises(mock_resource, mock_tracer_provider, monkeypatch):
    """HTTP import failure -> ImportError mentioning otel extra (symmetry guard)."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_PROTOCOL", raising=False)
    # Force the http import to fail by injecting None into sys.modules.
    monkeypatch.setitem(sys.modules, "opentelemetry.exporter.otlp.proto.http.trace_exporter", None)

    telemetry = StrandsTelemetry()
    telemetry.tracer_provider = mock_tracer_provider.return_value
    with pytest.raises(ImportError, match="'otel'"):
        telemetry.setup_otlp_exporter()


def test_setup_meter_otlp_grpc(
    mock_resource,
    mock_reader,
    mock_metrics_api,
    mock_meter_provider,
    monkeypatch,
):
    """enable_otlp_exporter=True with otlp_protocol='grpc' imports gRPC metric exporter."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_PROTOCOL", raising=False)
    fake_modules, fake_module = _inject_grpc_metric_module()
    with mock.patch.dict(sys.modules, fake_modules):
        telemetry = StrandsTelemetry()
        telemetry.setup_meter(enable_otlp_exporter=True, otlp_protocol=_GRPC_PROTOCOL)

    fake_module.OTLPMetricExporter.assert_called_once_with()
    mock_reader.assert_called_once_with(fake_module.OTLPMetricExporter.return_value)


def test_setup_meter_otlp_grpc_missing_extra_raises(mock_resource, mock_metrics_api, monkeypatch):
    """gRPC metric import failure -> ImportError mentioning otel-grpc."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_PROTOCOL", raising=False)
    # Force the gRPC import to fail by setting the module entry to None.
    monkeypatch.setitem(sys.modules, "opentelemetry.exporter.otlp.proto.grpc.metric_exporter", None)

    telemetry = StrandsTelemetry()
    with pytest.raises(ImportError, match="otel-grpc"):
        telemetry.setup_meter(enable_otlp_exporter=True, otlp_protocol=_GRPC_PROTOCOL)


def test_setup_meter_otlp_http_missing_extra_raises(mock_resource, mock_metrics_api, monkeypatch):
    """HTTP metric import failure -> ImportError mentioning otel."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_PROTOCOL", raising=False)
    # Force the HTTP import to fail by setting the module entry to None.
    monkeypatch.setitem(sys.modules, "opentelemetry.exporter.otlp.proto.http.metric_exporter", None)

    telemetry = StrandsTelemetry()
    with pytest.raises(ImportError, match="'otel' extra"):
        telemetry.setup_meter(enable_otlp_exporter=True)


def test_get_otel_resource_uses_default_service_name(monkeypatch):
    monkeypatch.delenv("OTEL_SERVICE_NAME", raising=False)
    monkeypatch.setattr(telemetry_config, "version", lambda _: "0.0.0")

    resource = telemetry_config.get_otel_resource()

    assert resource.attributes.get("service.name") == "strands-agents"


def test_get_otel_resource_respects_otel_service_name(monkeypatch):
    monkeypatch.setenv("OTEL_SERVICE_NAME", "my-service")
    monkeypatch.setattr(telemetry_config, "version", lambda _: "0.0.0")

    resource = telemetry_config.get_otel_resource()

    assert resource.attributes.get("service.name") == "my-service"
