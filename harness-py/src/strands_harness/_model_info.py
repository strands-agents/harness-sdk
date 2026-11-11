"""The shared model info (``shared/model-info.json``), read directly for the fields the harness uses."""

import json
import re
from importlib import resources
from typing import Any

_VERSION_SUFFIX = re.compile(r"-(?:v\d+(?::\d+)?|\d+:\d+)$")
_DATE_SUFFIX = re.compile(r"[-@]\d{8}$")
_MODELS: dict[str, dict[str, Any]] = json.loads(
    resources.files("strands_harness").joinpath("model_info.json").read_text(encoding="utf-8")
)["models"]


def lookup_model(model_id: str) -> dict[str, Any]:
    """The model's entry, matched by the SDK's rule (version suffix, date, leading segments); empty when unknown."""
    candidate = model_id
    while True:
        unversioned = _VERSION_SUFFIX.sub("", candidate)
        for key in (candidate, unversioned, _DATE_SUFFIX.sub("", unversioned)):
            if key in _MODELS:
                return _MODELS[key]
        dot_index = candidate.find(".")
        if dot_index == -1:
            return {}
        candidate = candidate[dot_index + 1 :]
