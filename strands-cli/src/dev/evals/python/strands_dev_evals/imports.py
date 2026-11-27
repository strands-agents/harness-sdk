from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from .errors import StrandsDevEvalsError

_PYTHON_SUFFIX = ".py"
_PATH_STARTS = (".", "~")
_PATH_SEPARATORS = ("/", "\\")


def import_file(path: Path) -> ModuleType:
    name = f"_strands_dev_evals_{path.stem}_{abs(hash(str(path)))}"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise StrandsDevEvalsError(f"cannot import {path}: it is not a Python file")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[name]
        raise
    return module


def import_attribute(spec: str) -> Any:
    module_part, _, attribute = spec.rpartition(":")
    if not module_part or not attribute:
        raise StrandsDevEvalsError(f"{spec} is not MODULE:ATTRIBUTE, for example evals.py:Tone")
    try:
        module = _module(module_part)
    except Exception as e:
        raise StrandsDevEvalsError(f"cannot import {spec}: {e}") from e
    if not hasattr(module, attribute):
        raise StrandsDevEvalsError(f"cannot import {spec}: {module_part} has no attribute {attribute}")
    return getattr(module, attribute)


def _module(module_part: str) -> ModuleType:
    if _is_path(module_part):
        return import_file(_python_file(module_part))
    return importlib.import_module(module_part)


def _is_path(module_part: str) -> bool:
    return (
        module_part.endswith(_PYTHON_SUFFIX)
        or module_part.startswith(_PATH_STARTS)
        or any(separator in module_part for separator in _PATH_SEPARATORS)
    )


def _python_file(module_part: str) -> Path:
    path = Path(module_part).expanduser().resolve()
    return path if path.suffix == _PYTHON_SUFFIX else path.with_suffix(_PYTHON_SUFFIX)
