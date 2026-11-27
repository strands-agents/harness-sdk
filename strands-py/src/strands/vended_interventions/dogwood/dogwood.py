"""Dogwood authorization intervention handler."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import TYPE_CHECKING, Any

from dogwood import DogwoodAuthorizer, DogwoodError, lower, validate
from typing_extensions import NotRequired, TypedDict

from ...hooks.events import AfterToolCallEvent, BeforeToolCallEvent
from ...interventions.actions import Deny, Proceed
from ...interventions.handler import InterventionHandler, OnError
from ...types.tools import AgentTool, ToolSpec
from ._schema_generator import (
    RESOURCE,
    apply_namespace,
    assert_cedar_namespace,
    decimal_parameters,
    generate_action_schema,
    namespace_prefix_of,
    specs_of,
)

if TYPE_CHECKING:
    from dogwood._dogwood import AuthorizerDecision

logger = logging.getLogger(__name__)

# The binding ships its types in a stub only, so importing one at runtime raises ImportError and a
# public signature annotated with it cannot be resolved. Only a private signature annotates the
# import above.

DogwoodValue = None | bool | int | float | str | Decimal | Sequence["DogwoodValue"] | Mapping[str, "DogwoodValue"]
"""A value Dogwood accepts in an event. ``{"__entity": EntityRef}`` and ``{"__decimal": "1.50"}``
are its tagged escapes."""


class EntityRef(TypedDict):
    """A reference to an entity by type and id."""

    type: str
    id: str


class EntityInput(TypedDict):
    """An entity supplied to a decision: its id, and the attributes and parents a policy reads."""

    type: str
    id: str
    attrs: NotRequired[Mapping[str, DogwoodValue]]
    parents: NotRequired[list[EntityRef]]


ENRICHED_GROUP = "session"
"""The one context group a ``context_enricher`` can add."""

INPUT_GROUP = "input"
"""The context group carrying a tool call's arguments. Only a tool-call action declares it."""

SYSTEM_GROUP = "system"
"""The context group Dogwood's MCP schema template declares for the wall clock."""

PrincipalResolver = Callable[[dict[str, Any]], EntityRef | None]
"""Resolves a principal from invocation_state. Return None to deny (fail-closed)."""

ContextEnricher = Callable[[dict[str, Any]], dict[str, DogwoodValue]]
"""Adds fields to context.session. Receives {'tool_name', 'tool_input', 'invocation_state'}."""

EventGroups = dict[str, dict[str, DogwoodValue]]
"""Event field groups, ``group -> {field -> value}``."""


@dataclass(frozen=True)
class _AllowedCall:
    """What recording a tool's result needs, as the request was decided: never re-resolved later."""

    tool_name: str
    action: str
    principal: EntityRef
    logged: EventGroups


class DogwoodAuthorization(InterventionHandler):
    """Dogwood authorization intervention handler.

    Evaluates a Dogwood policy set before each tool call, and records the result afterward so
    temporal rules work.

    A call on tool ``search`` is decided as action ``Action::"search"`` — qualified by the schema's
    namespace when it has one — against the configured principal and the gateway resource, with the
    tool arguments in ``context.input``. Arguments are compared as the model emitted them: an enum
    parameter as a string, a number as a Cedar ``decimal``, so a condition on one reads
    ``context.input.amount.lessThan(decimal("10.0"))``.

    One instance is one ordered temporal history, with every predicate pinned to the deciding
    principal, so many principals can share it without their histories mixing. History is never
    pruned; :meth:`reset` drops every principal's at once. A result's fields are not recorded, only
    that the call returned, so a predicate on one type-checks and then never matches.

    Dogwood checks a call against the schema before it will decide, so an argument the tool does
    not declare — or a required one the model left out — denies the call. The denial names the
    mismatch, which a model can act on when it retries.

    Requires the ``dogwood-aws`` package.

    Example::

        dogwood = DogwoodAuthorization(
            policies='permit(principal, action == Action::"search", resource);',
            tools=[search_tool],
        )
        agent = Agent(model=model, tools=[search_tool], interventions=[dogwood])
    """

    name = "dogwood-authorization"

    @property
    def on_error(self) -> OnError:
        """What to do when this handler throws."""
        return self._on_error

    def __init__(
        self,
        *,
        policies: str,
        tools: list[AgentTool | ToolSpec] | None = None,
        action_schema: str | None = None,
        entities: list[EntityInput] | None = None,
        namespace: str | None = None,
        principal: EntityRef | None = None,
        principal_resolver: PrincipalResolver | None = None,
        context_enricher: ContextEnricher | None = None,
        on_error: OnError = "throw",
    ) -> None:
        """Initialize the Dogwood authorization handler.

        Args:
            policies: Dogwood policy text, or a path to a ``.dw`` file on disk.
            tools: Tools the action schema is generated from, as the tools themselves or their
                specs.
            action_schema: Cedar action schema text, or a path to a ``.cedarschema`` file.
                Generated from ``tools`` when omitted. The namespace, the default principal and
                the resource are read from it, so it must declare its user entity as ``User`` and
                its resource entity as ``Resource``.
            entities: Entities supplied to every decision — attributes and hierarchy a policy
                reads. Requires ``action_schema``: a generated schema declares its entities with
                no attributes and no membership, so an entity carrying either fails conformance at
                decision time and denies every call.
            namespace: Namespace for a generated action schema, qualifying every action and entity
                it declares, as in ``Acme::Action::"search"`` and ``Acme::User``. Omit it and they
                are declared at the top level. Only valid with ``tools``.
            principal: Static principal, ``User::"anonymous"`` by default, qualified by the
                schema's namespace when it declares one. Against a generated schema the type must
                be ``User``. Mutually exclusive with ``principal_resolver``.
            principal_resolver: Dynamic principal resolver for multi-tenant agents. Return None to
                deny (fail-closed). Mutually exclusive with ``principal``.
            context_enricher: Adds fields to the ``session`` group of the Cedar request context,
                read by a policy as ``context.session.tenant``, for ``invocation_state`` values a
                tool's arguments do not carry. Dogwood checks a request's context against the
                action's context type, so this requires an ``action_schema`` declaring ``session``
                on every tool action. The fields reach a ``when`` condition only, never a temporal
                predicate.
            on_error: What to do when ``principal_resolver`` or ``context_enricher`` raises:
                ``'throw'`` (default) re-raises, ``'deny'`` denies the tool call (fail-closed).

                **Warning:** ``'proceed'`` is fail-open — the tool runs with no authorization
                check. A failed Dogwood decision always denies regardless of this setting.

        Raises:
            ValueError: If neither ``action_schema`` nor ``tools`` is supplied, if ``principal``
                and ``principal_resolver`` are both, if ``entities`` is non-empty without
                ``action_schema``, if ``namespace`` is supplied with one or is not a legal Cedar
                namespace, if ``principal`` is not of the type a generated schema declares, if
                ``context_enricher`` is supplied against a schema that declares no ``session``
                context group, or if the policy set does not type-check against the schema.
            DogwoodError: If the policy set, the schema, or a tool manifest fails to parse.
        """
        if principal and principal_resolver:
            raise ValueError("Provide either `principal` or `principal_resolver`, not both")
        if not action_schema and tools is None:
            raise ValueError("Provide either `action_schema` or `tools`")
        if entities and not action_schema:
            raise ValueError("`entities` requires `action_schema`; a generated schema declares no entity attributes")
        if namespace is not None and action_schema:
            raise ValueError(
                "`namespace` applies to a generated schema; a hand-written `action_schema` declares its own"
            )
        assert_cedar_namespace(namespace)

        self._policies = _load_source(policies, ".dw")
        self._action_schema = (
            _load_source(action_schema, ".cedarschema")
            if action_schema
            else apply_namespace(generate_action_schema(tools or []), namespace)
        )
        # A hand-written schema's author chose each parameter's type, so nothing is widened for it.
        self._decimal_parameters = {} if action_schema else decimal_parameters(specs_of(tools or []))
        errors = validate(self._policies, self._action_schema)["errors"]
        if errors:
            raise ValueError(f"Dogwood policy validation failed: {', '.join(error['message'] for error in errors)}")

        self._authorizer = DogwoodAuthorizer(self._policies, self._action_schema)
        prefix = namespace_prefix_of(self._authorizer.actions)
        self._actions_by_tool = {
            action[action.rfind("::") + 2 :].strip('"'): action for action in self._authorizer.actions
        }
        self._declared_kinds = frozenset(self._authorizer.event_kinds)
        self._context_groups = _context_groups_of(self._policies, self._action_schema)
        self._resource: EntityRef = {"type": f"{prefix}{RESOURCE}", "id": "agent"}
        # None admits any type: a hand-written schema may declare several.
        self._principal_type = None if action_schema else f"{prefix}User"
        anonymous: EntityRef = {"type": f"{prefix}User", "id": "anonymous"}
        static_principal = anonymous if principal is None else principal
        self._default_principal: EntityRef | None = None if principal_resolver else static_principal

        default_type = None if self._default_principal is None else self._default_principal.get("type")
        if default_type is not None and not self._declares_principal_type(default_type):
            raise ValueError(f"`principal` must be of type `{self._principal_type}`, got `{default_type}`")
        # Only the actions a tool call can land on, told apart by declaring `input`: no call is ever
        # decided against the schema's own gateway-level actions.
        undeclared = sorted(
            tool
            for tool in self._actions_by_tool
            if self._declares_context_group(tool, INPUT_GROUP)
            and not self._declares_context_group(tool, ENRICHED_GROUP)
        )
        if context_enricher and undeclared:
            raise ValueError(
                f"`context_enricher` requires an `action_schema` declaring a `{ENRICHED_GROUP}` context group on every "
                f"tool action; {', '.join(undeclared)} declare none"
            )

        self._principal_resolver = principal_resolver
        self._context_enricher = context_enricher
        self._entities = entities or []
        self._on_error = on_error
        # Allowed calls by tool-use id, until their result is recorded.
        self._allowed_calls: dict[str, _AllowedCall] = {}

    def before_tool_call(self, event: BeforeToolCallEvent, **kwargs: Any) -> Proceed | Deny:
        """Decide a tool call against the policy set, and record the request event."""
        tool_name = event.tool_use["name"]
        tool_use_id = event.tool_use["toolUseId"]
        # Resuming an interrupt re-fires this event, and the call is already in the history. The
        # tool name is matched too, so an abandoned interrupt cannot wave through a later call that
        # reuses its id for another tool.
        allowed = self._allowed_calls.get(tool_use_id)
        if allowed is not None and allowed.tool_name == tool_name:
            return Proceed()
        self._allowed_calls.pop(tool_use_id, None)

        invocation_state = event.invocation_state
        principal = self._default_principal or (
            self._principal_resolver(invocation_state) if self._principal_resolver else None
        )
        if not principal or not principal.get("type") or not principal.get("id"):
            return Deny(reason="No principal identity found in invocation state")
        if not self._declares_principal_type(principal["type"]):
            return Deny(
                reason=f"Principal type '{principal['type']}' is not declared by the Dogwood action schema; denying"
            )

        action = self._actions_by_tool.get(tool_name)
        if not action:
            return Deny(reason=f"Tool '{tool_name}' is not declared by the Dogwood action schema; denying")

        timestamp = self._timestamp()
        logged, context = self._event_fields(event.tool_use.get("input"), tool_name, timestamp, invocation_state)
        try:
            decision = self._authorizer.is_authorized(
                {
                    "action": action,
                    "kind": "request",
                    "timestamp": timestamp,
                    "principal": principal,
                    "resource": self._resource,
                    "logged": logged,
                    "context": context,
                    "entities": self._entities,
                }
            )
        except DogwoodError as error:
            # Upstream's contract is that a failed call is *no decision*, which the host must deny.
            # Tool arguments are model output, so letting it escape would give the model a
            # fail-open path under `on_error='proceed'` by adding one junk argument.
            return Deny(reason=f"Dogwood could not decide: {error}")

        denial = _denial_reason(decision, tool_name)
        if denial:
            return Deny(reason=denial)

        self._allowed_calls[tool_use_id] = _AllowedCall(
            tool_name=tool_name, action=action, principal=principal, logged=logged
        )
        return Proceed()

    def after_tool_call(self, event: AfterToolCallEvent, **kwargs: Any) -> Proceed:
        """Record the result of a call this handler allowed, so temporal rules can read it."""
        tool_use_id = event.tool_use["toolUseId"]
        # A blocked call still reaches here, so only a call this handler allowed can be recorded.
        allowed = self._allowed_calls.get(tool_use_id)
        if allowed is None or allowed.tool_name != event.tool_use["name"]:
            return Proceed()
        self._allowed_calls.pop(tool_use_id)
        # Set only when the tool never ran, leaving no result to record.
        if event.cancel_message is not None:
            return Proceed()

        # A tool that returns an error result rather than raising still failed.
        kind = "error" if event.exception or event.result["status"] == "error" else "response"
        if kind not in self._declared_kinds:
            return Proceed()

        timestamp = self._timestamp()
        try:
            # History-only: no verdict is returned, so there is nothing to enforce.
            self._authorizer.is_authorized(
                {
                    "action": allowed.action,
                    "kind": kind,
                    "timestamp": timestamp,
                    "principal": allowed.principal,
                    "resource": self._resource,
                    "logged": allowed.logged,
                    "context": self._context_of(allowed.tool_name, allowed.logged, timestamp),
                    "entities": self._entities,
                }
            )
        except DogwoodError as error:
            # A later rule keyed on this result will not fire, but failing a call that already ran
            # is worse.
            logger.warning(
                "tool=<%s>, kind=<%s> | dogwood could not record a tool result, %s", allowed.tool_name, kind, error
            )

        return Proceed()

    def reset(self) -> None:
        """Drop accumulated temporal history.

        Clears every principal this instance has decided for, not one session's history.
        """
        # An in-flight call allowed against the old history must not record its response into the
        # new one.
        self._allowed_calls.clear()
        try:
            self._authorizer.reset()
        except DogwoodError as error:
            # An authorizer that can no longer be reset denies every later call anyway.
            logger.warning("%s | dogwood could not drop its temporal history", error)

    def _declares_principal_type(self, principal_type: str) -> bool:
        """Whether the schema admits ``principal_type``, always true for a hand-written one."""
        return self._principal_type is None or principal_type == self._principal_type

    def _declares_context_group(self, tool_name: str, group: str) -> bool:
        """Whether the action for ``tool_name`` admits ``group`` in its context."""
        return group in self._context_groups.get(tool_name, frozenset())

    def _event_fields(
        self, tool_input: Any, tool_name: str, timestamp: int, invocation_state: dict[str, Any]
    ) -> tuple[EventGroups, EventGroups]:
        """The durable record and the Cedar context for one tool call.

        Only the tool's input is recorded, because the event schema declares nothing else a
        temporal predicate could read.
        """
        logged: EventGroups = {INPUT_GROUP: self._widen_decimals(tool_name, tool_input or {})}
        context = self._context_of(tool_name, logged, timestamp)
        # The enricher is not asked for fields with nowhere to go: an action declaring no `session`
        # group rejects an event carrying one, and no policy can read it there either.
        if not self._context_enricher or not self._declares_context_group(tool_name, ENRICHED_GROUP):
            return logged, context

        enriched = self._context_enricher(
            {"tool_name": tool_name, "tool_input": logged[INPUT_GROUP], "invocation_state": invocation_state}
        )
        return logged, {**context, ENRICHED_GROUP: enriched}

    def _widen_decimals(self, tool_name: str, tool_input: Any) -> Any:
        """Widen the whole numbers a model sent for a ``decimal`` parameter.

        Dogwood matches ``decimal`` against a float but not against the ``int`` a model sends for a
        whole value. An ``integer`` parameter is generated as ``Long``, which a float fails, so
        only a declared ``decimal`` is widened.
        """
        decimals = self._decimal_parameters.get(tool_name)
        if not decimals or not isinstance(tool_input, dict):
            return tool_input
        return {name: _as_float(value) if name in decimals else value for name, value in tool_input.items()}

    def _context_of(self, tool_name: str, logged: EventGroups, timestamp: int) -> EventGroups:
        """The Cedar request context for an event, carrying only groups the action declares.

        Dogwood rejects an undeclared group outright, and a missing required one fails conformance.
        """
        context: EventGroups = {
            group: fields for group, fields in logged.items() if self._declares_context_group(tool_name, group)
        }
        if self._declares_context_group(tool_name, SYSTEM_GROUP):
            context[SYSTEM_GROUP] = {"now": _cedar_datetime(timestamp)}
        return context

    def _timestamp(self) -> int:
        """Epoch seconds, never going backwards: the authorizer rejects an out-of-order event."""
        return max(int(time.time()), self._authorizer.last_timestamp or 0)


def _load_source(value: str, extension: str) -> str:
    """Read ``value`` from disk when it names a file with ``extension``, else take it as source text.

    Raises:
        FileNotFoundError: If ``value`` names a file that does not exist.
    """
    if not value.endswith(extension):
        return value

    path = Path(value)
    if not path.exists():
        raise FileNotFoundError(f"Dogwood {extension} file not found: {value}")
    return path.read_text(encoding="utf-8")


def _as_float(value: DogwoodValue) -> DogwoodValue:
    """``value`` as a float, or element-wise for a list, leaving the rest for Dogwood to reject."""
    # `bool` is an `int` in Python, and Dogwood matches it against `Bool`, never `decimal`.
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        try:
            return float(value)
        except OverflowError:
            # Out of `decimal` range either way, so Dogwood is left to name the mismatch rather
            # than this raising out of the handler and reaching `on_error`.
            return value
    if isinstance(value, list):
        return [_as_float(item) for item in value]
    return value


def _cedar_datetime(timestamp: int) -> dict[str, Any]:
    """``timestamp`` as a Cedar ``datetime`` extension value, the JSON escape Dogwood accepts."""
    moment = datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"__extn": {"fn": "datetime", "arg": moment}}


def _denial_reason(decision: AuthorizerDecision | None, tool_name: str) -> str | None:
    """The denial reason for a decision, or None when it allowed."""
    # Every decision kind yields a verdict, so an absent decision is a broken contract, not an allow.
    if decision is None:
        return f"No Dogwood decision returned for '{tool_name}'; denying"
    if decision["allowed"]:
        return None
    if decision["errors"]:
        return f"Dogwood evaluation failed: {', '.join(decision['errors'])}"

    rules = ", ".join(str(rule) for rule in decision["determining_rules"])
    return f"Access denied by Dogwood policy{f' (rule {rules})' if rules else ''}"


def _context_groups_of(policies: str, action_schema: str) -> dict[str, frozenset[str]]:
    """The context groups each action declares, by unqualified action name.

    Read from the lowered Cedar schema, which is where an action's declared context type lives. An
    action name is the tool name, so the schema's own gateway-level actions are in the map too.
    """
    schema = json.loads(lower(policies, action_schema)["cedar_schema_json"])
    return {
        action: frozenset(spec.get("appliesTo", {}).get("context", {}).get("attributes", {}))
        for declaration in schema.values()
        for action, spec in declaration.get("actions", {}).items()
    }
