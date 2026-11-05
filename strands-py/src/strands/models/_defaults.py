"""Model metadata resolution for provider configs.

The facts come from the shared model info data (see :mod:`strands.models._model_info`); this module
fills them onto a provider's config dict.
"""

from collections.abc import Mapping
from typing import TypeVar, cast

from ._model_info import (
    DEFAULT_CONTEXT_WINDOW_LIMIT,
    ModelInfo,
    get_context_window_limit,
    lookup_model_info,
)

__all__ = [
    "DEFAULT_CONTEXT_WINDOW_LIMIT",
    "get_context_window_limit",
    "resolve_config_metadata",
    "resolve_max_tokens",
]

_C = TypeVar("_C", bound=Mapping[str, object])


def resolve_config_metadata(config: _C, model_id: str) -> _C:
    """Fill ``context_window_limit`` on a config dict when it is not explicitly set.

    ``get_config()["context_window_limit"]`` carries the resolved limit for callers that read the
    config. The filled value is resolved through every layer below the user's (the shared model info,
    then the ``model_info`` override), so :attr:`strands.models.Model.model_info` can take it at face
    value. Returns a new dict only when there is something to fill; otherwise returns the original
    config to avoid unnecessary allocation.

    Args:
        config: The stored model config dict.
        model_id: The model ID to look up.

    Returns:
        The config with the limit filled in, or the original config if there is nothing to fill.
    """
    if "context_window_limit" in config:
        return config

    override = cast(ModelInfo | None, config.get("model_info"))
    context_window = ModelInfo.merge(lookup_model_info(model_id), override).limits.context_window
    if context_window is None:
        return config

    return {**config, "context_window_limit": context_window}  # type: ignore[return-value]


def resolve_max_tokens(config: Mapping[str, object], model_id: str) -> int | None:
    """The ``max_tokens`` to send: the configured value, else the model info's output limit, else None.

    A ``max_tokens`` key in the config wins as is, so an explicit ``None`` opts out of the default. The
    default is ``limits.max_output_tokens`` from the shared model info, with the ``model_info`` override
    applied on top; a model the data does not know gets None.

    Args:
        config: The stored model config dict.
        model_id: The model ID to look up.

    Returns:
        The resolved ``max_tokens``, or None when neither the user nor the model info says.
    """
    if "max_tokens" in config:
        return cast(int | None, config["max_tokens"])

    override = cast(ModelInfo | None, config.get("model_info"))
    return ModelInfo.merge(lookup_model_info(model_id), override).limits.max_output_tokens
