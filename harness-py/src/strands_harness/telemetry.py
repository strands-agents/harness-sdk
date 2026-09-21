"""OTEL tracing for a harness agent.

The SDK already instruments the agent — the model loop, tool calls, and subagent delegation all
emit spans; a plain ``Agent`` just has nowhere to send them. The harness's only job is to wire up an
exporter, and only when asked: it reads the standard ``OTEL_TRACES_EXPORTER`` selector
(``otlp``/``console``/``none``) and does nothing unless it is set. Unset means off — the harness does not
honor OTEL's spec default of ``otlp``, so it never silently stands up an exporter (which would
target ``localhost:4318`` and stall the process on exit). Endpoint, headers, and protocol are
configured through the usual ``OTEL_EXPORTER_OTLP_*`` variables, which the exporter reads itself.

Tracing is process-global (the provider lives on the OpenTelemetry global API, not on an ``Agent``),
so setup runs at most once per process: building several agents — or a ``generalist``, which builds
another agent per call — cannot stack duplicate exporters onto the same trace.
"""

from __future__ import annotations

import logging
import os

from strands.telemetry import StrandsTelemetry

logger = logging.getLogger(__name__)

TRACES_EXPORTER_ENV_VAR = "OTEL_TRACES_EXPORTER"

# The exporters the SDK's StrandsTelemetry exposes a setup method for. "none" and any other selector
# value are handled in _resolve_exporters.
_SUPPORTED_EXPORTERS = ("otlp", "console")

_configured = False


def _resolve_exporters() -> list[str]:
    """The exporters to wire, from the standard ``OTEL_TRACES_EXPORTER`` selector.

    An unset selector, or an explicit ``"none"``, means tracing is off.
    """
    selector = os.environ.get(TRACES_EXPORTER_ENV_VAR, "")
    requested = [name.strip().lower() for name in selector.split(",") if name.strip()]
    if not requested or "none" in requested:
        return []
    for name in requested:
        if name not in _SUPPORTED_EXPORTERS:
            logger.warning(
                "%s names %r, which the harness does not support; skipping it. Supported values: otlp, console, none.",
                TRACES_EXPORTER_ENV_VAR,
                name,
            )
    return [name for name in _SUPPORTED_EXPORTERS if name in requested]


def setup_telemetry() -> None:
    """Wire the SDK's span exporter(s) once per process, per the standard OTEL env convention."""
    global _configured
    if _configured:
        return
    exporters = _resolve_exporters()
    if not exporters:
        return
    telemetry = StrandsTelemetry()
    if "otlp" in exporters:
        telemetry.setup_otlp_exporter()
    if "console" in exporters:
        telemetry.setup_console_exporter()
    _configured = True


def _reset() -> None:
    """Forget that setup ran so it can run again. For tests only."""
    global _configured
    _configured = False
