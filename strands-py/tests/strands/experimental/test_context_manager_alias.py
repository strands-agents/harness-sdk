"""The experimental context_manager aliases resolve to strands.context_manager and warn on access."""

import pytest

import strands.context_manager as context_manager
import strands.experimental.context_manager as experimental_context_manager
from strands.context_manager import _presets, _types
from strands.context_manager._strategies.offload import base as offload_base

EXPECTED_INTERNAL = {
    "ContextState": _types.ContextState,
    "ContextStrategy": _types.ContextStrategy,
    "OffloadConditions": offload_base.OffloadConditions,
    "STRATEGY_PRESET_NAMES": _presets.STRATEGY_PRESET_NAMES,
    "StrategyPresetName": _presets.StrategyPresetName,
}


@pytest.mark.parametrize("name", sorted(experimental_context_manager._PUBLIC_NAMES))
def test_public_alias_warns_and_resolves_to_stable(name):
    with pytest.warns(DeprecationWarning, match=f"Import {name} from strands.context_manager"):
        aliased = getattr(experimental_context_manager, name)

    assert aliased is getattr(context_manager, name)


@pytest.mark.parametrize("name", sorted(EXPECTED_INTERNAL))
def test_internal_alias_warns_and_resolves_to_definition(name):
    with pytest.warns(DeprecationWarning, match="has no public replacement"):
        aliased = getattr(experimental_context_manager, name)

    assert aliased is EXPECTED_INTERNAL[name]


@pytest.mark.parametrize("name", sorted(experimental_context_manager._DEPRECATED_NAMES))
def test_alias_warning_links_migration_guide(name):
    with pytest.warns(DeprecationWarning, match="context-management/#updating-experimental-imports"):
        getattr(experimental_context_manager, name)


def test_public_alias_names_match_stable_exports():
    assert set(experimental_context_manager._PUBLIC_NAMES) == set(context_manager.__all__)


def test_internal_alias_names_are_covered():
    assert set(experimental_context_manager._INTERNAL_NAMES) == set(EXPECTED_INTERNAL)


def test_unknown_attribute_raises():
    with pytest.raises(AttributeError, match="has no attribute"):
        _ = experimental_context_manager.NonExistent
