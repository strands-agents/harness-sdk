from typing_extensions import assert_type

from strands.models import BedrockModel
from strands.models._bedrock_messages import BedrockMessagesModel
from strands.models._bedrock_openai import BedrockChatCompletionsModel, BedrockResponsesModel


def annotate(
    messages: BedrockModel.Messages, chat: BedrockModel.ChatCompletions, responses: BedrockModel.Responses
) -> None:
    pass


assert_type(BedrockModel.Messages(model_id="m", max_tokens=1), BedrockMessagesModel)
assert_type(BedrockModel.ChatCompletions(model_id="m"), BedrockChatCompletionsModel)
assert_type(BedrockModel.Responses(model_id="m"), BedrockResponsesModel)
assert_type(BedrockModel.ConverseStream(), BedrockModel)
