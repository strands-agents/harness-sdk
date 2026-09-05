"""OpenTelemetry configuration and setup utilities for Strands agents.

This module provides centralized configuration and initialization functionality
for OpenTelemetry components and other telemetry infrastructure shared across Strands applications.
"""

import logging
import os
from importlib.metadata import version
from typing import Any

import opentelemetry.metrics as metrics_api
import opentelemetry.sdk.metrics as metrics_sdk
import opentelemetry.trace as trace_api
from opentelemetry import propagate
from opentelemetry.baggage.propagation import W3CBaggagePropagator
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.sdk.metrics.export import ConsoleMetricExporter, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider as SDKTracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

logger = logging.getLogger(__name__)


def get_otel_resource() -> Resource:
    """Create a standard OpenTelemetry resource with service information.

    Returns:
        Resource object with standard service information.
    """
    service_name = os.getenv("OTEL_SERVICE_NAME", "strands-agents").strip()

    resource = Resource.create(
        {
            "service.name": service_name,
            "service.version": version("strands-agents"),
            "telemetry.sdk.name": "opentelemetry",
            "telemetry.sdk.language": "python",
        }
    )

    return resource


# Environment variables that, when set to the (case-insensitive) string "true",
# silence Strands' own telemetry. ``OTEL_SDK_DISABLED`` is the OpenTelemetry-standard
# flag; ``STRANDS_OTEL_DISABLED`` is a Strands-specific escape hatch so a host that
# owns its own OpenTelemetry setup can silence just Strands' spans/metrics without
# touching the OTel-standard variable (#1059). Consumed at the instance level by
# ``Tracer`` and ``MetricsClient`` (no-op providers when disabled).
_DISABLE_ENV_VARS = ("OTEL_SDK_DISABLED", "STRANDS_OTEL_DISABLED")


def _telemetry_disabled() -> bool:
    """Return True when any Strands telemetry disable env var is set to ``"true"``."""
    return any(os.environ.get(name, "").strip().lower() == "true" for name in _DISABLE_ENV_VARS)


class StrandsTelemetry:
    """OpenTelemetry configuration and setup for Strands applications.

    Automatically initializes a tracer provider with text map propagators.
    Trace exporters (console, OTLP) can be set up individually using dedicated methods
    that support method chaining for convenient configuration.

    Args:
        tracer_provider: Optional pre-configured SDKTracerProvider. If None,
            a new one will be created and set as the global tracer provider.

    Environment Variables:
        Environment variables are handled by the underlying OpenTelemetry SDK:
        - OTEL_EXPORTER_OTLP_ENDPOINT: OTLP endpoint URL
        - OTEL_EXPORTER_OTLP_HEADERS: Headers for OTLP requests
        - OTEL_SERVICE_NAME: Overrides resource service name

        Either of the following, set to "true", silences Strands' own spans and
        metrics. They differ in blast radius:
        - OTEL_SDK_DISABLED: the OpenTelemetry-standard flag. The OTel SDK
          no-ops process-wide, so telemetry the host application emits through
          its own instrumentation is suppressed alongside Strands'.
        - STRANDS_OTEL_DISABLED: Strands-specific. Strands' tracer and metrics
          client fall back to no-op providers, while the host application's own
          OpenTelemetry pipeline keeps recording. Use this one to keep your own
          instrumentation (e.g. a Bedrock instrumentor calling an agent as a
          tool) while silencing Strands.

        Both are read once, when the tracer and the metrics client are first
        constructed. Those are process-lifetime singletons, so the variable has
        to be set before the first agent / tracer / metrics call — changing it
        afterwards has no effect for the remainder of the process.

    Examples:
        Quick setup with method chaining:
        >>> StrandsTelemetry().setup_console_exporter().setup_otlp_exporter()

        Using a custom tracer provider:
        >>> StrandsTelemetry(tracer_provider=my_provider).setup_console_exporter()

        Step-by-step configuration:
        >>> telemetry = StrandsTelemetry()
        >>> telemetry.setup_console_exporter()
        >>> telemetry.setup_otlp_exporter()

        To setup global meter provider
        >>> telemetry.setup_meter(enable_console_exporter=True, enable_otlp_exporter=True) # default are False

    Note:
        - The tracer provider is automatically initialized upon instantiation
        - When no tracer_provider is provided, the instance sets itself as the global provider
        - Exporters must be explicitly configured using the setup methods
        - Failed exporter configurations are logged but do not raise exceptions
        - All setup methods return self to enable method chaining
    """

    def __init__(self, tracer_provider: SDKTracerProvider | None = None) -> None:
        """Initialize the StrandsTelemetry instance.

        Args:
            tracer_provider: Optional pre-configured tracer provider.
                If None, a new one will be created and set as global.

        The instance is ready to use immediately after initialization, though
        trace exporters must be configured separately using the setup methods.
        """
        self.resource = get_otel_resource()
        if tracer_provider:
            self.tracer_provider = tracer_provider
        else:
            self._initialize_tracer()

    def _initialize_tracer(self) -> None:
        """Initialize the OpenTelemetry tracer."""
        logger.info("Initializing tracer")

        # Create tracer provider
        self.tracer_provider = SDKTracerProvider(resource=self.resource)

        # Set as global tracer provider
        trace_api.set_tracer_provider(self.tracer_provider)

        # Set up propagators
        propagate.set_global_textmap(
            CompositePropagator(
                [
                    W3CBaggagePropagator(),
                    TraceContextTextMapPropagator(),
                ]
            )
        )

    def setup_console_exporter(self, **kwargs: Any) -> "StrandsTelemetry":
        """Set up console exporter for the tracer provider.

        Args:
            **kwargs: Optional keyword arguments passed directly to
                OpenTelemetry's ConsoleSpanExporter initializer.

        Returns:
            self: Enables method chaining.

        This method configures a SimpleSpanProcessor with a ConsoleSpanExporter,
        allowing trace data to be output to the console. Any additional keyword
        arguments provided will be forwarded to the ConsoleSpanExporter.
        """
        try:
            logger.info("Enabling console export")
            console_processor = SimpleSpanProcessor(ConsoleSpanExporter(**kwargs))
            self.tracer_provider.add_span_processor(console_processor)
        except Exception as e:
            logger.exception("error=<%s> | Failed to configure console exporter", e)
        return self

    def setup_otlp_exporter(self, **kwargs: Any) -> "StrandsTelemetry":
        """Set up OTLP exporter for the tracer provider.

        Args:
            **kwargs: Optional keyword arguments passed directly to
                OpenTelemetry's OTLPSpanExporter initializer.

        Returns:
            self: Enables method chaining.

        This method configures a BatchSpanProcessor with an OTLPSpanExporter,
        allowing trace data to be exported to an OTLP endpoint. Any additional
        keyword arguments provided will be forwarded to the OTLPSpanExporter.
        """
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        try:
            otlp_exporter = OTLPSpanExporter(**kwargs)
            batch_processor = BatchSpanProcessor(otlp_exporter)
            self.tracer_provider.add_span_processor(batch_processor)
            logger.info("OTLP exporter configured")
        except Exception as e:
            logger.exception("error=<%s> | Failed to configure OTLP exporter", e)
        return self

    def setup_meter(
        self, enable_console_exporter: bool = False, enable_otlp_exporter: bool = False
    ) -> "StrandsTelemetry":
        """Initialize the OpenTelemetry Meter."""
        logger.info("Initializing meter")
        metrics_readers = []
        try:
            if enable_console_exporter:
                logger.info("Enabling console metrics exporter")
                console_reader = PeriodicExportingMetricReader(ConsoleMetricExporter())
                metrics_readers.append(console_reader)
            if enable_otlp_exporter:
                logger.info("Enabling OTLP metrics exporter")
                from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter

                otlp_reader = PeriodicExportingMetricReader(OTLPMetricExporter())
                metrics_readers.append(otlp_reader)
        except Exception as e:
            logger.exception("error=<%s> | Failed to configure OTLP metrics exporter", e)

        self.meter_provider = metrics_sdk.MeterProvider(resource=self.resource, metric_readers=metrics_readers)

        # Set as global tracer provider
        metrics_api.set_meter_provider(self.meter_provider)
        logger.info("Strands Meter configured")
        return self
