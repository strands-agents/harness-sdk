"""Compatibility tests for the deprecated bidirectional streaming namespace."""

import importlib
import os
import pickle
import subprocess
import sys
import textwrap
import types
import unittest.mock
from pathlib import Path

import pytest

_MODULE_PATHS = (
    "_async",
    "_async._task_group",
    "_async._task_pool",
    "_audio",
    "_audio.buffer",
    "_audio.processor",
    "_telemetry",
    "agent._blocks",
    "agent._restart_timer",
    "agent.agent",
    "agent.loop",
    "hooks.events",
    "io.audio",
    "io.configs",
    "io.console",
    "io.console._display",
    "io.console._io",
    "io.console._keyboard",
    "models.configs",
    "models.google",
    "models.model",
    "models.openai",
    "types.agent",
    "types.content",
    "types.events",
    "types.io",
    "types.media",
)

_OWNER_MODULES = ("agent", "hooks", "io", "models", "types")


def _subprocess_env() -> dict[str, str]:
    project_root = Path(__file__).resolve().parents[4]
    python_path = str(project_root / "src")
    env = os.environ.copy()
    if existing_python_path := env.get("PYTHONPATH"):
        python_path = os.pathsep.join((python_path, existing_python_path))
    env["PYTHONPATH"] = python_path
    return env


@pytest.fixture
def pyaudio_stub(monkeypatch):
    """Stand in for the native PyAudio dependency, which the test environment does not install."""
    pyaudio = types.ModuleType("pyaudio")
    pyaudio.PyAudio = object
    pyaudio.Stream = object
    monkeypatch.setitem(sys.modules, "pyaudio", pyaudio)


@pytest.mark.parametrize("module_path", _MODULE_PATHS)
def test_leaf_module_is_stable_module(module_path, pyaudio_stub):
    old_module = importlib.import_module(f"strands.experimental.bidi.{module_path}")
    new_module = importlib.import_module(f"strands.bidi.{module_path}")

    assert old_module is new_module


def test_missing_submodule_raises_for_deprecated_name():
    with pytest.raises(ModuleNotFoundError) as error:
        importlib.import_module("strands.experimental.bidi.models.missing")

    assert error.value.name == "strands.experimental.bidi.models.missing"


@pytest.mark.parametrize("owner_name", _OWNER_MODULES)
def test_owner_package_is_shim(owner_name):
    old_owner = importlib.import_module(f"strands.experimental.bidi.{owner_name}")
    new_owner = importlib.import_module(f"strands.bidi.{owner_name}")

    assert old_owner is not new_owner
    assert Path(old_owner.__file__).parent.name == owner_name
    assert "experimental" in Path(old_owner.__file__).parts


def test_root_and_owner_exports_are_same_objects(pyaudio_stub):
    old_root = importlib.import_module("strands.experimental.bidi")
    new_root = importlib.import_module("strands.bidi")

    assert old_root.BidiAgent is new_root.BidiAgent
    assert old_root.__all__ == ["agent", "hooks", "io", "models", "types"]

    for owner_name in _OWNER_MODULES:
        old_owner = importlib.import_module(f"strands.experimental.bidi.{owner_name}")
        new_owner = importlib.import_module(f"strands.bidi.{owner_name}")
        assert old_owner.__all__ == new_owner.__all__
        for public_name in new_owner.__all__:
            assert getattr(old_owner, public_name) is getattr(new_owner, public_name)


def test_lazy_model_exports_are_same_objects():
    old_models = importlib.import_module("strands.experimental.bidi.models")
    new_models = importlib.import_module("strands.bidi.models")

    for model_name in ("GoogleGeminiLiveModel", "OpenAIRealtimeModel"):
        assert getattr(old_models, model_name) is getattr(new_models, model_name)


def test_bedrock_alias_matches_supported_version_behavior():
    new_module_name = "strands.bidi.models.bedrock"
    old_module_name = "strands.experimental.bidi.models.bedrock"

    if sys.version_info >= (3, 12):
        assert importlib.import_module(old_module_name) is importlib.import_module(new_module_name)
        return

    with pytest.raises(ImportError) as new_error:
        importlib.import_module(new_module_name)
    with pytest.raises(ImportError) as old_error:
        importlib.import_module(old_module_name)

    assert str(old_error.value) == str(new_error.value)


def test_old_leaf_patch_target_updates_stable_module():
    new_module = importlib.import_module("strands.bidi.models.openai")

    with unittest.mock.patch(
        "strands.experimental.bidi.models.openai.time.time",
        return_value=123.0,
    ):
        assert new_module.time.time() == 123.0


def test_old_pickle_module_path_resolves_stable_class():
    from strands.bidi.types import AudioDelta

    serialized_class = b"cstrands.experimental.bidi.types.media\nAudioDelta\n."

    assert pickle.loads(serialized_class) is AudioDelta


def test_old_root_star_import_keeps_historical_exports():
    namespace: dict[str, object] = {}

    exec("from strands.experimental.bidi import *", namespace)

    assert "BidiAgent" not in namespace
    assert set(_OWNER_MODULES).issubset(namespace)


def test_import_order_preserves_leaf_identity(tmp_path):
    script = tmp_path / "check_import_order.py"
    script.write_text(
        textwrap.dedent(
            """
            import importlib
            import sys

            old_first = sys.argv[1] == "old"
            first = "strands.experimental.bidi" if old_first else "strands.bidi"
            second = "strands.bidi" if old_first else "strands.experimental.bidi"
            importlib.import_module(first)
            importlib.import_module(second)

            old = importlib.import_module("strands.experimental.bidi.models.openai")
            new = importlib.import_module("strands.bidi.models.openai")
            assert old is new
            """
        ),
        encoding="utf-8",
    )

    for first_namespace in ("old", "new"):
        subprocess.run(
            [sys.executable, str(script), first_namespace],
            check=True,
            env=_subprocess_env(),
        )


def test_deprecation_warning_fires_once_at_importer(tmp_path):
    script = tmp_path / "check_warning.py"
    script.write_text(
        textwrap.dedent(
            """
            import warnings

            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                import strands.experimental.bidi
                import strands.experimental.bidi.io
                import strands.experimental.bidi.models.openai

            bidi_warnings = [w for w in caught if "strands.experimental.bidi" in str(w.message)]
            assert len(bidi_warnings) == 1, bidi_warnings
            warning = bidi_warnings[0]
            assert warning.category is DeprecationWarning
            assert "strands.experimental.bidi is deprecated" in str(warning.message)
            assert "strands.bidi" in str(warning.message)
            assert "v1.60.0" in str(warning.message)
            assert warning.filename == __file__, warning.filename
            """
        ),
        encoding="utf-8",
    )

    subprocess.run([sys.executable, str(script)], check=True, env=_subprocess_env())


def test_old_package_imports_do_not_load_optional_dependencies(tmp_path):
    script = tmp_path / "check_optional_dependencies.py"
    script.write_text(
        textwrap.dedent(
            """
            import sys

            import strands.experimental.bidi
            import strands.experimental.bidi.io

            optional_modules = (
                "aws_sdk_bedrock_runtime",
                "google.genai",
                "prompt_toolkit",
                "pyaudio",
                "websockets",
            )
            loaded = [name for name in optional_modules if name in sys.modules]
            assert not loaded, loaded
            """
        ),
        encoding="utf-8",
    )

    subprocess.run([sys.executable, str(script)], check=True, env=_subprocess_env())


def test_stable_import_does_not_load_deprecated_namespace(tmp_path):
    script = tmp_path / "check_stable_import.py"
    script.write_text(
        textwrap.dedent(
            """
            import sys
            import warnings

            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                import strands
                import strands.bidi

            assert "strands.experimental.bidi" not in sys.modules
            bidi_warnings = [w for w in caught if "strands.experimental.bidi" in str(w.message)]
            assert not bidi_warnings, bidi_warnings
            """
        ),
        encoding="utf-8",
    )

    subprocess.run([sys.executable, str(script)], check=True, env=_subprocess_env())


def test_repository_does_not_import_deprecated_namespace():
    project_root = Path(__file__).resolve().parents[4]
    source_root = project_root / "src"
    shim_root = source_root / "strands" / "experimental" / "bidi"
    excluded_files = {
        Path(__file__).resolve(),
        project_root / "tests_typing" / "bidi" / "test_deprecated_alias.py",
    }
    forbidden_patterns = (
        "strands.experimental.bidi",
        ".experimental.bidi",
        ".experimental import bidi",
    )
    violations = []

    for scan_root in (
        source_root,
        project_root / "tests",
        project_root / "tests_integ",
        project_root / "tests_typing",
    ):
        for source_file in scan_root.rglob("*.py"):
            resolved_file = source_file.resolve()
            if resolved_file in excluded_files or resolved_file.is_relative_to(shim_root):
                continue
            source = source_file.read_text(encoding="utf-8")
            if any(pattern in source for pattern in forbidden_patterns):
                violations.append(str(source_file.relative_to(project_root)))

    assert violations == []
