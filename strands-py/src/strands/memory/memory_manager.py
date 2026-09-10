"""Cross-session memory retrieval and storage for agents."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Literal

from opentelemetry import trace as trace_api

from .._middleware.stages import InvokeModelStage
from ..hooks.events import MessageAddedEvent
from ..injection._message_injection import _create_injection_middleware, _is_user_turn
from ..injection._xml import _escape_xml_attr, _escape_xml_text
from ..plugins.plugin import Plugin
from ..telemetry.tracer import get_tracer
from ..tools.decorator import tool
from ..types.exceptions import AggregateMemoryError
from ..types.tools import AgentTool
from .extraction.coordinator import ExtractionCoordinator, _ExtractionBinding
from .extraction.resolve_extraction_config import _resolve_extraction_config
from .extraction.types import ExtractionTriggerContext
from .types import (
    InjectionFormatContext,
    InjectionQueryContext,
    MemoryAddOptions,
    MemoryAddToolConfig,
    MemoryEntry,
    MemoryInjectionConfig,
    MemorySearchOptions,
    MemoryStore,
    MemoryToolConfig,
    _has_method,
    _has_write_sink,
)

if TYPE_CHECKING:
    from ..agent.agent import Agent
    from ..types.content import Messages

logger = logging.getLogger(__name__)

SEARCH_TOOL_DESCRIPTION = (
    "Search long-term memory for facts, preferences, or context from previous conversations. Use when you need "
    "background about the user or topic that may have been discussed before."
)

ADD_TOOL_DESCRIPTION = (
    "Add facts, preferences, or decisions to long-term memory so they are remembered across conversations. Use when "
    "the user shares something worth recalling later."
)

# Default maximum results per store when neither caller nor store specifies one.
DEFAULT_MAX_SEARCH_RESULTS = 3

# Default number of entries injected per model call when injection does not specify one.
DEFAULT_MAX_ENTRIES = 5


def _flatten_reasons(reasons: list[BaseException]) -> list[BaseException]:
    """Flatten nested aggregate errors so the leaves are concrete reasons."""
    flattened: list[BaseException] = []
    for reason in reasons:
        if isinstance(reason, AggregateMemoryError):
            flattened.extend(_flatten_reasons(reason.errors))
        else:
            flattened.append(reason)
    return flattened


class MemoryManager(Plugin):
    """Provides cross-session memory retrieval and storage for agents.

    Example:
        ```python
        from strands import Agent
        from strands.memory import MemoryManager

        memory_manager = MemoryManager(stores=[my_store])
        agent = Agent(model=model, memory_manager=memory_manager)
        agent("Remember I prefer dark mode")

        results = await memory_manager.search("user preferences")
        ```
    """

    name = "strands:memory-manager"

    def __init__(
        self,
        stores: list[MemoryStore],
        search_tool_config: MemoryToolConfig | bool = True,
        add_tool_config: MemoryAddToolConfig | bool = False,
        injection: MemoryInjectionConfig | bool = True,
    ) -> None:
        """Initialize the memory manager.

        Args:
            stores: One or more memory stores to manage.
            search_tool_config: Search tool configuration. ``True`` (default)
                registers a ``search_memory`` tool with default name/description;
                a :class:`MemoryToolConfig` customizes it; ``False`` disables it.
            add_tool_config: Add tool configuration. ``False`` (default) disables
                the add tool; ``True`` lets it write to all writable stores; a
                :class:`MemoryAddToolConfig` restricts/customizes it.
            injection: Memory context injection. ``True`` (default) uses the
                default injection settings; a :class:`MemoryInjectionConfig`
                customizes retrieval, timing, and formatting; ``False`` disables
                it. When enabled, retrieved memory is folded into the model input
                before each call without touching durable history.

        Raises:
            ValueError: If ``stores`` is empty, a store name is duplicated, a
                writable store has no write sink, an extraction config is
                misconfigured, or the add tool is enabled/scoped against stores
                that cannot accept discrete ``add`` writes.
        """
        if len(stores) == 0:
            raise ValueError("MemoryManager: at least one store is required")

        seen_names: set[str] = set()
        extraction_bindings: list[_ExtractionBinding] = []
        for store in stores:
            if store.name in seen_names:
                raise ValueError(f"MemoryManager: duplicate store name '{store.name}'")
            seen_names.add(store.name)

            if store.writable and not _has_write_sink(store):
                raise ValueError(
                    f"MemoryManager: store '{store.name}' is writable but has no add or add_messages method"
                )

            extraction_config = _resolve_extraction_config(store.extraction, store)
            if extraction_config is not None:
                if not store.writable:
                    raise ValueError(f"MemoryManager: store '{store.name}' has extraction config but is not writable")
                if len(extraction_config.triggers) == 0:
                    raise ValueError(f"MemoryManager: store '{store.name}' has extraction config but no triggers")
                # Each extraction shape needs its matching write sink. An extractor produces discrete
                # entries written via `add`; without an extractor the raw message batch goes to
                # `add_messages`.
                if extraction_config.extractor is not None:
                    if not _has_method(store, "add"):
                        raise ValueError(
                            f"MemoryManager: store '{store.name}' has an extractor but no add method "
                            "(extracted entries are written via add)"
                        )
                elif not _has_method(store, "add_messages"):
                    raise ValueError(
                        f"MemoryManager: store '{store.name}' has extraction config without an extractor "
                        "but no add_messages method"
                    )
                extraction_bindings.append(_ExtractionBinding(store=store, config=extraction_config))

        super().__init__()

        self._stores = list(stores)
        self._search_stores = list(stores)
        # `add`-targeting paths (tool / programmatic) need an `add` method specifically.
        self._add_stores = [store for store in stores if store.writable and _has_method(store, "add")]
        # Stores with extraction enabled, each paired with its resolved config; wired up in ``init_agent``.
        self._extraction_stores = extraction_bindings

        self._search_tool_config: MemoryToolConfig | Literal[False]
        if isinstance(search_tool_config, dict):
            self._search_tool_config = search_tool_config
        elif search_tool_config:
            self._search_tool_config = MemoryToolConfig()
        else:
            self._search_tool_config = False

        self._add_tool_config: MemoryAddToolConfig | Literal[False]
        self._add_tool_stores: list[MemoryStore]
        if add_tool_config is None or add_tool_config is False:
            self._add_tool_config = False
            self._add_tool_stores = []
        else:
            # The `add_memory` tool writes via `add`, so needs an `add`-capable store.
            if len(self._add_stores) == 0:
                raise ValueError("MemoryManager: add_tool_config is enabled but no writable stores implement add")
            resolved_config = add_tool_config if isinstance(add_tool_config, dict) else MemoryAddToolConfig()
            self._add_tool_config = resolved_config
            self._add_tool_stores = self._resolve_add_tool_stores(resolved_config)

        # Fire-and-forget background tasks, retained so they aren't GC'd mid-flight.
        self._background_tasks: set[asyncio.Task] = set()

        # Extraction coordinator, created in ``init_agent`` when configured.
        self._coordinator: ExtractionCoordinator | None = None

        # Resolved injection config, or ``False`` when injection is disabled. ``True`` resolves
        # to a default ``MemoryInjectionConfig``; a config object passes through unchanged.
        self._injection_config: MemoryInjectionConfig | Literal[False]
        if isinstance(injection, dict):
            self._injection_config = injection
        elif injection:
            self._injection_config = MemoryInjectionConfig()
        else:
            self._injection_config = False

        # Build tools now; surfaced via the ``tools`` property.
        self._memory_tools: list[AgentTool] = self._build_tools()

    def _resolve_add_tool_stores(self, tool_config: MemoryAddToolConfig) -> list[MemoryStore]:
        """Resolve the writable stores the ``add_memory`` tool may write to.

        Each entry (a store name or instance) must resolve by name to a
        configured, ``add``-capable writable store. Omitted means all such stores.

        Raises:
            ValueError: If a referenced store is not configured, not writable, or
                has no ``add`` method.
        """
        config_stores = tool_config.get("stores")
        if config_stores is None:
            return self._add_stores

        names = [store if isinstance(store, str) else store.name for store in config_stores]

        resolved: list[MemoryStore] = []
        seen: set[str] = set()
        for name in names:
            if name in seen:
                continue
            seen.add(name)
            found = next((store for store in self._stores if store.name == name), None)
            if found is None:
                raise ValueError(f"MemoryManager: add_tool_config store '{name}' not found")
            if not found.writable:
                raise ValueError(f"MemoryManager: add_tool_config store '{name}' is not writable")
            if not _has_method(found, "add"):
                raise ValueError(f"MemoryManager: add_tool_config store '{name}' has no add method (only add_messages)")
            resolved.append(found)
        return resolved

    def _build_tools(self) -> list[AgentTool]:
        """Build the tools this plugin registers.

        Includes the manager's ``search_memory`` / ``add_memory`` tools plus any
        tools the stores expose via
        :meth:`~strands.memory.types.MemoryStore.get_tools`, in store order.
        """
        tools: list[AgentTool] = []

        if isinstance(self._search_tool_config, dict):
            tools.append(self._create_search_tool(self._search_tool_config))

        if isinstance(self._add_tool_config, dict):
            tools.append(self._create_add_tool(self._add_tool_config, self._add_tool_stores))

        for store in self._stores:
            if _has_method(store, "get_tools"):
                tools.extend(store.get_tools())

        return tools

    @property
    def tools(self) -> list[AgentTool]:  # type: ignore[override]
        """Tools registered by this plugin: search/add plus any store-provided tools.

        Widens the base :class:`~strands.plugins.plugin.Plugin` annotation because
        a store's ``get_tools`` may contribute any
        :class:`~strands.types.tools.AgentTool`.
        """
        return list(self._memory_tools)

    def _resolve_named_stores(self, requested: list[str], *, require_writable: bool = False) -> list[MemoryStore]:
        """Resolve requested store names to configured store instances.

        De-duplicates ``requested`` (preserving first-seen order) and looks each
        name up among the configured stores.

        Args:
            requested: Store names to resolve.
            require_writable: When set, a resolved read-only store is rejected.

        Raises:
            ValueError: If a name is not configured, or is read-only when
                ``require_writable`` is set.
        """
        resolved_stores: list[MemoryStore] = []
        seen: set[str] = set()
        for name in requested:
            if name in seen:
                continue
            seen.add(name)
            found = next((store for store in self._stores if store.name == name), None)
            if found is None:
                raise ValueError(f"MemoryManager: store '{name}' not found")
            if require_writable and not found.writable:
                raise ValueError(f"MemoryManager: store '{name}' is read-only")
            resolved_stores.append(found)
        return resolved_stores

    async def search(self, query: str, options: MemorySearchOptions | None = None) -> list[MemoryEntry]:
        """Search stores for entries matching the query.

        Unscoped: searches all configured stores when ``options.stores`` is
        omitted. Results are attributed to their store via ``store_name`` and
        concatenated in target order.

        Raises:
            ValueError: If a named store is not found (raised before querying).
        """
        requested_stores = options.get("stores") if options is not None else None
        caller_max = options.get("max_search_results") if options is not None else None

        logger.debug(
            "query=<%s>, max_search_results=<%s>, stores=<%s> | searching stores",
            query,
            caller_max,
            requested_stores,
        )

        tracer = get_tracer()
        span_store_names = requested_stores if requested_stores is not None else [store.name for store in self._stores]
        span = tracer.start_memory_search_span(query, span_store_names, max_search_results=caller_max)

        try:
            with trace_api.use_span(span, end_on_exit=False):
                if requested_stores is not None:
                    target_stores = self._resolve_named_stores(requested_stores)
                else:
                    target_stores = self._stores

                settled = await asyncio.gather(
                    *(
                        store.search(
                            query,
                            MemorySearchOptions(
                                max_search_results=(
                                    caller_max
                                    if caller_max is not None
                                    else store.max_search_results
                                    if store.max_search_results is not None
                                    else DEFAULT_MAX_SEARCH_RESULTS
                                )
                            ),
                        )
                        for store in target_stores
                    ),
                    return_exceptions=True,
                )
        except Exception as error:
            tracer.end_memory_search_span(span, error=error)
            raise

        results: list[MemoryEntry] = []
        store_failure_count = 0
        for store, outcome in zip(target_stores, settled, strict=True):
            if isinstance(outcome, BaseException):
                logger.warning("store=<%s>, reason=<%s> | store search failed", store.name, outcome)
                store_failure_count += 1
                continue
            for entry in outcome:
                results.append(MemoryEntry(content=entry.content, store_name=store.name, metadata=entry.metadata))

        tracer.end_memory_search_span(span, entries=results, store_failure_count=store_failure_count)

        logger.debug("results=<%s> | search complete", len(results))
        return results

    async def add(self, content: str, options: MemoryAddOptions | None = None, *, _detached: bool = False) -> None:
        """Add content to writable stores.

        Unscoped: targets all configured writable stores. Target stores are
        validated first, then writes are awaited concurrently; per-store failures
        are logged and surfaced as an
        :class:`~strands.types.exceptions.AggregateMemoryError`.

        Args:
            content: The content to write.
            options: Optional add options (target stores, metadata).
            _detached: Internal. When the write runs detached from the call that
                scheduled it (the fire-and-forget add tool path), start the span as
                a trace root rather than parenting to a possibly-ended span.

        Raises:
            ValueError: If a named store is not found or is read-only, or if no
                writable store matched.
            AggregateMemoryError: If any targeted store write fails.
        """
        requested_stores = options.get("stores") if options is not None else None
        metadata = options.get("metadata") if options is not None else None

        tracer = get_tracer()
        span_store_names = (
            requested_stores if requested_stores is not None else [store.name for store in self._add_stores]
        )
        span = tracer.start_memory_add_span(content, span_store_names, force_root=_detached)

        try:
            with trace_api.use_span(span, end_on_exit=False):
                if requested_stores is not None:
                    writable_stores = self._resolve_named_stores(requested_stores, require_writable=True)
                else:
                    writable_stores = self._add_stores

                if len(writable_stores) == 0:
                    raise ValueError("MemoryManager: no writable store matched")

                settled = await asyncio.gather(
                    *(store.add(content, metadata) for store in writable_stores),
                    return_exceptions=True,
                )
        except Exception as error:
            tracer.end_memory_add_span(span, error=error)
            raise

        failed_names: list[str] = []
        reasons: list[BaseException] = []
        for store, outcome in zip(writable_stores, settled, strict=True):
            if isinstance(outcome, BaseException):
                logger.warning("store=<%s>, reason=<%s> | store write failed", store.name, outcome)
                failed_names.append(store.name)
                reasons.append(outcome)

        if failed_names:
            aggregate_error = AggregateMemoryError(
                f"MemoryManager: store writes failed: {', '.join(failed_names)}",
                reasons,
            )
            tracer.end_memory_add_span(span, store_failure_count=len(failed_names), error=aggregate_error)
            raise aggregate_error

        tracer.end_memory_add_span(span)

    def _resolve_tool_targets(self, scoped_names: list[str], requested: list[str] | None) -> list[str]:
        """Resolve the store names a tool callback should target.

        Omitting ``requested`` targets all scoped stores; in-scope names are kept
        and out-of-scope names are dropped with a warning.

        Raises:
            ValueError: If every requested name is out of scope.
        """
        if requested is None or len(requested) == 0:
            return scoped_names

        scoped_set = set(scoped_names)
        in_scope = [name for name in requested if name in scoped_set]
        out_of_scope = [name for name in requested if name not in scoped_set]

        if len(in_scope) == 0:
            raise ValueError(
                f"MemoryManager: requested=<{', '.join(requested)}> | none of the requested memory stores "
                f"are available; available stores: {', '.join(scoped_names)}"
            )

        if out_of_scope:
            logger.warning(
                "requested=<%s> | ignoring memory stores outside this tool's scope",
                ", ".join(out_of_scope),
            )

        return in_scope

    def _create_search_tool(self, config: MemoryToolConfig) -> AgentTool:
        """Build the ``search_memory`` tool."""
        custom_description = config.get("description")
        description = custom_description if custom_description is not None else SEARCH_TOOL_DESCRIPTION
        store_descriptions = [
            f"- {store.name}: {store.description}" for store in self._search_stores if store.description
        ]
        if store_descriptions:
            description += "\n\nAvailable memory stores:\n" + "\n".join(store_descriptions)
            description += (
                "\n\nYou can target one or more memory stores by name if you know which domains are relevant, "
                "or omit the stores parameter to search all."
            )

        scoped_names = [store.name for store in self._search_stores]

        async def search_memory(
            query: str,
            max_search_results: int | None = None,
            stores: list[str] | None = None,
        ) -> list[dict[str, Any]]:
            """Search long-term memory.

            Args:
                query: What to search for.
                max_search_results: Maximum number of results per store.
                stores: Filter to specific stores by name. Omit to search all
                    available stores.

            Returns:
                Matching memory entries, each attributed to its store.
            """
            targets = self._resolve_tool_targets(scoped_names, stores)
            options = MemorySearchOptions(stores=targets)
            if max_search_results is not None:
                options["max_search_results"] = max_search_results
            results = await self.search(query, options)
            payload: list[dict[str, Any]] = []
            for entry in results:
                item: dict[str, Any] = {"content": entry.content}
                if entry.store_name:
                    item["store_name"] = entry.store_name
                if entry.metadata:
                    item["metadata"] = entry.metadata
                payload.append(item)
            return payload

        custom_name = config.get("name")
        return tool(
            name=custom_name if custom_name is not None else "search_memory",
            description=description,
        )(search_memory)

    def _create_add_tool(self, config: MemoryAddToolConfig, stores: list[MemoryStore]) -> AgentTool:
        """Build the ``add_memory`` tool."""
        custom_description = config.get("description")
        description = custom_description if custom_description is not None else ADD_TOOL_DESCRIPTION
        store_descriptions = [f"- {store.name}: {store.description}" for store in stores if store.description]
        if store_descriptions:
            description += "\n\nAvailable writable stores:\n" + "\n".join(store_descriptions)
            description += (
                "\n\nYou can target a specific store by name to route facts to the right place, "
                "or omit to add to all available writable stores."
            )

        scoped_names = [store.name for store in stores]
        wait_for_writes = config.get("wait_for_writes", True)

        async def add_memory(entries: list[str], stores: list[str] | None = None) -> dict[str, int]:
            """Add data to long-term memory.

            Args:
                entries: Data to add to long-term memory.
                stores: Target specific stores by name. Omit to add to all
                    writable stores.

            Returns:
                A summary of the write (``{"stored": n}`` or ``{"accepted": n}``).
            """
            # @tool validation does not enforce ``minItems``, so guard here.
            if not entries:
                raise ValueError("MemoryManager: add_memory requires at least one entry")

            targets = self._resolve_tool_targets(scoped_names, stores)

            if not wait_for_writes:
                # Fire-and-forget: dispatch without awaiting. ``add`` logs per-store failures.
                for content in entries:
                    self._schedule_background(self._add_swallow(content, targets))
                return {"accepted": len(entries)}

            # Await mode: surface failures with concrete (flattened) reasons.
            settled = await asyncio.gather(
                *(self.add(content, MemoryAddOptions(stores=targets)) for content in entries),
                return_exceptions=True,
            )
            failures = [outcome for outcome in settled if isinstance(outcome, BaseException)]
            if failures:
                flattened = _flatten_reasons(failures)
                joined = "; ".join(str(reason) for reason in flattened)
                raise AggregateMemoryError(
                    f"MemoryManager: failed to add {len(failures)} of {len(entries)} entries: {joined}",
                    flattened,
                )

            return {"stored": len(entries)}

        custom_name = config.get("name")
        return tool(
            name=custom_name if custom_name is not None else "add_memory",
            description=description,
        )(add_memory)

    async def _add_swallow(self, content: str, targets: list[str]) -> None:
        """Run a programmatic ``add`` and swallow any failure (the add tool's fire-and-forget mode)."""
        try:
            await self.add(content, MemoryAddOptions(stores=targets), _detached=True)
        except Exception:  # noqa: BLE001 - failures are logged in ``add``; swallow here.
            pass

    def _schedule_background(self, coroutine: Any) -> None:
        """Schedule a coroutine as a tracked background task."""
        task = asyncio.ensure_future(coroutine)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    async def init_agent(self, agent: Agent) -> None:
        """Initialize the plugin with the agent.

        Wires up three behaviors:

        - **Store initialization**: calls each store's ``initialize()`` (if present) so stores can
          resolve remote resources or validate configuration eagerly. A failure here aborts agent
          construction with a clear error.
        - **Extraction**: for any store configured with an ``ExtractionConfig``,
          buffers conversation messages and attaches each store's triggers. A
          no-op when no store uses extraction. Extraction runs in the background;
          the synchronous ``Agent(...)`` entry point awaits :meth:`flush` after
          each invocation so writes persist, and callers driving the agent through
          their own event loop should await :meth:`flush` at a shutdown boundary.
        - **Injection**: when enabled, registers an ``InvokeModelStage`` middleware
          that folds retrieved memory into the model input for each call without
          touching durable history. A no-op when injection is disabled.
        """
        await self._init_stores()
        self._init_extraction(agent)
        self._init_injection(agent)

    async def _init_stores(self) -> None:
        """Call ``initialize()`` on each store that implements it."""
        for store in self._stores:
            if _has_method(store, "initialize"):
                await store.initialize()

    def _init_extraction(self, agent: Agent) -> None:
        """Wire background extraction for stores configured with an ``ExtractionConfig``."""
        if len(self._extraction_stores) == 0:
            return

        coordinator = ExtractionCoordinator(self._extraction_stores, agent.model, agent=agent)
        self._coordinator = coordinator

        # Buffer every message so extraction has its own copy to save from.
        agent.add_hook(lambda event: coordinator.record(event.message), MessageAddedEvent)

        for binding in self._extraction_stores:
            for trigger in binding.config.triggers:
                trigger.attach(ExtractionTriggerContext(agent=agent, fire=self._make_fire(coordinator, binding.store)))

    def _init_injection(self, agent: Agent) -> None:
        """Register the injection middleware when injection is enabled.

        Folds retrieved memory into the model input for each call via
        :meth:`_provide_memory_context`, without touching durable history. A no-op
        when injection is disabled.
        """
        config = self._injection_config
        if config is False:
            return

        agent._middleware_registry.add_middleware(
            InvokeModelStage.Input,
            _create_injection_middleware(
                lambda context: self._provide_memory_context(context.messages, config),
                trigger=config.get("trigger"),
            ),
        )

    async def _provide_memory_context(self, messages: Messages, config: MemoryInjectionConfig) -> str | None:
        """Produce the memory context text to inject for a model call, or ``None`` to skip.

        This is the ``render_content`` callback the injection middleware invokes (see
        :meth:`_init_injection`). Derives a query (the configured callback or an adaptive
        default), searches memory, and renders the top entries. Skips silently
        (returns ``None``) when no query can be derived or the search returns
        nothing. The rendering callback raising fails open (returns ``None``).

        Args:
            messages: The current conversation, as data.
            config: The resolved injection configuration.

        Returns:
            The injected text, or ``None`` when there is nothing to inject.
        """
        max_entries = config.get("max_entries")
        max_results = max_entries if max_entries is not None else DEFAULT_MAX_ENTRIES

        tracer = get_tracer()
        span = tracer.start_memory_inject_span(max_entries=max_results)

        def _end(injected: bool, entry_count: int = 0, format_error: bool = False) -> None:
            """End the inject span on every path (skip, fail-open, and success)."""
            tracer.end_memory_inject_span(span, injected=injected, entry_count=entry_count, format_error=format_error)

        try:
            with trace_api.use_span(span, end_on_exit=False):
                query = self._resolve_injection_query(messages, config)
                if query is None or not query.strip():
                    _end(injected=False)
                    return None

                # search caps each store at max_results; the slice caps the concatenation across stores.
                entries = (await self.search(query, MemorySearchOptions(max_search_results=max_results)))[:max_results]
                if len(entries) == 0:
                    _end(injected=False)
                    return None

                try:
                    custom_format = config.get("format")
                    if custom_format is not None:
                        rendered = custom_format(InjectionFormatContext(entries=entries))
                    else:
                        rendered = self._default_injection_format(entries)
                except Exception as error:  # noqa: BLE001 - fail open: a bad formatter must not abort the model call.
                    logger.warning("reason=<%s> | injection format raised | skipping injection", error)
                    _end(injected=False, format_error=True)
                    return None

                _end(injected=True, entry_count=len(entries))
                return rendered
        except Exception:
            # search (or anything else here) raising must not leak the span; end it and re-raise.
            _end(injected=False)
            raise

    def _resolve_injection_query(self, messages: Messages, config: MemoryInjectionConfig) -> str | None:
        """Derive the injection search query.

        Uses the configured ``query`` callback when provided (a raise fails open,
        skipping injection); otherwise an adaptive default: the latest user
        message's text on a user turn, or the most recent assistant message's text
        otherwise (the previous autonomous step).

        Args:
            messages: The current conversation, as data.
            config: The resolved injection configuration.

        Returns:
            The query string, or ``None`` when none is available.
        """
        custom_query = config.get("query")
        if custom_query is not None:
            try:
                return custom_query(InjectionQueryContext(messages=messages))
            except Exception as error:  # noqa: BLE001 - fail open: a bad query must not abort the model call.
                logger.warning("reason=<%s> | injection query raised | skipping injection", error)
                return None

        role = "user" if _is_user_turn(messages) else "assistant"
        index = next((index for index in range(len(messages) - 1, -1, -1) if messages[index]["role"] == role), -1)
        if index < 0:
            return None

        text = "\n".join(block["text"] for block in messages[index]["content"] if "text" in block).strip()
        return text if text else None

    def _default_injection_format(self, entries: list[MemoryEntry]) -> str:
        """Render the default injection format: a ``<memory>`` block with one ``<entry>`` per result.

        Each entry carries a ``source`` attribute naming the originating store (when
        known) so the model can attribute memories.

        Args:
            entries: The retrieved memory entries to render.

        Returns:
            The rendered ``<memory>`` block.
        """
        items = [
            (
                f'<entry source="{_escape_xml_attr(entry.store_name)}">{_escape_xml_text(entry.content)}</entry>'
                if entry.store_name
                else f"<entry>{_escape_xml_text(entry.content)}</entry>"
            )
            for entry in entries
        ]
        joined = "\n".join(items)
        return f"<memory>\n{joined}\n</memory>"

    @staticmethod
    def _make_fire(coordinator: ExtractionCoordinator, store: MemoryStore) -> Callable[[], None]:
        """Build a zero-arg ``fire`` callback bound to a specific store."""

        def fire() -> None:
            coordinator.schedule(store)

        return fire

    async def flush(self) -> None:
        """Save every store's remaining messages and wait for all saves to finish.

        A no-op when no store has extraction configured. Drains automatic
        extraction only; ``add_memory`` fire-and-forget writes are not awaited
        here.
        """
        if self._coordinator is not None:
            await self._coordinator.flush()
