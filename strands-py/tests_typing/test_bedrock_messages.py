from typing_extensions import assert_type

from strands.models import BedrockModel
from strands.models._bedrock_messages import BedrockMessagesModel


def annotate(model: BedrockModel.Messages) -> BedrockModel.Messages:
    return model


assert_type(BedrockModel.Messages(model_id="m", max_tokens=1), BedrockMessagesModel)
assert_type(BedrockModel.ConverseStream(), BedrockModel)
