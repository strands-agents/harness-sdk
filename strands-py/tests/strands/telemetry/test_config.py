from unittest import mock

import pytest

import strands.telemetry.config as telemetry_config
from strands.telemetry import StrandsTelemetry


@pytest.fixture
def mock_tracer_provider():
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
