"""A fake model for auxiliary structured-output calls.

Yields ``{"output": <instance>}`` from ``structured_output`` the way real providers do,
and records what it was asked so tests can assert on prompts and system prompts.
"""

from typing import Any

from strands.types.content import Messages
from strands.types.event_loop import Metrics, Usage


class MockedStructuredOutputModel:
    """Fake ``Model`` whose ``structured_output`` returns a canned instance (or raises).

    Args:
        output: The instance to return. When None, ``output_model(**output_kwargs)`` is built per call.
        error: If set, ``structured_output`` raises it instead of yielding.
        usage: Token usage reported on the terminal ``stop`` event.
        output_kwargs: Constructor kwargs used when ``output`` is None.
    """

    def __init__(
        self,
        output: Any = None,
        *,
        error: BaseException | None = None,
        usage: Usage | None = None,
        **output_kwargs: Any,
    ) -> None:
        self.output = output
        self.error = error
        self.usage = usage or Usage(inputTokens=3, outputTokens=2, totalTokens=5)
        self.output_kwargs = output_kwargs
        self.config: dict[str, Any] = {"model_id": "mocked-structured-output"}
        self.prompts: list[Messages] = []
        self.system_prompts: list[str | None] = []

    @property
    def stateful(self) -> bool:
        return False

    def get_config(self) -> dict[str, Any]:
        return self.config

    def update_config(self, **model_config: Any) -> None:
        self.config.update(model_config)

    async def structured_output(self, output_model: Any, prompt: Messages, system_prompt: str | None = None, **_: Any):
        self.prompts.append(prompt)
        self.system_prompts.append(system_prompt)
        if self.error is not None:
            raise self.error
        output = self.output if self.output is not None else output_model(**self.output_kwargs)
        yield {
            "stop": (
                "end_turn",
                {"role": "assistant", "content": [{"text": ""}]},
                self.usage,
                Metrics(latencyMs=1),
            )
        }
        yield {"output": output}

    async def stream(self, *args: Any, **kwargs: Any):
        raise NotImplementedError("MockedStructuredOutputModel only supports structured_output")
        yield  # pragma: no cover
