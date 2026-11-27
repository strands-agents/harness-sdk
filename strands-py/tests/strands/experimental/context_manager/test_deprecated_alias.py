"""Compatibility tests for the deprecated context-manager namespace."""

import importlib
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

_HISTORICAL_EXPORTS = [
    "ContextManager",
    "ContextManagerConfig",
    "ContextState",
    "ContextStrategy",
    "Offload",
    "OffloadConditions",
    "OffloadStrategy",
    "OffloadTarget",
    "STRATEGY_PRESET_NAMES",
    "StashConfig",
    "StrategyPresetName",
    "SummarizeConfig",
    "TruncateConfig",
]

_RENAMED_EXPORTS = {"StashConfig": "ArchiveConfig"}


def _subprocess_env() -> dict[str, str]:
    project_root = Path(__file__).resolve().parents[4]
    python_path = str(project_root / "src")
    env = os.environ.copy()
    if existing_python_path := env.get("PYTHONPATH"):
        python_path = os.pathsep.join((python_path, existing_python_path))
    env["PYTHONPATH"] = python_path
    return env


def test_deprecated_surface_keeps_historical_exports():
    old_module = importlib.import_module("strands.experimental.context_manager")

    assert old_module.__all__ == _HISTORICAL_EXPORTS


def test_exports_are_the_stable_objects():
    old_module = importlib.import_module("strands.experimental.context_manager")
    new_module = importlib.import_module("strands.context_manager")

    for export_name in _HISTORICAL_EXPORTS:
        stable_name = _RENAMED_EXPORTS.get(export_name, export_name)
        assert getattr(old_module, export_name) is getattr(new_module, stable_name)


def test_deprecation_warning_fires_once_at_importer(tmp_path):
    script = tmp_path / "check_warning.py"
    script.write_text(
        textwrap.dedent(
            """
            import warnings

            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                import strands.experimental.context_manager
                import strands.experimental.context_manager

            alias_warnings = [w for w in caught if "strands.experimental.context_manager" in str(w.message)]
            assert len(alias_warnings) == 1, alias_warnings
            warning = alias_warnings[0]
            assert warning.category is DeprecationWarning
            assert "strands.experimental.context_manager is deprecated" in str(warning.message)
            assert "strands.context_manager" in str(warning.message)
            assert "v1.68.0" in str(warning.message)
            assert warning.filename == __file__, warning.filename
            """
        ),
        encoding="utf-8",
    )

    subprocess.run([sys.executable, str(script)], check=True, env=_subprocess_env())


def test_parent_package_resolves_the_alias_by_attribute(tmp_path):
    script = tmp_path / "check_attribute_access.py"
    script.write_text(
        textwrap.dedent(
            """
            import warnings

            import strands.experimental

            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                alias = strands.experimental.context_manager

            assert alias.ContextManager is not None
            alias_warnings = [w for w in caught if "strands.experimental.context_manager" in str(w.message)]
            assert len(alias_warnings) == 1, alias_warnings
            """
        ),
        encoding="utf-8",
    )

    subprocess.run([sys.executable, str(script)], check=True, env=_subprocess_env())


def test_unknown_experimental_attribute_raises_attribute_error():
    experimental = importlib.import_module("strands.experimental")

    with pytest.raises(AttributeError, match="has no attribute 'not_a_submodule'"):
        _ = experimental.not_a_submodule


def test_stable_import_does_not_load_deprecated_namespace(tmp_path):
    script = tmp_path / "check_stable_import.py"
    script.write_text(
        textwrap.dedent(
            """
            import sys
            import warnings

            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                import strands.context_manager
                import strands.experimental

            assert "strands.experimental.context_manager" not in sys.modules
            alias_warnings = [w for w in caught if "strands.experimental.context_manager" in str(w.message)]
            assert not alias_warnings, alias_warnings
            """
        ),
        encoding="utf-8",
    )

    subprocess.run([sys.executable, str(script)], check=True, env=_subprocess_env())


def test_repository_does_not_import_deprecated_namespace():
    project_root = Path(__file__).resolve().parents[4]
    source_root = project_root / "src"
    shim_root = source_root / "strands" / "experimental" / "context_manager"
    # The parent package names the alias so it can import it on attribute access; that it stays
    # unimported until then is covered by test_stable_import_does_not_load_deprecated_namespace.
    exempt_files = (
        Path(__file__).resolve(),
        (source_root / "strands" / "experimental" / "__init__.py").resolve(),
    )
    forbidden_patterns = (
        "strands.experimental.context_manager",
        ".experimental.context_manager",
        ".experimental import context_manager",
    )
    violations = []

    for scan_root in (source_root, project_root / "tests", project_root / "tests_integ", project_root / "tests_typing"):
        for source_file in scan_root.rglob("*.py"):
            resolved_file = source_file.resolve()
            if resolved_file in exempt_files or resolved_file.is_relative_to(shim_root):
                continue
            if any(pattern in source_file.read_text(encoding="utf-8") for pattern in forbidden_patterns):
                violations.append(str(source_file.relative_to(project_root)))

    assert violations == []
