"""Cedar authorization intervention handler."""

from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime as dt
from datetime import timezone
from typing import TYPE_CHECKING, Any

import cedarpy

from ...hooks.events import BeforeToolCallEvent
from ...interventions.actions import Deny, Proceed
from ...interventions.handler import InterventionHandler, OnError
from ._file_loaders import load_entities, load_policies, load_schema
from ._schema_generator import ToolDefinition, generate_cedar_schema

if TYPE_CHECKING:
    from ...agent.agent import Agent

TypeAndId = dict[str, str]
"""A Cedar entity identifier with 'type' and 'id' keys."""

PrincipalResolver = Callable[[dict[str, Any]], TypeAndId | None]
"""Resolves a principal from invocation_state. Return None to deny (fail-closed)."""

ContextEnricher = Callable[[dict[str, Any]], dict[str, Any]]
"""Injects extra fields into context.session. Receives {'tool_name', 'tool_input', 'invocation_state'}."""

_STATE_KEY = "cedar-authorization"


def _validate_policies(policies: str, schema: str | None, auto_generated: bool = False) -> None:
    """Validate Cedar policies: parse check, then optional schema validation.

    Two-step validation:
    1. Parse check — verifies syntax (raises on malformed policies)
    2. Schema validation — checks policies reference valid actions/types

    Raises:
        ValueError: If policies cannot be parsed or fail schema validation.
    """
    try:
        cedarpy.format_policies(policies)
    except ValueError as e:
        raise ValueError(f"Invalid Cedar policy: {e}") from e

    if schema:
        result = cedarpy.validate_policies(policies, schema)
        if not result.validation_passed and result.errors:
            errors = result.errors
            if auto_generated:
                # Auto-generated schemas only describe tool input shapes, not the handler-injected
                # session context. Non-action errors (e.g. unknown context attributes) are expected
                # and safe to suppress — only surface errors about actions the policy references
                # that don't exist in the schema (typos in tool names).
                errors = [
                    e
                    for e in errors
                    if "unrecognized action" in e.error or "unable to find an applicable action" in e.error
                ]
            if errors:
                msg = ", ".join(f"{e.policy_id}: {e.error}" for e in errors)
                raise ValueError(f"Cedar policy validation failed: {msg}")


def _has_quotes(value: str) -> bool:
    return '"' in value


class CedarAuthorization(InterventionHandler):
    """Cedar authorization intervention handler.

    Evaluates Cedar policies before each tool call. Each tool maps to a Cedar action,
    with context structured as ``{input: <tool_args>, session: {hour_utc, call_count, ...}}``.

    Call counts are persisted to ``agent.state`` under the key ``"cedar-authorization"``
    so they survive handler recreation and are included in session snapshots.

    .. note::
        Each handler instance is scoped to a single agent. Sharing one instance across
        multiple agents will cause rate-limit counts to leak between them.

    Example::

        cedar = CedarAuthorization(
            policies='permit(principal, action == Action::"search", resource);'
        )
        agent = Agent(interventions=[cedar], tools=[search_tool])
    """

    name = "cedar-authorization"

    @property
    def on_error(self) -> OnError:
        """What to do when this handler throws."""
        return self._on_error

    def __init__(
        self,
        *,
        policies: str,
        tools: list[ToolDefinition] | None = None,
        entities: list[dict[str, Any]] | str | None = None,
        schema: str | None = None,
        namespace: str | None = None,
        principal: TypeAndId | None = None,
        principal_resolver: PrincipalResolver | None = None,
        context_enricher: ContextEnricher | None = None,
        on_error: OnError = "throw",
    ) -> None:
        """Initialize the Cedar authorization handler.

        Args:
            policies: Inline Cedar policy text or path to a .cedar file.
            tools: MCP tool definitions for auto schema generation.
            entities: Entity data as inline list, JSON string, or path to .json file.
            schema: Cedar schema as inline text or path to .cedarschema file.
            namespace: Cedar namespace for actions, resources, and the default principal.
            principal: Static principal identity.
            principal_resolver: Dynamic principal resolver from invocation_state.
            context_enricher: Callback to inject extra fields into context.session.
            on_error: Error handling mode for user callback exceptions.
        """
        if principal and principal_resolver:
            raise ValueError("Provide either `principal` or `principal_resolver`, not both")
        if namespace and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", namespace):
            raise ValueError(
                f"Namespace must be a single Cedar identifier, got {namespace!r}. "
                "Multi-segment namespaces (e.g. 'Org::App') are not supported."
            )

        self._policy_source = policies
        self._entity_source = entities
        self._schema_source = schema
        self._tools = tools
        self._namespace = namespace
        self._on_error = on_error
        self._action_type = f"{namespace}::Action" if namespace else "Action"
        self._resource_type = f"{namespace}::Resource" if namespace else "Resource"
        self._resource_id = "default" if namespace else "agent"

        self._policies = load_policies(policies)
        self._entities = load_entities(entities)

        schema_is_auto_generated = False
        if schema:
            self._schema = load_schema(schema)
        elif tools:
            self._schema = generate_cedar_schema(tools, namespace)
            schema_is_auto_generated = True
        else:
            self._schema = None

        if principal_resolver:
            self._principal: TypeAndId | None = None
        else:
            self._principal = principal or {
                "type": f"{namespace}::User" if namespace else "User",
                "id": "anonymous",
            }

        self._principal_resolver = principal_resolver
        self._context_enricher = context_enricher
        self._call_counts: dict[str, int] = {}

        _validate_policies(self._policies, self._schema, schema_is_auto_generated)

    def before_tool_call(self, event: BeforeToolCallEvent, **kwargs: Any) -> Proceed | Deny:
        """Evaluate Cedar policy before tool execution."""
        invocation_state = event.invocation_state

        if self._principal_resolver:
            principal = self._principal_resolver(invocation_state)
        else:
            principal = self._principal

        if not principal or not principal.get("type") or not principal.get("id"):
            return Deny(reason="No principal identity found in invocation state")

        if _has_quotes(principal["id"]) or _has_quotes(principal["type"]):
            return Deny(reason="Principal type/id must not contain double quotes")

        tool_name = event.tool_use["name"]

        if _has_quotes(tool_name):
            return Deny(reason="Tool name must not contain double quotes")

        call_count = self._increment_call_count(event.agent, tool_name)
        tool_input = event.tool_use.get("input") or {}

        enricher_fields: dict[str, Any] = {}
        if self._context_enricher:
            enricher_fields = self._context_enricher(
                {"tool_name": tool_name, "tool_input": tool_input, "invocation_state": invocation_state}
            )

        context = {
            "input": tool_input,
            "session": {
                **enricher_fields,
                "hour_utc": dt.now(timezone.utc).hour,
                "call_count": call_count,
            },
        }

        request = {
            "principal": f'{principal["type"]}::"{principal["id"]}"',
            "action": f'{self._action_type}::"{tool_name}"',
            "resource": f'{self._resource_type}::"{self._resource_id}"',
            "context": context,
        }

        try:
            result = cedarpy.is_authorized(request, self._policies, self._entities, self._schema)
        except Exception as e:
            self._decrement_call_count(event.agent, tool_name)
            return Deny(reason=f"Cedar evaluation failed: {e}")

        if result.decision == cedarpy.Decision.NoDecision:
            self._decrement_call_count(event.agent, tool_name)
            errors = (
                [e.error if hasattr(e, "error") else str(e) for e in result.diagnostics.errors]
                if result.diagnostics.errors
                else []
            )
            error_detail = ": " + ", ".join(errors) if errors else ""
            return Deny(reason=f"Cedar evaluation failed{error_detail}")

        if not result.allowed:
            self._decrement_call_count(event.agent, tool_name)
            reasons = list(result.diagnostics.reasons) if result.diagnostics.reasons else []
            errors = (
                [e.error if hasattr(e, "error") else str(e) for e in result.diagnostics.errors]
                if result.diagnostics.errors
                else []
            )
            details = [d for d in reasons + errors if d]
            suffix = f": {', '.join(details)}" if details else ""
            return Deny(reason=f"Access denied by Cedar policy{suffix}")

        return Proceed()

    def reload(self) -> None:
        """Reload policies/entities/schema from disk. Validates before committing."""
        policies = load_policies(self._policy_source)
        entities = load_entities(self._entity_source)

        schema_is_auto_generated = False
        if self._schema_source:
            schema = load_schema(self._schema_source)
        elif self._tools:
            schema = generate_cedar_schema(self._tools, self._namespace)
            schema_is_auto_generated = True
        else:
            schema = None

        _validate_policies(policies, schema, schema_is_auto_generated)

        self._policies = policies
        self._entities = entities
        self._schema = schema

    def reset_call_counts(self, agent: Agent | None = None) -> None:
        """Clear all rate-limit call counters.

        Args:
            agent: If provided, also clears persisted counts from agent.state.
        """
        self._call_counts.clear()
        if agent is not None:
            agent.state.set(_STATE_KEY, {})

    def _increment_call_count(self, agent: Agent, tool_name: str) -> int:
        if not self._call_counts:
            stored = agent.state.get(_STATE_KEY)
            if isinstance(stored, dict):
                self._call_counts.update(stored)
        current = self._call_counts.get(tool_name, 0)
        next_count = current + 1
        self._call_counts[tool_name] = next_count
        agent.state.set(_STATE_KEY, dict(self._call_counts))
        return next_count

    def _decrement_call_count(self, agent: Agent, tool_name: str) -> None:
        current = self._call_counts.get(tool_name, 0)
        if current > 0:
            self._call_counts[tool_name] = current - 1
        agent.state.set(_STATE_KEY, dict(self._call_counts))
