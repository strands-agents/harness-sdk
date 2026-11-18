"""Build hook that copies ``shared/model-info.json`` into the package.

``strands_harness/models.py`` loads the copy at import, so it has to be in place for an editable
install as well as a wheel. The copy is git-ignored; ``shared/model-info.json`` at the repository
root is the source of truth.
"""

import shutil
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

_SOURCE = Path("..", "shared", "model-info.json")
_TARGET = Path("src", "strands_harness", "model_info.json")


class ModelInfoBuildHook(BuildHookInterface):  # type: ignore[type-arg]
    """Copies the shared model info data into the package before a build."""

    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        """Copy the shared model info data into the package."""
        root = Path(self.root)
        if not (root / _SOURCE).exists() and (root / _TARGET).exists():
            return  # building from an sdist, which already carries the copy
        shutil.copyfile(root / _SOURCE, root / _TARGET)
