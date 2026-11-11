"""What the SDK knows about models: the :class:`ModelInfo` type, and the shared model info data.

Every fact is optional: the sections are always present, and a fact that is missing or ``None`` means
unknown. The same shape is used everywhere: the shared data file, the ``model_info`` config override,
and the resolved :attr:`strands.models.Model.model_info`. A known ``"unsupported"`` disables a
feature; unknown leaves the SDK's existing default for that feature in place.

``model_info.json`` is copied from ``shared/model-info.json`` at the repository root (the source of
truth for every SDK) by the build hook in ``hatch_build.py``; it is not committed.
"""

import json
import re
from dataclasses import dataclass, fields, replace
from importlib import resources
from typing import Any, Literal, TypeAlias, TypeVar

PromptCaching: TypeAlias = Literal["unsupported", "auto", "cache_points"]
"""How a model supports prompt caching."""


@dataclass(frozen=True, kw_only=True)
class ReasoningCapability:
    """How the model reasons.

    Attributes:
        default_effort: The effort the vendor's own agent harness runs the model at by default, in
            the vendor's level names (``medium``, ``high``); the SDK does not send it.
    """

    default_effort: str | None = None


@dataclass(frozen=True, kw_only=True)
class ModelCapabilities:
    """What the model can do.

    A yes/no fact is a ``bool``; a fact with more than two states is a string literal, like
    :data:`PromptCaching` (which mechanism); a value the SDK passes through uninterpreted (a vendor's
    own level name) is a plain ``str``. A fact about two features together gets its own field named
    after the pair; facts about one feature are grouped in a nested record, like
    :class:`ReasoningCapability`. ``None`` is unknown either way.

    Attributes:
        stateful: Whether the model keeps conversation state server-side;
            :attr:`strands.models.Model.stateful` reads it.
        prompt_caching: Whether and how the model caches prompts.
        forced_tool_choice: Whether the model accepts a tool choice that forces a tool call
            (``any`` or a named tool).
        native_structured_output: Whether the provider can make the model's text output conform to a
            JSON schema.
        server_side_summary: Whether the model summarizes history server-side through
            :meth:`strands.models.Model.summarize`, which the summarize strategy then calls instead of its
            client-side summary. The shared model info sets it for the Claude models whose API supports it;
            providers without a server-side summary turn it off. Set it to False to summarize client-side.
        reasoning: How the model reasons; always present, every field None when unknown.
    """

    stateful: bool | None = None
    prompt_caching: PromptCaching | None = None
    forced_tool_choice: bool | None = None
    native_structured_output: bool | None = None
    server_side_summary: bool | None = None
    reasoning: ReasoningCapability = ReasoningCapability()


@dataclass(frozen=True, kw_only=True)
class ModelLimits:
    """Size limits of the model.

    Attributes:
        context_window: Context window size in tokens.
        max_output_tokens: Largest output token count the model accepts. Providers that need a
            default for it use it.
    """

    context_window: int | None = None
    max_output_tokens: int | None = None


@dataclass(frozen=True, kw_only=True)
class ModelInfo:
    """Everything the SDK knows about a model.

    Read it from :attr:`strands.models.Model.model_info`.

    Both sections are always present; when nothing is known about one, every fact in it is None
    (``capabilities.reasoning`` is a nested record that is always present too).

    Attributes:
        capabilities: What the model can do.
        limits: Size limits of the model.
    """

    capabilities: ModelCapabilities = ModelCapabilities()
    limits: ModelLimits = ModelLimits()

    @classmethod
    def merge(cls, *parts: "ModelInfo | None") -> "ModelInfo":
        """Merge partial records, later defined fields winning. None and missing fields inherit.

        Args:
            *parts: Partial records, in order of increasing precedence. None entries are skipped.

        Returns:
            A new record whose unknown fields are None.
        """
        for part in parts:
            if part is not None and not isinstance(part, ModelInfo):
                raise TypeError(f"model_info must be a ModelInfo, not {type(part).__name__}")
        known = [part for part in parts if part]
        return cls(
            capabilities=_merge_section([part.capabilities for part in known], ModelCapabilities()),
            limits=_merge_section([part.limits for part in known], ModelLimits()),
        )


_SectionT = TypeVar("_SectionT", ModelCapabilities, ModelLimits, ReasoningCapability)


def _merge_section(parts: list[_SectionT], empty: _SectionT) -> _SectionT:
    """Merge one section of the records, later defined fields winning; the empty section when nothing is known.

    A nested record (``capabilities.reasoning``) merges field by field the same way.
    """
    merged = empty
    for part in parts:
        for field in fields(part):
            value = getattr(part, field.name)
            if isinstance(value, ReasoningCapability):
                value = _merge_section([getattr(merged, field.name), value], ReasoningCapability())
            elif value is None:
                continue
            merged = replace(merged, **{field.name: value})
    return merged


SERVER_SIDE_SUMMARY_OFF = ModelInfo(capabilities=ModelCapabilities(server_side_summary=False))
"""Turns ``server_side_summary`` off for providers that serve a model the shared info lists it for but have no
server-side summary of their own."""

_CAPABILITY_FIELDS = {
    "stateful": "stateful",
    "promptCaching": "prompt_caching",
    "forcedToolChoice": "forced_tool_choice",
    "nativeStructuredOutput": "native_structured_output",
    "serverSideSummary": "server_side_summary",
    "reasoning": "reasoning",
}
_REASONING_FIELDS = {"defaultEffort": "default_effort"}
_LIMIT_FIELDS = {"contextWindow": "context_window", "maxOutputTokens": "max_output_tokens"}
# Shared-data values are camelCase; the Python literals are snake_case.
_PROMPT_CACHING_VALUES: dict[str, PromptCaching] = {
    "unsupported": "unsupported",
    "auto": "auto",
    "cachePoints": "cache_points",
}

# Bedrock appends a version to some ids (`claude-3-5-haiku-20241022-v1:0`); the base id carries the facts.
_VERSION_SUFFIX = re.compile(r"-(?:v\d+(?::\d+)?|\d+:\d+)$")
# Dated snapshots (`claude-opus-5-5-20260401`, `claude-haiku-4-5@20251001`) share the undated model's facts.
_DATE_SUFFIX = re.compile(r"[-@]\d{8}$")


def _section(entry: dict[str, Any], name: str, field_names: dict[str, str], section: type[_SectionT]) -> _SectionT:
    """Build one section of an entry, re-casing its camelCase keys and ignoring facts this version does not know.

    Unknown keys and values are skipped rather than rejected: the data file is shared with the TypeScript SDK, so it can
    carry a fact this version has no field for yet. ``test__model_info.py`` validates the file strictly instead.
    """
    raw = entry.get(name)
    if not isinstance(raw, dict):
        return section()
    known = {field_names[key]: value for key, value in raw.items() if key in field_names}
    if "prompt_caching" in known:
        value = known["prompt_caching"]
        known["prompt_caching"] = _PROMPT_CACHING_VALUES.get(value) if isinstance(value, str) else None
    if "reasoning" in known:
        known["reasoning"] = _section(raw, "reasoning", _REASONING_FIELDS, ReasoningCapability)
    if "default_effort" in known and not isinstance(known["default_effort"], str):
        known["default_effort"] = None
    return section(**known)


def _load_data() -> tuple[int, dict[str, ModelInfo]]:
    """Read the shared model info data, re-casing its camelCase keys onto the record fields."""
    package_copy = resources.files("strands.models").joinpath("model_info.json")
    try:
        raw = package_copy.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise FileNotFoundError(
            f"The model info data is missing from the installed package: {package_copy}. "
            "hatch_build.py copies it from shared/model-info.json when the package is installed or "
            "built, so an environment installed before the copy existed does not have it. Re-install "
            "the package (`pip install -e .`, or `hatch env prune` to rebuild hatch environments)."
        ) from error
    try:
        data = json.loads(raw)
        models = {
            model_id: ModelInfo(
                capabilities=_section(entry, "capabilities", _CAPABILITY_FIELDS, ModelCapabilities),
                limits=_section(entry, "limits", _LIMIT_FIELDS, ModelLimits),
            )
            for model_id, entry in data["models"].items()
        }
        return data["defaults"]["limits"]["contextWindow"], models
    except (ValueError, KeyError, TypeError) as error:
        raise ValueError(
            f"The model info data in the installed package is malformed: {package_copy}. "
            "It is a copy of shared/model-info.json; fix the source and re-install the package."
        ) from error


# Context window limit (in tokens) assumed for a model whose window is unknown, and the known models.
DEFAULT_CONTEXT_WINDOW_LIMIT, _MODELS = _load_data()


def lookup_model(model_id: object) -> ModelInfo | None:
    """Find the entry for a model id.

    Tries the id as given, then without a trailing Bedrock version suffix, then without a trailing
    date, then with each leading dot-separated segment removed in turn
    (``us.anthropic.claude-x`` to ``anthropic.claude-x`` to ``claude-x``). One entry therefore serves
    a model across providers and snapshots: ``claude-opus-5-5`` answers for
    ``anthropic.claude-opus-5-5-20260401-v1:0`` too.

    Args:
        model_id: The model id to look up; a config without one (``None``) is unknown.

    Returns:
        The entry, or None when the id is not in the data.
    """
    if not isinstance(model_id, str):
        return None
    candidate = model_id
    while True:
        unversioned = _VERSION_SUFFIX.sub("", candidate)
        for key in (candidate, unversioned, _DATE_SUFFIX.sub("", unversioned)):
            if key in _MODELS:
                return _MODELS[key]
        dot_index = candidate.find(".")
        if dot_index == -1:
            return None
        candidate = candidate[dot_index + 1 :]


def lookup_model_info(model_id: str) -> ModelInfo:
    """Report what the shared model info data knows about a model, without building one.

    :attr:`strands.models.Model.model_info` is the resolved view once a model exists: it adds what
    the provider declares and the ``model_info`` config override on top of this.

    Args:
        model_id: The model id to describe.

    Returns:
        What the data knows about the model; empty when it knows nothing.
    """
    return ModelInfo.merge(lookup_model(model_id))


def get_context_window_limit(model_id: str) -> int | None:
    """Look up the context window limit for a model id.

    Args:
        model_id: The model id to look up.

    Returns:
        The context window limit in tokens, or None if not known.
    """
    return lookup_model_info(model_id).limits.context_window
