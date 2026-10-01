"""Deprecated alias for :mod:`strands.bidi`."""

import importlib
import importlib.abc
import importlib.machinery
import importlib.util
import sys
import warnings
from collections.abc import Sequence
from types import ModuleType

from strands.bidi import BidiAgent as BidiAgent

from . import agent, hooks, io, models, types

__all__ = ["agent", "hooks", "io", "models", "types"]

_DEPRECATED_PACKAGE = __name__
_STABLE_PACKAGE = "strands.bidi"
# Subpackages that keep a shim file; every other submodule resolves through _StableModuleFinder.
_SHIM_PACKAGES = frozenset(f"{_DEPRECATED_PACKAGE}.{name}" for name in ("agent", "hooks", "io", "models", "types"))


def _stable_name(deprecated_name: str) -> str:
    return _STABLE_PACKAGE + deprecated_name.removeprefix(_DEPRECATED_PACKAGE)


class _StableModuleFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Import deprecated submodule paths as the stable module object, so identity, patching, and pickling hold."""

    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None,
        target: ModuleType | None = None,
    ) -> importlib.machinery.ModuleSpec | None:
        """Claim deprecated submodules that have a stable counterpart and no shim file."""
        if not fullname.startswith(f"{_DEPRECATED_PACKAGE}.") or fullname in _SHIM_PACKAGES:
            return None
        if importlib.util.find_spec(_stable_name(fullname)) is None:
            return None
        return importlib.machinery.ModuleSpec(fullname, self)

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> ModuleType | None:
        """Use the default placeholder module, which exec_module replaces."""
        return None

    def exec_module(self, module: ModuleType) -> None:
        """Replace the placeholder with the stable module."""
        sys.modules[module.__name__] = importlib.import_module(_stable_name(module.__name__))


# Ahead of the path finder, which would otherwise load a second copy of modules under aliased stable packages.
sys.meta_path.insert(0, _StableModuleFinder())

warnings.warn(
    "strands.experimental.bidi is deprecated and will be removed in v1.60.0. Import from strands.bidi instead.",
    DeprecationWarning,
    stacklevel=2,
)
