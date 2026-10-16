"""The experimental context_manager aliases resolve to strands.context_manager and warn on access."""

import pytest

import strands.context_manager as context_manager
import strands.experimental.context_manager as experimental_context_manager
from strands.context_manager import presets, types

EXPECTED_INTERNAL = {
    "ContextState": types.ContextState,
    "ContextStrategy": types.ContextStrategy,
    "STRATEGY_PRESET_NAMES": presets.STRATEGY_PRESET_NAMES,
    "StrategyPresetName": presets.StrategyPresetName,
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


def test_public_alias_names_match_stable_exports():
    assert set(experimental_context_manager._PUBLIC_NAMES) == set(context_manager.__all__)


def test_internal_alias_names_are_covered():
    assert set(experimental_context_manager._INTERNAL_NAMES) == set(EXPECTED_INTERNAL)


def test_unknown_attribute_raises():
    with pytest.raises(AttributeError, match="has no attribute"):
        _ = experimental_context_manager.NonExistent
