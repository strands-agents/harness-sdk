"""Tests for bidirectional model configuration helpers."""

import copy

import pytest

from strands.experimental.bidi.models.configs import _merge_config, _validate_audio_config, _validate_bidi_config


@pytest.mark.parametrize(
    ("model_config", "invalid_key"),
    [
        pytest.param({"model": "test-model"}, "model", id="model"),
        pytest.param({"connection": {"restart_after": 30}}, "restart_after", id="connection"),
    ],
)
def test__validate_bidi_config_warns_invalid_keys(model_config, invalid_key):
    with pytest.warns(UserWarning, match=invalid_key):
        _validate_bidi_config(model_config)


def test__validate_audio_config_warns_invalid_keys():
    with pytest.warns(UserWarning, match="input_rte"):
        _validate_audio_config({"input_rte": 48000})


@pytest.mark.parametrize(
    ("config", "overrides", "exp_config"),
    [
        pytest.param(
            {"audio": {"voice": "Kore", "format": {"rate": 24000, "channels": 1}}},
            {"audio": {"format": {"rate": 48000}}, "temperature": 0.7},
            {"audio": {"voice": "Kore", "format": {"rate": 48000, "channels": 1}}, "temperature": 0.7},
            id="nested-overrides",
        ),
        pytest.param(
            {"audio": {"voice": "Kore"}},
            {"audio": {}},
            {"audio": {"voice": "Kore"}},
            id="empty-dict-preserves-values",
        ),
        pytest.param(
            {"modalities": ["audio"]},
            {"modalities": ["text"]},
            {"modalities": ["text"]},
            id="list-replacement",
        ),
        pytest.param(
            {"audio": {"voice": "Kore"}},
            {"audio": {"voice": None}},
            {"audio": {"voice": None}},
            id="explicit-none",
        ),
        pytest.param(
            {"speech": "auto"},
            {"speech": {"language": "en-US"}},
            {"speech": {"language": "en-US"}},
            id="dict-replaces-scalar",
        ),
        pytest.param(
            {"speech": {"language": "en-US"}},
            {"speech": "auto"},
            {"speech": "auto"},
            id="scalar-replaces-dict",
        ),
        pytest.param(
            {"temperature": 0.7, "enabled": True},
            {"temperature": 0, "enabled": False},
            {"temperature": 0, "enabled": False},
            id="falsy-overrides",
        ),
    ],
)
def test__merge_config(config, overrides, exp_config):
    tru_config = _merge_config(config, overrides)
    assert tru_config == exp_config


def test__merge_config_copies_inputs():
    config = {"audio": {"formats": ["pcm"]}}
    overrides = {"audio": {"voices": ["Kore"]}}
    exp_config = copy.deepcopy(config)
    exp_overrides = copy.deepcopy(overrides)

    merged = _merge_config(config, overrides)
    merged["audio"]["formats"].append("wav")
    merged["audio"]["voices"].append("Puck")

    assert config == exp_config
    assert overrides == exp_overrides
