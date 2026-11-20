"""OpenTelemetry configuration and setup utilities for Strands agents.

This module provides centralized configuration and initialization functionality
for OpenTelemetry components and other telemetry infrastructure shared across Strands applications.
"""

import logging
import os
from collections.abc import Callable, Sequence
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

BaggageKeyPredicate = Callable[[str], bool]
BaggageKeyPredicates = BaggageKeyPredicate | Sequence[BaggageKeyPredicate]

logger = logging.getLogger(__name__)

_HTTP_PROTOCOL = "http/protobuf"
_GRPC_PROTOCOL = "grpc"
_VALID_OTLP_PROTOCOLS = (_HTTP_PROTOCOL, _GRPC_PROTOCOL)


def _resolve_otlp_protocol(protocol: str | None) -> str:
    """Resolve the OTLP transport protocol.

    Resolution order: explicit argument > OTEL_EXPORTER_OTLP_PROTOCOL env var
    > http/protobuf default.

    Args:
        protocol: Explicit protocol selection, or None to fall back to env/default.

    Returns:
        Either "http/protobuf" or "grpc".

    Raises:
        ValueError: If the resolved value is not a supported OTLP protocol.
    """
    resolved = protocol if protocol is not None else os.getenv("OTEL_EXPORTER_OTLP_PROTOCOL", _HTTP_PROTOCOL)
    if resolved not in _VALID_OTLP_PROTOCOLS:
        raise ValueError(f"protocol=<{resolved}> | unsupported OTLP protocol, must be one of {_VALID_OTLP_PROTOCOLS}")
    return resolved


def _missing_otlp_extra_msg(extra: str) -> str:
    """Build a consistent ImportError message for missing OTLP extras."""
    return f"OTLP exporter requires the '{extra}' extra. Install with: pip install 'strands-agents[{extra}]'"


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
        - OTEL_EXPORTER_OTLP_PROTOCOL: OTLP transport protocol ("http/protobuf" or "grpc")
        - OTEL_SERVICE_NAME: Overrides resource service name

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

    def __init__(
        self,
        tracer_provider: SDKTracerProvider | None = None,
    ) -> None:
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

    def setup_otlp_exporter(self, protocol: str | None = None, **kwargs: Any) -> "StrandsTelemetry":
        """Set up OTLP exporter for the tracer provider.

        Args:
            protocol: OTLP transport. Either "http/protobuf" (default) or "grpc".
                If not provided, OTEL_EXPORTER_OTLP_PROTOCOL is consulted; if
                that is also unset, the default is "http/protobuf".
            **kwargs: Optional keyword arguments passed directly to
                OpenTelemetry's OTLPSpanExporter initializer.

        Returns:
            self: Enables method chaining.

        Raises:
            ValueError: When protocol is not a supported OTLP protocol.
            ImportError: When the optional extra for the resolved protocol is
                not installed (`otel` for http/protobuf, `otel-grpc` for grpc).

        This method configures a BatchSpanProcessor with an OTLPSpanExporter,
        allowing trace data to be exported to an OTLP endpoint. Any additional
        keyword arguments provided will be forwarded to the OTLPSpanExporter.
        """
        resolved = _resolve_otlp_protocol(protocol)
        if resolved == _GRPC_PROTOCOL:
            try:
                from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
            except ImportError as e:
                raise ImportError(_missing_otlp_extra_msg("otel-grpc")) from e
        else:
            try:
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import (  # type: ignore[assignment]
                    OTLPSpanExporter,
                )
            except ImportError as e:
                raise ImportError(_missing_otlp_extra_msg("otel")) from e

        try:
            otlp_exporter = OTLPSpanExporter(**kwargs)
            batch_processor = BatchSpanProcessor(otlp_exporter)
            self.tracer_provider.add_span_processor(batch_processor)
            logger.info("protocol=<%s> | OTLP exporter configured", resolved)
        except Exception as e:
            logger.exception("error=<%s> | Failed to configure OTLP exporter", e)
        return self

    def setup_baggage_processor(self, baggage_key_predicate: BaggageKeyPredicates | None = None) -> "StrandsTelemetry":
        """Set up a baggage span processor for the tracer provider.

        Args:
            baggage_key_predicate: A predicate, or sequence of predicates, that receives a baggage key and
                returns True if the entry should be stamped onto spans. If None, every baggage key is recorded.

        Returns:
            self: Enables method chaining.

        This method registers a BaggageSpanProcessor that stamps OTel baggage
        entries onto spans as attributes when they start.
        """
        from opentelemetry.processor.baggage import ALLOW_ALL_BAGGAGE_KEYS, BaggageSpanProcessor

        try:
            logger.info("Enabling baggage span processor")
            predicate = ALLOW_ALL_BAGGAGE_KEYS if baggage_key_predicate is None else baggage_key_predicate
            self.tracer_provider.add_span_processor(BaggageSpanProcessor(predicate))
        except Exception as e:
            logger.exception("error=<%s> | Failed to configure baggage span processor", e)
        return self

    def setup_meter(
        self,
        enable_console_exporter: bool = False,
        enable_otlp_exporter: bool = False,
        otlp_protocol: str | None = None,
        **provider_kwargs: Any,
    ) -> "StrandsTelemetry":
        """Initialize the OpenTelemetry Meter.

        Args:
            enable_console_exporter: When True, attach a console metrics exporter.
            enable_otlp_exporter: When True, attach an OTLP metrics exporter.
            otlp_protocol: OTLP transport when enable_otlp_exporter=True. Either
                "http/protobuf" (default) or "grpc". If not provided,
                OTEL_EXPORTER_OTLP_PROTOCOL is consulted; if that is also unset,
                the default is "http/protobuf". Ignored when enable_otlp_exporter=False.
            **provider_kwargs: Optional keyword arguments passed directly to
                OpenTelemetry's MeterProvider initializer (e.g., views,
                shutdown_on_exit). Passing resource or metric_readers raises
                TypeError because this method supplies them.

        Returns:
            self: Enables method chaining.

        Raises:
            TypeError: If resource or metric_readers is passed in provider_kwargs.
            ValueError: When otlp_protocol is not a supported OTLP protocol.
            ImportError: When enable_otlp_exporter=True and the optional extra
                for the resolved protocol is not installed (`otel` for
                http/protobuf, `otel-grpc` for grpc).
        """
        logger.info("Initializing meter")

        # Resolve & import OTLP exporter up front so configuration errors fail fast.
        otlp_metric_exporter_cls: type | None = None
        resolved_protocol: str | None = None
        if enable_otlp_exporter:
            resolved_protocol = _resolve_otlp_protocol(otlp_protocol)
            if resolved_protocol == _GRPC_PROTOCOL:
                try:
                    from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
                except ImportError as e:
                    raise ImportError(_missing_otlp_extra_msg("otel-grpc")) from e
            else:
                try:
                    from opentelemetry.exporter.otlp.proto.http.metric_exporter import (  # type: ignore[assignment]
                        OTLPMetricExporter,
                    )
                except ImportError as e:
                    raise ImportError(_missing_otlp_extra_msg("otel")) from e
            otlp_metric_exporter_cls = OTLPMetricExporter

        metrics_readers = []
        try:
            if enable_console_exporter:
                logger.info("Enabling console metrics exporter")
                console_reader = PeriodicExportingMetricReader(ConsoleMetricExporter())
                metrics_readers.append(console_reader)
            if otlp_metric_exporter_cls is not None:
                logger.info("protocol=<%s> | enabling OTLP metrics exporter", resolved_protocol)
                otlp_reader = PeriodicExportingMetricReader(otlp_metric_exporter_cls())
                metrics_readers.append(otlp_reader)
        except Exception as e:
            logger.exception("error=<%s> | Failed to configure OTLP metrics exporter", e)

        self.meter_provider = metrics_sdk.MeterProvider(
            resource=self.resource,
            metric_readers=metrics_readers,
            **provider_kwargs,
        )

        # Set as global tracer provider
        metrics_api.set_meter_provider(self.meter_provider)
        logger.info("Strands Meter configured")
        return self
