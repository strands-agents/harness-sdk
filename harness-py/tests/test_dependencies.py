"""Tests for declared runtime dependencies."""

import sys
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

_HARNESS = Path(__file__).resolve().parents[1] / "pyproject.toml"
_SDK = Path(__file__).resolve().parents[2] / "strands-py" / "pyproject.toml"


def _project(path: Path) -> dict:
    with path.open("rb") as handle:
        return tomllib.load(handle)["project"]


def test_the_sdk_otel_extra_is_repeated_by_name():
    """Packagers without extras see only the names listed here, so the extra is mirrored verbatim."""
    otel = _project(_SDK)["optional-dependencies"]["otel"]

    missing = sorted(set(otel) - set(_project(_HARNESS)["dependencies"]))

    assert not missing, f"copy these from the otel extra in {_SDK} into the harness dependencies: {missing}"
