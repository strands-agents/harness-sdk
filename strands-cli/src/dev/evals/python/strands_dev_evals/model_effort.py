from __future__ import annotations

import copy
import importlib
from dataclasses import dataclass, field
from typing import Any

import strands.models

EFFORT_LEVELS = ("auto", "off", "minimal", "low", "medium", "high", "xhigh", "max")
_SUPPORTED_MODELS = (
    ("BedrockModel", "bedrock", "additional_request_fields"),
    ("AnthropicModel", "anthropic", "params"),
    ("OpenAIResponsesModel", "openai", "params"),
)


@dataclass(frozen=True)
class ModelEffort:
    model: Any
    config_key: str = ""
    fields_by_level: dict[str, dict[str, Any]] = field(default_factory=dict)
    unavailable: str | None = None

    @property
    def baseline(self) -> str:
        if self.unavailable is not None:
            return "auto"
        controlled = self._controlled_keys
        current = {key: value for key, value in self._request_fields().items() if key in controlled}
        return next(
            (level for level, fields in self.fields_by_level.items() if level != "auto" and fields == current),
            "auto",
        )

    def options_for(self, level: str) -> dict[str, Any]:
        if level == "auto":
            return {}
        if level not in self.fields_by_level:
            raise ValueError(f"the agent's model has no reasoning level {level!r}")
        return {"model": self._trial_model(self.fields_by_level[level])}

    @property
    def _controlled_keys(self) -> set[str]:
        return {key for fields in self.fields_by_level.values() for key in fields}

    def _request_fields(self) -> dict[str, Any]:
        return self.model.get_config().get(self.config_key) or {}

    def _trial_model(self, level_fields: dict[str, Any]) -> Any:
        controlled = self._controlled_keys
        kept = {key: value for key, value in self._request_fields().items() if key not in controlled}
        merged = _clamp_thinking_budget({**kept, **level_fields}, self.model.get_config().get("max_tokens"))
        trial = copy.copy(self.model)
        trial.config = dict(self.model.config)
        trial.update_config(**{self.config_key: merged})
        return trial


def read_model_effort(model: Any) -> ModelEffort:
    class_name = type(model).__name__
    supported = _provider_and_config_key(model)
    if supported is None:
        return ModelEffort(
            model,
            unavailable=(
                f"the agent's model is a {class_name} object, and strands dev can set effort only on BedrockModel, "
                "AnthropicModel, and OpenAIResponsesModel objects. Tune instructions instead (the default)."
            ),
        )
    provider, config_key = supported
    model_id = model.get_config().get("model_id")
    if not isinstance(model_id, str):
        return ModelEffort(
            model,
            unavailable=(
                f"the agent's {class_name} has no model id, so strands dev cannot look up its reasoning settings. "
                "Tune instructions instead (the default)."
            ),
        )
    spec = f"{provider}/{model_id}"
    fields_by_level, first_error = _read_fields_by_level(spec, config_key)
    if not fields_by_level:
        return ModelEffort(
            model, unavailable=f"strands dev could not read the reasoning settings for {spec}: {first_error}"
        )
    return ModelEffort(model, config_key, fields_by_level)


def _provider_and_config_key(model: Any) -> tuple[str, str] | None:
    for class_name, provider, config_key in _SUPPORTED_MODELS:
        try:
            model_class = getattr(strands.models, class_name)
        except ImportError:
            continue
        if isinstance(model, model_class):
            return provider, config_key
    return None


def _read_fields_by_level(spec: str, config_key: str) -> tuple[dict[str, dict[str, Any]], Exception | None]:
    resolve_model = importlib.import_module("strands_harness.models").resolve_model
    fields_by_level: dict[str, dict[str, Any]] = {}
    errors: list[Exception] = []
    for level in EFFORT_LEVELS:
        if level == "auto":
            continue
        try:
            fields_by_level[level] = resolve_model(spec, spec, effort=level).get_config().get(config_key) or {}
        except Exception as e:
            errors.append(e)
    return fields_by_level, errors[0] if errors else None


def _clamp_thinking_budget(request_fields: dict[str, Any], max_tokens: Any) -> dict[str, Any]:
    thinking = request_fields.get("thinking")
    if not isinstance(max_tokens, int) or not isinstance(thinking, dict) or "budget_tokens" not in thinking:
        return request_fields
    budget = min(thinking["budget_tokens"], max_tokens - 1)
    return {**request_fields, "thinking": {**thinking, "budget_tokens": budget}}
