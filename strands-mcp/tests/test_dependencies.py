"""Tests for declared runtime dependencies."""

import sys
from pathlib import Path

import pytest
from packaging.requirements import Requirement

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"

# Operators that establish a ceiling, so a new major cannot be resolved into.
UPPER_BOUND_OPERATORS = frozenset({"<", "<=", "==", "~="})


def _mcp_requirement() -> Requirement:
    with PYPROJECT.open("rb") as handle:
        declared = tomllib.load(handle)["project"]["dependencies"]

    for raw in declared:
        requirement = Requirement(raw)
        if requirement.name == "mcp":
            return requirement

    pytest.fail(f"no mcp requirement declared in {PYPROJECT.name}")


def test_mcp_requirement_has_upper_bound():
    """The declared mcp range is capped, so a new major is never resolved into (#3533).

    mcp reorganises its public surface across majors, so an uncapped range
    makes the next untested major a hard import error for every fresh install.
    """
    requirement = _mcp_requirement()

    bounding = sorted(
        specifier.operator for specifier in requirement.specifier if specifier.operator in UPPER_BOUND_OPERATORS
    )

    assert bounding, (
        f"declared requirement '{requirement}' has no upper bound, so a new mcp major "
        f"is resolvable; expected one of {sorted(UPPER_BOUND_OPERATORS)}"
    )


def test_server_imports_resolve_against_installed_mcp():
    """The installed mcp provides the server surface imported at module scope (#3533).

    An intentional canary rather than net-new coverage: test_server.py imports the
    same module, so a missing surface already fails that module at collection. This
    names the failure mode so the diagnosis does not depend on where collection breaks.
    """
    import strands_mcp_server.server  # noqa: F401
