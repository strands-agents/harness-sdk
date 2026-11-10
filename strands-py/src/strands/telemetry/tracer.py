"""OpenTelemetry integration.

This module provides tracing capabilities using OpenTelemetry,
enabling trace data to be sent to OTLP endpoints.
"""

import json
import logging
import os
from collections.abc import Mapping
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING, Any, cast

import opentelemetry.context as context_api
import opentelemetry.trace as trace_api
from opentelemetry.instrumentation.threading import ThreadingInstrumentor
from opentelemetry.trace import Link, Span, SpanContext, StatusCode

from ..agent.agent_result import AgentResult
from ..types.content import ContentBlock, Message, Messages
from ..types.interrupt import InterruptResponseContent
from ..types.multiagent import MultiAgentInput
from ..types.streaming import Metrics, StopReason, Usage
from ..types.tools import ToolResult, ToolUse
from ..types.traces import Attributes, AttributeValue
from .metrics import _total_prompt_tokens

if TYPE_CHECKING:
    from ..memory.types import MemoryEntry

logger = logging.getLogger(__name__)

REDACTED_VALUE = "[REDACTED]"


class JSONEncoder(json.JSONEncoder):
    """Custom JSON encoder that handles non-serializable types."""

    def encode(self, obj: Any) -> str:
        """Recursively encode objects, preserving structure and only replacing unserializable values.

        Args:
            obj: The object to encode

        Returns:
            JSON string representation of the object
        """
        # Process the object to handle non-serializable values
        processed_obj = self._process_value(obj)
        # Use the parent class to encode the processed object
        return super().encode(processed_obj)

    def _process_value(self, value: Any) -> Any:
        """Process any value, handling containers recursively.

        Args:
            value: The value to process

        Returns:
            Processed value with unserializable parts replaced
        """
        # Handle datetime objects directly
        if isinstance(value, (datetime, date)):
            return value.isoformat()

        # Handle dictionaries
        elif isinstance(value, dict):
            return {k: self._process_value(v) for k, v in value.items()}

        # Handle lists
        elif isinstance(value, list):
            return [self._process_value(item) for item in value]

        # Handle all other values
        else:
            try:
                # Test if the value is JSON serializable
                json.dumps(value)
                return value
            except (TypeError, OverflowError, ValueError):
                return "<replaced>"


class Tracer:
    """Handles OpenTelemetry tracing.

    This class provides a simple interface for creating and managing traces, with support for sending to OTLP endpoints.

    When the OTEL_EXPORTER_OTLP_ENDPOINT environment variable is set, traces are sent to the OTLP endpoint.

    Both attributes are controlled by including "gen_ai_latest_experimental", "gen_ai_tool_definitions",
    or "gen_ai_use_latest_invocation_tokens", respectively, in the OTEL_SEMCONV_STABILITY_OPT_IN environment variable.

    Including "gen_ai_span_attributes_only" records message content directly as span attributes instead of
    span events, for backends that cannot read span events. This applies to the aggregated content events
    (latest-convention "gen_ai.*" messages and the "memory.query"/"memory.content" events); the legacy
    per-message events are always emitted as events. The default (token absent, non-Langfuse) emits span
    events for backward compatibility. Independent of this token, tool spans under the latest
    conventions additionally record `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` as
    span attributes per the execute_tool span convention.

    Span attribute redaction is opt-in via the `gen_ai_unredacted_attributes=<list>` token in the same
    environment variable. The list uses `;` as a separator and supports trailing-`*` glob patterns.
    When the token is absent, all attributes are emitted unredacted (backward compatible).

    Note: only a single trailing `*` is honored (e.g. `gen_ai.output.*`). A mid-string wildcard such
    as `gen_ai.*.messages` will not match anything at the moment — it is treated as an exact name.

    Sensitive attributes subject to the redaction policy are: `gen_ai.input.messages` (user messages
    and tool inputs/results being fed into the model), `gen_ai.output.messages` (agent/model responses
    and tool call responses), `gen_ai.system_instructions` (system prompts), and, on execute_tool
    spans under the latest conventions, `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`
    (tool inputs/outputs).
    """

    def __init__(self) -> None:
        """Initialize the tracer."""
        self.service_name = __name__
        self.tracer_provider: trace_api.TracerProvider | None = None
        self.tracer_provider = trace_api.get_tracer_provider()
        self.tracer = self.tracer_provider.get_tracer(self.service_name)
        ThreadingInstrumentor().instrument()

        # Read OTEL_SEMCONV_STABILITY_OPT_IN environment variable
        opt_in_values = self._parse_semconv_opt_in()
        ## To-do: should not set below attributes directly, use env var instead
        self.use_latest_genai_conventions = "gen_ai_latest_experimental" in opt_in_values
        self._include_tool_definitions = "gen_ai_tool_definitions" in opt_in_values
        self._use_latest_invocation_tokens = "gen_ai_use_latest_invocation_tokens" in opt_in_values
        self._span_attributes_only = self.is_langfuse or "gen_ai_span_attributes_only" in opt_in_values

        unredacted_token = next(
            (t for t in opt_in_values if t.startswith("gen_ai_unredacted_attributes=")),
            None,
        )
        self._redaction_enabled = unredacted_token is not None
        self._unredacted_exact, self._unredacted_globs = self._compile_unredacted_patterns(
            unredacted_token.partition("=")[2] if unredacted_token else ""
        )

    def _parse_semconv_opt_in(self) -> set[str]:
        """Parse the OTEL_SEMCONV_STABILITY_OPT_IN environment variable.

        Returns:
            A set of opt-in tokens from the environment variable.
        """
        opt_in_env = os.getenv("OTEL_SEMCONV_STABILITY_OPT_IN", "")
        return {value.strip() for value in opt_in_env.split(",")}

    @staticmethod
    def _compile_unredacted_patterns(value: str) -> tuple[frozenset[str], tuple[str, ...]]:
        """Split an unredacted-attributes value into exact names and glob prefixes.

        Globs are limited to a single trailing `*` (e.g. `gen_ai.output.*`). Empty entries are
        ignored, which is how a value like `gen_ai_unredacted_attributes=` resolves to "redact
        everything sensitive".
        """
        exact: set[str] = set()
        globs: list[str] = []
        for raw in value.split(";"):
            entry = raw.strip()
            if not entry:
                continue
            if entry.endswith("*"):
                globs.append(entry[:-1])
            else:
                exact.add(entry)
        return frozenset(exact), tuple(globs)

    def _is_attribute_unredacted(self, attribute_name: str) -> bool:
        """Return True if the attribute should be emitted as-is, False if it must be redacted."""
        if not self._redaction_enabled:
            return True
        if attribute_name in self._unredacted_exact:
            return True
        return any(attribute_name.startswith(prefix) for prefix in self._unredacted_globs)

    def _redact(self, attribute_name: str, value: str) -> str:
        """Apply the redaction policy to a single sensitive attribute value.

        Args:
            attribute_name: The canonical semantic attribute name used for policy lookup
                (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`,
                `gen_ai.tool.call.arguments`, or `gen_ai.tool.call.result`). This may differ
                from the physical event field key emitted under legacy conventions (which uses
                `content`/`message`), but the canonical name is always used so that allowlist
                entries are independent of the convention in use.
            value: The serialized attribute value to potentially redact.

        Returns:
            The original value if the attribute is unredacted, otherwise ``REDACTED_VALUE``.
        """
        if self._is_attribute_unredacted(attribute_name):
            return value
        return REDACTED_VALUE

    @property
    def is_langfuse(self) -> bool:
        """Check if Langfuse is configured as the OTLP endpoint.

        Returns:
            True if Langfuse is the OTLP endpoint, False otherwise.
        """
        return any(
            "langfuse" in os.getenv(var, "")
            for var in ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "LANGFUSE_BASE_URL")
        )

    def _start_span(
        self,
        span_name: str,
        parent_span: Span | None = None,
        attributes: dict[str, AttributeValue] | None = None,
        span_kind: trace_api.SpanKind = trace_api.SpanKind.INTERNAL,
        force_root: bool = False,
        links: list[Link] | None = None,
    ) -> Span:
        """Generic helper method to start a span with common attributes.

        Args:
            span_name: Name of the span to create
            parent_span: Optional parent span to link this span to
            attributes: Dictionary of attributes to set on the span
            span_kind: enum of OptenTelemetry SpanKind
            force_root: Start the span as a trace root, ignoring any current span.
                Use for work that runs detached from the span that scheduled it
                (e.g. background tasks whose parent span has already ended).
            links: Optional spans to link to without implying a parent-child
                timing relationship (useful for causally-related detached work).

        Returns:
            The created span, or None if tracing is not enabled
        """
        if force_root:
            # An empty context detaches the span from any (possibly ended) current span.
            context = context_api.Context()
        else:
            if not parent_span:
                parent_span = trace_api.get_current_span()

            context = None
            if parent_span and parent_span.is_recording() and parent_span != trace_api.INVALID_SPAN:
                context = trace_api.set_span_in_context(parent_span)

        span = self.tracer.start_span(name=span_name, context=context, kind=span_kind, links=links)

        # Set start time as a common attribute
        span.set_attribute("gen_ai.event.start_time", datetime.now(timezone.utc).isoformat())

        # Add all provided attributes
        if attributes:
            span.set_attributes(attributes)

        return span

    def _add_optional_usage_and_metrics_attributes(
        self, attributes: dict[str, AttributeValue], usage: Usage, metrics: Metrics
    ) -> None:
        """Add optional usage and metrics attributes if they have values.

        Args:
            attributes: Dictionary to add attributes to
            usage: Token usage information from the model call
            metrics: Metrics from the model call
        """
        if "cacheReadInputTokens" in usage:
            attributes["gen_ai.usage.cache_read.input_tokens"] = usage["cacheReadInputTokens"]
            # Deprecated pre-semconv name, dual-emitted unless opted into the latest conventions
            if not self.use_latest_genai_conventions:
                attributes["gen_ai.usage.cache_read_input_tokens"] = usage["cacheReadInputTokens"]

        if "cacheWriteInputTokens" in usage:
            attributes["gen_ai.usage.cache_creation.input_tokens"] = usage["cacheWriteInputTokens"]
            if not self.use_latest_genai_conventions:
                attributes["gen_ai.usage.cache_write_input_tokens"] = usage["cacheWriteInputTokens"]

        if metrics.get("timeToFirstByteMs", 0) > 0:
            attributes["gen_ai.server.time_to_first_token"] = metrics["timeToFirstByteMs"]

        if metrics.get("latencyMs", 0) > 0:
            attributes["gen_ai.server.request.duration"] = metrics["latencyMs"]

    def _end_span(
        self,
        span: Span,
        attributes: dict[str, AttributeValue] | None = None,
        error: Exception | None = None,
        error_message: str | None = None,
    ) -> None:
        """Generic helper method to end a span.

        Args:
            span: The span to end
            attributes: Optional attributes to set before ending the span
            error: Optional exception if an error occurred
            error_message: Optional error message to set in the span status
        """
        if not span or not span.is_recording():
            return

        try:
            # Set end time as a common attribute
            span.set_attribute("gen_ai.event.end_time", datetime.now(timezone.utc).isoformat())

            # Add any additional attributes
            if attributes:
                span.set_attributes(attributes)

            # Handle error if present
            if error:
                status_description = error_message or str(error) or type(error).__name__
                span.set_status(StatusCode.ERROR, status_description)
                span.record_exception(error)
            elif error_message:
                span.set_status(StatusCode.ERROR, error_message)
            else:
                span.set_status(StatusCode.OK)
        except Exception as e:
            logger.warning("error=<%s> | error while ending span", e, exc_info=True)
        finally:
            span.end()

    def end_span_with_error(self, span: Span, error_message: str, exception: Exception | None = None) -> None:
        """End a span with error status.

        Args:
            span: The span to end.
            error_message: Error message to set in the span status.
            exception: Optional exception to record in the span.
        """
        if not span or not span.is_recording():
            return

        error = exception or Exception(error_message)
        self._end_span(span, error=error, error_message=error_message)

    def end_span_with_cancellation(self, span: Span, cancellation: BaseException) -> None:
        """End a span that was cancelled without marking it as success or failure.

        Leaves the span status at its default UNSET (never sets OK or ERROR) and records
        the cancellation type as an attribute so trace consumers can distinguish cancellation
        from incomplete instrumentation.

        Args:
            span: The span to end.
            cancellation: The BaseException that cancelled the operation.
        """
        if not span or not span.is_recording():
            return

        try:
            span.set_attribute("gen_ai.event.end_time", datetime.now(timezone.utc).isoformat())
            span.set_attribute("strands.cancellation.type", type(cancellation).__name__)
        except Exception as exc:
            logger.warning("error=<%s> | error while ending cancelled span", exc, exc_info=True)
        finally:
            span.end()

    def _add_event(
        self, span: Span | None, event_name: str, event_attributes: Attributes, to_span_attributes: bool = False
    ) -> None:
        """Add an event with attributes to a span.

        Per OpenTelemetry the span-event recording API is deprecated. When `to_span_attributes` is set,
        the attributes are recorded directly on the span and the event is skipped, so the content is
        recorded once rather than duplicated across both; otherwise the event is emitted.

        Args:
            span: The span to add the event to
            event_name: Name of the event
            event_attributes: Dictionary of attributes to set on the event
            to_span_attributes: Record the attributes on the span instead of as an event
        """
        if not span:
            return

        if to_span_attributes:
            if event_attributes:
                span.set_attributes(event_attributes)
            return

        span.add_event(event_name, attributes=event_attributes)

    def _get_event_name_for_message(self, message: Message) -> str:
        """Determine the appropriate OpenTelemetry event name for a message.

        According to OpenTelemetry semantic conventions v1.36.0, messages containing tool results
        should be labeled as 'gen_ai.tool.message' regardless of their role field.
        This ensures proper categorization of tool responses in traces.

        Note: The GenAI namespace is experimental and may change in future versions.

        Reference: https://github.com/open-telemetry/semantic-conventions/blob/v1.36.0/docs/gen-ai/gen-ai-events.md#event-gen_aitoolmessage

        Args:
            message: The message to determine the event name for

        Returns:
            The OpenTelemetry event name (e.g., 'gen_ai.user.message', 'gen_ai.tool.message')
        """
        # Check if the message contains a tool result
        for content_block in message.get("content", []):
            if "toolResult" in content_block:
                return "gen_ai.tool.message"

        return f"gen_ai.{message['role']}.message"

    def start_model_invoke_span(
        self,
        messages: Messages,
        parent_span: Span | None = None,
        model_id: str | None = None,
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list | None = None,
        **kwargs: Any,
    ) -> Span:
        """Start a new span for a model invocation.

        Args:
            messages: Messages being sent to the model.
            parent_span: Optional parent span to link this span to.
            model_id: Optional identifier for the model being invoked.
            custom_trace_attributes: Optional mapping of custom trace attributes to include in the span.
            system_prompt: Optional system prompt string provided to the model.
            system_prompt_content: Optional list of system prompt content blocks.
            **kwargs: Additional attributes to add to the span.

        Returns:
            The created span, or None if tracing is not enabled.
        """
        attributes: dict[str, AttributeValue] = self._get_common_attributes(operation_name="chat")

        if custom_trace_attributes:
            attributes.update(custom_trace_attributes)

        if model_id:
            attributes["gen_ai.request.model"] = model_id

        # Add additional kwargs as attributes
        attributes.update({k: v for k, v in kwargs.items() if isinstance(v, (str, int, float, bool))})

        span = self._start_span("chat", parent_span, attributes=attributes, span_kind=trace_api.SpanKind.INTERNAL)
        self._add_system_prompt_event(span, system_prompt, system_prompt_content)
        self._add_event_messages(span, messages)

        return span

    def end_model_invoke_span(
        self,
        span: Span,
        message: Message,
        usage: Usage,
        metrics: Metrics,
        stop_reason: StopReason,
    ) -> None:
        """End a model invocation span with results and metrics.

        Args:
            span: The span to end.
            message: The message response from the model.
            usage: Token usage information from the model call.
            metrics: Metrics from the model call.
            stop_reason: The reason the model stopped generating.
        """
        if not span or not span.is_recording():
            return

        prompt_tokens = _total_prompt_tokens(usage)
        attributes: dict[str, AttributeValue] = {
            "gen_ai.usage.prompt_tokens": prompt_tokens,
            "gen_ai.usage.input_tokens": prompt_tokens,
            "gen_ai.usage.completion_tokens": usage["outputTokens"],
            "gen_ai.usage.output_tokens": usage["outputTokens"],
            "gen_ai.usage.total_tokens": usage["totalTokens"],
        }

        # Add optional attributes if they have values
        self._add_optional_usage_and_metrics_attributes(attributes, usage, metrics)

        if self.use_latest_genai_conventions:
            output_messages = serialize(
                [
                    {
                        "role": message["role"],
                        "parts": self._map_content_blocks_to_otel_parts(message["content"]),
                        "finish_reason": str(stop_reason),
                    }
                ]
            )
            self._add_event(
                span,
                "gen_ai.client.inference.operation.details",
                {"gen_ai.output.messages": self._redact("gen_ai.output.messages", output_messages)},
                to_span_attributes=self._span_attributes_only,
            )
        else:
            self._add_event(
                span,
                "gen_ai.choice",
                event_attributes={
                    "finish_reason": str(stop_reason),
                    "message": self._redact("gen_ai.output.messages", serialize(message["content"])),
                },
            )

        self._end_span(span, attributes)

    def start_tool_call_span(
        self,
        tool: ToolUse,
        parent_span: Span | None = None,
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
        **kwargs: Any,
    ) -> Span:
        """Start a new span for a tool call.

        Args:
            tool: The tool being used.
            parent_span: Optional parent span to link this span to.
            custom_trace_attributes: Optional mapping of custom trace attributes to include in the span.
            **kwargs: Additional attributes to add to the span.

        Returns:
            The created span, or None if tracing is not enabled.
        """
        attributes: dict[str, AttributeValue] = self._get_common_attributes(operation_name="execute_tool")
        attributes.update(
            {
                "gen_ai.tool.name": tool["name"],
                "gen_ai.tool.call.id": tool["toolUseId"],
            }
        )

        if custom_trace_attributes:
            attributes.update(custom_trace_attributes)
        # Add additional kwargs as attributes
        attributes.update(kwargs)

        span_name = f"execute_tool {tool['name']}"
        span = self._start_span(span_name, parent_span, attributes=attributes, span_kind=trace_api.SpanKind.INTERNAL)

        if self.use_latest_genai_conventions:
            # The execute_tool span convention records tool inputs in the dedicated
            # gen_ai.tool.call.arguments span attribute (Opt-In), which spec-compliant
            # consumers read on tool spans.
            span.set_attribute(
                "gen_ai.tool.call.arguments",
                self._redact("gen_ai.tool.call.arguments", serialize(tool["input"])),
            )
            input_messages = serialize(
                [
                    {
                        "role": "tool",
                        "parts": [
                            {
                                "type": "tool_call",
                                "name": tool["name"],
                                "id": tool["toolUseId"],
                                "arguments": tool["input"],
                            }
                        ],
                    }
                ]
            )
            self._add_event(
                span,
                "gen_ai.client.inference.operation.details",
                {"gen_ai.input.messages": self._redact("gen_ai.input.messages", input_messages)},
                to_span_attributes=self._span_attributes_only,
            )
        else:
            self._add_event(
                span,
                "gen_ai.tool.message",
                event_attributes={
                    "role": "tool",
                    "content": self._redact("gen_ai.input.messages", serialize(tool["input"])),
                    "id": tool["toolUseId"],
                },
            )

        return span

    def end_tool_call_span(self, span: Span, tool_result: ToolResult | None, error: Exception | None = None) -> None:
        """End a tool call span with results.

        Args:
            span: The span to end.
            tool_result: The result from the tool execution.
            error: Optional exception if the tool call failed.
        """
        attributes: dict[str, AttributeValue] = {}
        status: str | None = None
        content: list[Any] = []

        if tool_result is not None:
            status = tool_result.get("status")
            content = tool_result.get("content", [])
            attributes["gen_ai.tool.status"] = str(status) if status is not None else ""

            if self.use_latest_genai_conventions:
                # The execute_tool span convention records tool outputs in the dedicated
                # gen_ai.tool.call.result span attribute (Opt-In), which spec-compliant
                # consumers read on tool spans. The spec scopes the attribute to successful
                # executions; failures are captured in the span status instead.
                if status != "error":
                    attributes["gen_ai.tool.call.result"] = self._redact("gen_ai.tool.call.result", serialize(content))
                output_messages = serialize(
                    [
                        {
                            "role": "tool",
                            "parts": [
                                {
                                    "type": "tool_call_response",
                                    "id": tool_result.get("toolUseId", ""),
                                    "response": content,
                                }
                            ],
                        }
                    ]
                )
                self._add_event(
                    span,
                    "gen_ai.client.inference.operation.details",
                    {"gen_ai.output.messages": self._redact("gen_ai.output.messages", output_messages)},
                    to_span_attributes=self._span_attributes_only,
                )
            else:
                self._add_event(
                    span,
                    "gen_ai.choice",
                    event_attributes={
                        "message": self._redact("gen_ai.output.messages", serialize(content)),
                        "id": tool_result.get("toolUseId", ""),
                    },
                )

        if error is None and status == "error":
            error_message = next((b["text"] for b in content if "text" in b), "tool returned error status")
            self._end_span(span, attributes, error_message=error_message)
        else:
            self._end_span(span, attributes, error)

    def start_event_loop_cycle_span(
        self,
        invocation_state: Any,
        messages: Messages,
        parent_span: Span | None = None,
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
        **kwargs: Any,
    ) -> Span:
        """Start a new span for an event loop cycle.

        Args:
            invocation_state: Arguments for the event loop cycle.
            parent_span: Optional parent span to link this span to.
            messages:  Messages being processed in this cycle.
            custom_trace_attributes: Optional mapping of custom trace attributes to include in the span.
            **kwargs: Additional attributes to add to the span.

        Returns:
            The created span, or None if tracing is not enabled.
        """
        event_loop_cycle_id = str(invocation_state.get("event_loop_cycle_id"))
        parent_span = parent_span if parent_span else invocation_state.get("event_loop_parent_span")

        attributes: dict[str, AttributeValue] = self._get_common_attributes(operation_name="execute_event_loop_cycle")
        attributes["event_loop.cycle_id"] = event_loop_cycle_id

        if custom_trace_attributes:
            attributes.update(custom_trace_attributes)

        if "event_loop_parent_cycle_id" in invocation_state:
            attributes["event_loop.parent_cycle_id"] = str(invocation_state["event_loop_parent_cycle_id"])

        # Add additional kwargs as attributes
        attributes.update({k: v for k, v in kwargs.items() if isinstance(v, (str, int, float, bool))})

        span_name = "execute_event_loop_cycle"
        span = self._start_span(span_name, parent_span, attributes)
        self._add_event_messages(span, messages)

        return span

    def end_event_loop_cycle_span(
        self,
        span: Span,
        message: Message,
        tool_result_message: Message | None = None,
    ) -> None:
        """End an event loop cycle span with results.

        Args:
            span: The span to end.
            message: The message response from this cycle.
            tool_result_message: Optional tool result message if a tool was called.
        """
        if not span or not span.is_recording():
            return

        event_attributes: dict[str, AttributeValue] = {
            "message": self._redact("gen_ai.output.messages", serialize(message["content"])),
        }

        if tool_result_message:
            # tool results are conceptually fed back to the model as input, so they are
            # policied under gen_ai.input.messages even when the emitted attribute key differs
            event_attributes["tool.result"] = self._redact(
                "gen_ai.input.messages", serialize(tool_result_message["content"])
            )

            if self.use_latest_genai_conventions:
                tool_result_messages = serialize(
                    [
                        {
                            "role": tool_result_message["role"],
                            "parts": self._map_content_blocks_to_otel_parts(tool_result_message["content"]),
                        }
                    ]
                )
                self._add_event(
                    span,
                    "gen_ai.client.inference.operation.details",
                    {"gen_ai.input.messages": self._redact("gen_ai.input.messages", tool_result_messages)},
                    to_span_attributes=self._span_attributes_only,
                )
            else:
                self._add_event(span, "gen_ai.choice", event_attributes=event_attributes)

        self._end_span(span)

    def start_agent_span(
        self,
        messages: Messages,
        agent_name: str,
        model_id: str | None = None,
        tools: list | None = None,
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
        tools_config: dict | None = None,
        system_prompt: str | None = None,
        system_prompt_content: list | None = None,
        **kwargs: Any,
    ) -> Span:
        """Start a new span for an agent invocation.

        Args:
            messages: List of messages being sent to the agent.
            agent_name: Name of the agent.
            model_id: Optional model identifier.
            tools: Optional list of tools being used.
            custom_trace_attributes: Optional mapping of custom trace attributes to include in the span.
            tools_config: Optional dictionary of tool configurations.
            system_prompt: Optional system prompt string.
            system_prompt_content: Optional list of system prompt content blocks.
            **kwargs: Additional attributes to add to the span.

        Returns:
            The created span, or None if tracing is not enabled.
        """
        attributes: dict[str, AttributeValue] = self._get_common_attributes(operation_name="invoke_agent")
        attributes.update(
            {
                "gen_ai.agent.name": agent_name,
            }
        )

        if model_id:
            attributes["gen_ai.request.model"] = model_id

        if tools:
            attributes["gen_ai.agent.tools"] = serialize(tools)

        if self._include_tool_definitions and tools_config:
            try:
                tool_definitions = self._construct_tool_definitions(tools_config)
                attributes["gen_ai.tool.definitions"] = serialize(tool_definitions)
            except Exception:
                # A failure in telemetry should not crash the agent
                logger.warning("failed to attach tool metadata to agent span", exc_info=True)

        # Add custom trace attributes if provided
        if custom_trace_attributes:
            attributes.update(custom_trace_attributes)

        # Add additional kwargs as attributes
        attributes.update({k: v for k, v in kwargs.items() if isinstance(v, (str, int, float, bool))})

        if self.use_latest_genai_conventions and (system_prompt is not None or system_prompt_content is not None):
            attributes["gen_ai.system_instructions"] = self._redact(
                "gen_ai.system_instructions",
                self._serialized_system_instructions(system_prompt, system_prompt_content),
            )

        span = self._start_span(
            f"invoke_agent {agent_name}", attributes=attributes, span_kind=trace_api.SpanKind.INTERNAL
        )
        if not self.use_latest_genai_conventions:
            self._add_system_prompt_event(span, system_prompt, system_prompt_content)
        self._add_event_messages(span, messages)

        return span

    def end_agent_span(
        self,
        span: Span,
        response: AgentResult | None = None,
        error: Exception | None = None,
    ) -> None:
        """End an agent span with results and metrics.

        Args:
            span: The span to end.
            response: The response from the agent.
            error: Any error that occurred.
        """
        attributes: dict[str, AttributeValue] = {}

        if response:
            if self.use_latest_genai_conventions:
                output_messages = serialize(
                    [
                        {
                            "role": "assistant",
                            "parts": [{"type": "text", "content": str(response)}],
                            "finish_reason": str(response.stop_reason),
                        }
                    ]
                )
                self._add_event(
                    span,
                    "gen_ai.client.inference.operation.details",
                    {"gen_ai.output.messages": self._redact("gen_ai.output.messages", output_messages)},
                    to_span_attributes=self._span_attributes_only,
                )
            else:
                self._add_event(
                    span,
                    "gen_ai.choice",
                    event_attributes={
                        "message": self._redact("gen_ai.output.messages", str(response)),
                        "finish_reason": str(response.stop_reason),
                    },
                )

            if hasattr(response, "metrics") and hasattr(response.metrics, "accumulated_usage"):
                if self.is_langfuse:
                    attributes.update({"langfuse.observation.type": "span"})
                if self._use_latest_invocation_tokens:
                    latest_invocation = response.metrics.latest_agent_invocation
                    if latest_invocation is None:
                        logger.warning(
                            "latest_agent_invocation is None despite _use_latest_invocation_tokens being set"
                        )
                        usage: Usage = Usage(inputTokens=0, outputTokens=0, totalTokens=0)
                    else:
                        usage = latest_invocation.usage
                else:
                    usage = response.metrics.accumulated_usage
                prompt_tokens = _total_prompt_tokens(usage)
                attributes.update(
                    {
                        "gen_ai.usage.prompt_tokens": prompt_tokens,
                        "gen_ai.usage.completion_tokens": usage["outputTokens"],
                        "gen_ai.usage.input_tokens": prompt_tokens,
                        "gen_ai.usage.output_tokens": usage["outputTokens"],
                        "gen_ai.usage.total_tokens": usage["totalTokens"],
                        "gen_ai.usage.cache_read.input_tokens": usage.get("cacheReadInputTokens", 0),
                        "gen_ai.usage.cache_creation.input_tokens": usage.get("cacheWriteInputTokens", 0),
                    }
                )
                # Deprecated pre-semconv name, dual-emitted unless opted into the latest conventions
                if not self.use_latest_genai_conventions:
                    attributes.update(
                        {
                            "gen_ai.usage.cache_read_input_tokens": usage.get("cacheReadInputTokens", 0),
                            "gen_ai.usage.cache_write_input_tokens": usage.get("cacheWriteInputTokens", 0),
                        }
                    )

        self._end_span(span, attributes, error)

    def _construct_tool_definitions(self, tools_config: dict) -> list[dict[str, Any]]:
        """Constructs a list of tool definitions from the provided tools_config."""
        return [
            {
                "name": name,
                "description": spec.get("description"),
                "inputSchema": spec.get("inputSchema"),
                "outputSchema": spec.get("outputSchema"),
            }
            for name, spec in tools_config.items()
        ]

    def start_multiagent_span(
        self,
        task: MultiAgentInput,
        instance: str,
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
    ) -> Span:
        """Start a new span for swarm invocation."""
        operation = f"invoke_{instance}"
        attributes: dict[str, AttributeValue] = self._get_common_attributes(operation)

        if custom_trace_attributes:
            attributes.update(custom_trace_attributes)

        span = self._start_span(operation, attributes=attributes, span_kind=trace_api.SpanKind.CLIENT)

        if self.use_latest_genai_conventions:
            parts: list[dict[str, Any]] = []
            if isinstance(task, list):
                parts = self._map_content_blocks_to_otel_parts(task)
            else:
                parts = [{"type": "text", "content": task}]
            input_messages = serialize([{"role": "user", "parts": parts}])
            self._add_event(
                span,
                "gen_ai.client.inference.operation.details",
                {"gen_ai.input.messages": self._redact("gen_ai.input.messages", input_messages)},
                to_span_attributes=self._span_attributes_only,
            )
        else:
            content_value = serialize(task) if isinstance(task, list) else task
            self._add_event(
                span,
                "gen_ai.user.message",
                event_attributes={"content": self._redact("gen_ai.input.messages", content_value)},
            )

        return span

    def end_swarm_span(
        self,
        span: Span,
        result: str | None = None,
    ) -> None:
        """End a swarm span with results."""
        if result:
            if self.use_latest_genai_conventions:
                output_messages = serialize(
                    [
                        {
                            "role": "assistant",
                            "parts": [{"type": "text", "content": result}],
                        }
                    ]
                )
                self._add_event(
                    span,
                    "gen_ai.client.inference.operation.details",
                    {"gen_ai.output.messages": self._redact("gen_ai.output.messages", output_messages)},
                    to_span_attributes=self._span_attributes_only,
                )
            else:
                self._add_event(
                    span,
                    "gen_ai.choice",
                    event_attributes={"message": self._redact("gen_ai.output.messages", result)},
                )

    def _build_memory_span_attributes(
        self,
        operation_name: str,
        memory_attributes: dict[str, AttributeValue],
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
        extra_kwargs: dict[str, Any] | None = None,
    ) -> dict[str, AttributeValue]:
        """Assemble span attributes for a memory operation.

        Combines the common GenAI attributes for ``operation_name`` with the
        operation's own attributes, any caller-supplied custom trace attributes,
        and scalar ``**kwargs`` forwarded by the public span methods.

        Args:
            operation_name: The ``gen_ai.operation.name`` value for this span. Memory
                operations use a ``memory.*`` namespace (``memory.search`` etc.) rather
                than a standard GenAI operation, since they are SDK-internal and have no
                OpenTelemetry GenAI equivalent.
            memory_attributes: Attributes specific to this memory operation.
            custom_trace_attributes: Optional caller-supplied trace attributes.
            extra_kwargs: Optional forwarded kwargs; only scalar values (str/int/float/bool)
                are kept, since OpenTelemetry attributes must be scalars; non-scalar values
                are dropped.

        Returns:
            The merged attribute dictionary.
        """
        attributes: dict[str, AttributeValue] = self._get_common_attributes(operation_name=operation_name)
        attributes.update(memory_attributes)
        if custom_trace_attributes:
            attributes.update(custom_trace_attributes)
        if extra_kwargs:
            attributes.update({k: v for k, v in extra_kwargs.items() if isinstance(v, (str, int, float, bool))})
        return attributes

    def start_memory_search_span(
        self,
        query: str,
        store_names: list[str],
        max_search_results: int | None = None,
        parent_span: Span | None = None,
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
        **kwargs: Any,
    ) -> Span:
        """Start a new span for a memory search.

        The query is recorded verbatim as a span event, consistent with how model and
        tool spans record their inputs. Memory payloads may contain user PII; suppress
        span content at the exporter or processor when that is a concern.

        Args:
            query: The search query.
            store_names: Names of the stores being searched.
            max_search_results: Optional cap on results per store.
            parent_span: Optional parent span to link this span to.
            custom_trace_attributes: Optional mapping of custom trace attributes to include in the span.
            **kwargs: Additional attributes to add to the span.

        Returns:
            The created span.
        """
        memory_attributes: dict[str, AttributeValue] = {
            "memory.store.names": serialize(store_names),
            "memory.store.count": len(store_names),
        }
        if max_search_results is not None:
            memory_attributes["memory.max_search_results"] = max_search_results
        attributes = self._build_memory_span_attributes(
            "memory.search", memory_attributes, custom_trace_attributes, kwargs
        )

        span = self._start_span("memory.search", parent_span, attributes=attributes)
        self._add_event(span, "memory.query", {"content": query}, to_span_attributes=self._span_attributes_only)

        return span

    def end_memory_search_span(
        self,
        span: Span,
        entries: "list[MemoryEntry] | None" = None,
        store_failure_count: int = 0,
        error: Exception | None = None,
    ) -> None:
        """End a memory search span with results.

        Args:
            span: The span to end.
            entries: The retrieved memory entries (each with ``content``, ``store_name``, ``metadata``).
            store_failure_count: Number of stores whose search raised (logged and skipped).
            error: Optional exception if the search failed outright.
        """
        if not span or not span.is_recording():
            return

        results = entries if entries is not None else []
        attributes: dict[str, AttributeValue] = {
            "memory.result.count": len(results),
            "memory.store.failure_count": store_failure_count,
        }

        if error is None:
            self._add_event(
                span,
                "memory.results",
                {
                    "content": serialize(
                        [
                            {
                                "content": entry.content,
                                "store_name": entry.store_name,
                                "metadata": entry.metadata,
                            }
                            for entry in results
                        ]
                    )
                },
                to_span_attributes=self._span_attributes_only,
            )

        self._end_span(span, attributes, error)

    def start_memory_add_span(
        self,
        content: str,
        store_names: list[str],
        parent_span: Span | None = None,
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
        force_root: bool = False,
        **kwargs: Any,
    ) -> Span:
        """Start a new span for a memory add.

        The content is recorded verbatim as a span event, consistent with how model and
        tool spans record their inputs. Memory payloads may contain user PII; suppress
        span content at the exporter or processor when that is a concern.

        Args:
            content: The content being written.
            store_names: Names of the writable stores being targeted.
            parent_span: Optional parent span to link this span to.
            custom_trace_attributes: Optional mapping of custom trace attributes to include in the span.
            force_root: Start the span as a trace root (for detached fire-and-forget writes).
            **kwargs: Additional attributes to add to the span.

        Returns:
            The created span.
        """
        memory_attributes: dict[str, AttributeValue] = {
            "memory.store.names": serialize(store_names),
            "memory.store.count": len(store_names),
        }
        attributes = self._build_memory_span_attributes(
            "memory.add", memory_attributes, custom_trace_attributes, kwargs
        )

        span = self._start_span("memory.add", parent_span, attributes=attributes, force_root=force_root)
        self._add_event(span, "memory.content", {"content": content}, to_span_attributes=self._span_attributes_only)

        return span

    def end_memory_add_span(
        self,
        span: Span,
        store_failure_count: int = 0,
        error: Exception | None = None,
    ) -> None:
        """End a memory add span.

        Args:
            span: The span to end.
            store_failure_count: Number of targeted stores whose write failed.
            error: Optional exception if the add failed.
        """
        if not span or not span.is_recording():
            return

        attributes: dict[str, AttributeValue] = {"memory.store.failure_count": store_failure_count}
        self._end_span(span, attributes, error)

    def start_memory_inject_span(
        self,
        max_entries: int | None = None,
        parent_span: Span | None = None,
        custom_trace_attributes: Mapping[str, AttributeValue] | None = None,
        **kwargs: Any,
    ) -> Span:
        """Start a new span for memory context injection.

        Args:
            max_entries: Optional cap on entries injected for this model call.
            parent_span: Optional parent span to link this span to.
            custom_trace_attributes: Optional mapping of custom trace attributes to include in the span.
            **kwargs: Additional attributes to add to the span.

        Returns:
            The created span.
        """
        memory_attributes: dict[str, AttributeValue] = {}
        if max_entries is not None:
            memory_attributes["memory.max_entries"] = max_entries
        attributes = self._build_memory_span_attributes(
            "memory.inject", memory_attributes, custom_trace_attributes, kwargs
        )

        return self._start_span("memory.inject", parent_span, attributes=attributes)

    def end_memory_inject_span(
        self,
        span: Span,
        injected: bool,
        entry_count: int = 0,
        format_error: bool = False,
    ) -> None:
        """End a memory injection span.

        Injection fails open, so a format failure ends the span OK with a flag
        rather than an error status (the agent did not fail).

        Args:
            span: The span to end.
            injected: Whether memory context was injected for this model call.
            entry_count: Number of entries injected.
            format_error: Whether the format callback raised (injection skipped).
        """
        if not span or not span.is_recording():
            return

        attributes: dict[str, AttributeValue] = {
            "memory.injected": injected,
            "memory.entry.count": entry_count,
        }
        if format_error:
            attributes["memory.inject.format_error"] = True

        self._end_span(span, attributes)

    def start_memory_extract_span(
        self,
        store_name: str,
        message_count: int,
        filtered_count: int = 0,
        extractor: str | None = None,
        agent_span_context: SpanContext | None = None,
        **kwargs: Any,
    ) -> Span:
        """Start a new root span for a background memory extraction.

        Extraction runs detached from the agent invocation that scheduled it (the
        agent span has typically ended by the time the save runs), so the span is
        a trace root, optionally linked back to the agent span for causality.

        Args:
            store_name: Name of the store being saved to.
            message_count: Number of messages written, i.e. after the message filter ran
                (recorded as ``memory.message.count``). The pre-filter input count is
                ``message_count + filtered_count``.
            filtered_count: Number of messages dropped by the message filter.
            extractor: The extractor class name, or None for the ``add_messages`` path.
            agent_span_context: Optional span context of the agent run that scheduled
                this extraction, attached as a link.
            **kwargs: Additional attributes to add to the span.

        Returns:
            The created span.
        """
        memory_attributes: dict[str, AttributeValue] = {
            "memory.store.name": store_name,
            "memory.message.count": message_count,
            "memory.message.filtered_count": filtered_count,
        }
        if extractor is not None:
            memory_attributes["memory.extractor"] = extractor

        # The extract span is a detached root, so its OTel parent is empty. Record the scheduling
        # agent run's ids as plain attributes (in addition to the link below) so backends that don't
        # render span links can still trace the extraction back to the run that triggered it.
        links = None
        if agent_span_context is not None and agent_span_context.is_valid:
            memory_attributes["memory.parent.trace_id"] = trace_api.format_trace_id(agent_span_context.trace_id)
            memory_attributes["memory.parent.span_id"] = trace_api.format_span_id(agent_span_context.span_id)
            links = [Link(agent_span_context)]

        attributes = self._build_memory_span_attributes("memory.extract", memory_attributes, extra_kwargs=kwargs)

        return self._start_span("memory.extract", attributes=attributes, force_root=True, links=links)

    def end_memory_extract_span(
        self,
        span: Span,
        entry_count: int | None = None,
        error: Exception | None = None,
    ) -> None:
        """End a memory extraction span.

        Args:
            span: The span to end.
            entry_count: Number of entries written to the store.
            error: Optional exception if the extraction failed (saving never raises;
                failures are recorded here and swallowed by the coordinator).
        """
        if not span or not span.is_recording():
            return

        attributes: dict[str, AttributeValue] = {}
        if entry_count is not None:
            attributes["memory.entry.count"] = entry_count

        self._end_span(span, attributes, error)

    def _get_common_attributes(
        self,
        operation_name: str,
    ) -> dict[str, AttributeValue]:
        """Returns a dictionary of common attributes based on the convention version used.

        Args:
            operation_name: The name of the operation.

        Returns:
            A dictionary of attributes following the appropriate GenAI conventions.
        """
        common_attributes = {"gen_ai.operation.name": operation_name}
        if self.use_latest_genai_conventions:
            common_attributes.update(
                {
                    "gen_ai.provider.name": "strands-agents",
                }
            )
        else:
            common_attributes.update(
                {
                    "gen_ai.system": "strands-agents",
                }
            )
        return dict(common_attributes)

    def _add_system_prompt_event(
        self,
        span: Span,
        system_prompt: str | None = None,
        system_prompt_content: list | None = None,
    ) -> None:
        """Emit system prompt as a span event per OTel GenAI semantic conventions.

        In legacy mode (v1.36), emits a ``gen_ai.system.message`` event.
        In latest experimental mode, emits ``gen_ai.system_instructions`` on the
        ``gen_ai.client.inference.operation.details`` event, since Strands passes
        system instructions separately from chat history.

        Args:
            span: The span to add the event to.
            system_prompt: Optional system prompt string.
            system_prompt_content: Optional list of system prompt content blocks.
        """
        if system_prompt is None and system_prompt_content is None:
            return

        if self.use_latest_genai_conventions:
            # system prompts are sensitive and policed under gen_ai.system_instructions
            self._add_event(
                span,
                "gen_ai.client.inference.operation.details",
                {
                    "gen_ai.system_instructions": self._redact(
                        "gen_ai.system_instructions",
                        self._serialized_system_instructions(system_prompt, system_prompt_content),
                    )
                },
                to_span_attributes=self._span_attributes_only,
            )
        else:
            # system prompts are sensitive and policed under gen_ai.system_instructions
            self._add_event(
                span,
                "gen_ai.system.message",
                {
                    "content": self._redact(
                        "gen_ai.system_instructions",
                        serialize(self._system_prompt_content_blocks(system_prompt, system_prompt_content)),
                    )
                },
            )

    def _system_prompt_content_blocks(
        self, system_prompt: str | None, system_prompt_content: list | None
    ) -> list[ContentBlock]:
        """Return system prompt content blocks, preferring structured content."""
        return system_prompt_content if system_prompt_content else [{"text": system_prompt or ""}]

    def _serialized_system_instructions(self, system_prompt: str | None, system_prompt_content: list | None) -> str:
        """Serialize system prompt content using the latest semantic-convention format."""
        content_blocks = self._system_prompt_content_blocks(system_prompt, system_prompt_content)
        return serialize(self._map_content_blocks_to_otel_parts(content_blocks))

    def _add_event_messages(self, span: Span, messages: Messages) -> None:
        """Adds messages as event to the provided span based on the current GenAI conventions.

        Args:
            span: The span to which events will be added.
            messages: List of messages being sent to the agent.
        """
        if self.use_latest_genai_conventions:
            input_messages: list = []
            for message in messages:
                input_messages.append(
                    {"role": message["role"], "parts": self._map_content_blocks_to_otel_parts(message["content"])}
                )
            self._add_event(
                span,
                "gen_ai.client.inference.operation.details",
                {"gen_ai.input.messages": self._redact("gen_ai.input.messages", serialize(input_messages))},
                to_span_attributes=self._span_attributes_only,
            )
        else:
            for message in messages:
                redact_key = "gen_ai.output.messages" if message.get("role") == "assistant" else "gen_ai.input.messages"
                self._add_event(
                    span,
                    self._get_event_name_for_message(message),
                    {"content": self._redact(redact_key, serialize(message["content"]))},
                )

    def _map_content_blocks_to_otel_parts(
        self, content_blocks: list[ContentBlock] | list[InterruptResponseContent]
    ) -> list[dict[str, Any]]:
        """Map content blocks to OpenTelemetry parts format."""
        parts: list[dict[str, Any]] = []

        for block in cast(list[dict[str, Any]], content_blocks):
            if "interruptResponse" in block:
                interrupt_response = block["interruptResponse"]
                parts.append(
                    {
                        "type": "interrupt_response",
                        "id": interrupt_response["interruptId"],
                        "response": interrupt_response["response"],
                    },
                )
            elif "text" in block:
                # Standard TextPart
                parts.append({"type": "text", "content": block["text"]})
            elif "toolUse" in block:
                # Standard ToolCallRequestPart
                tool_use = block["toolUse"]
                parts.append(
                    {
                        "type": "tool_call",
                        "name": tool_use["name"],
                        "id": tool_use["toolUseId"],
                        "arguments": tool_use["input"],
                    }
                )
            elif "toolResult" in block:
                # Standard ToolCallResponsePart
                tool_result = block["toolResult"]
                parts.append(
                    {
                        "type": "tool_call_response",
                        "id": tool_result["toolUseId"],
                        "response": tool_result["content"],
                    }
                )
            else:
                # For all other ContentBlock types, use the key as type and value as content
                for key, value in block.items():
                    parts.append({"type": key, "content": value})
        return parts


# Singleton instance for global access
_tracer_instance = None


def get_tracer() -> Tracer:
    """Get or create the global tracer.

    Returns:
        The global tracer instance.
    """
    global _tracer_instance

    if not _tracer_instance:
        _tracer_instance = Tracer()

    return _tracer_instance


def serialize(obj: Any) -> str:
    """Serialize an object to JSON with consistent settings.

    Args:
        obj: The object to serialize

    Returns:
        JSON string representation of the object
    """
    return json.dumps(obj, ensure_ascii=False, cls=JSONEncoder)
