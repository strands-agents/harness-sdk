from typing_extensions import assert_type

from strands.experimental.bidi.models import (
    BedrockNovaSonicModel,
    GoogleGeminiLiveModel,
    ModelConfig,
    ModelUpdateConfig,
    OpenAIRealtimeModel,
)


def config_requires_model_id() -> None:
    config = ModelConfig(model_id="model-id")
    assert_type(config["model_id"], str)
    ModelConfig()  # type: ignore[typeddict-item]
    ModelConfig(model_id=None)  # type: ignore[typeddict-item]


def providers_require_model_id() -> None:
    BedrockNovaSonicModel()  # type: ignore[call-arg]
    GoogleGeminiLiveModel()  # type: ignore[call-arg]
    OpenAIRealtimeModel()  # type: ignore[call-arg]

    BedrockNovaSonicModel(model_id=None)  # type: ignore[arg-type]
    GoogleGeminiLiveModel(model_id=None)  # type: ignore[arg-type]
    OpenAIRealtimeModel(model_id=None)  # type: ignore[arg-type]


def providers_accept_partial_updates() -> None:
    updates = ModelUpdateConfig(params={"temperature": 0.5})
    for model in (
        BedrockNovaSonicModel(model_id="model-id"),
        GoogleGeminiLiveModel(model_id="model-id"),
        OpenAIRealtimeModel(model_id="model-id"),
    ):
        assert_type(model.get_config(), ModelConfig)
        model.update_config()
        model.update_config(**updates)
        model.update_config(connection={"restart_after_s": 300})
        model.update_config(model_id="another-model-id")


def providers_reject_invalid_updates(
    model: BedrockNovaSonicModel | GoogleGeminiLiveModel | OpenAIRealtimeModel,
) -> None:
    model.update_config(model_id=None)  # type: ignore[arg-type]
    model.update_config(params="invalid")  # type: ignore[arg-type]
    model.update_config(connection={"restart_after_s": "invalid"})  # type: ignore[typeddict-item]
    model.update_config(unknown_option=True)  # type: ignore[call-arg]
