Model-backed :class:`Extractor` that distills messages into discrete facts.

A :class:`ModelExtractor` calls a language model with a fact-extraction system prompt and parses the response into :class:`ExtractionResult` entries. Backends that extract server-side should omit the extractor entirely.

## ModelExtractor

```python
class ModelExtractor()
```

Defined in: [src/strands/memory/extraction/model\_extractor.py:39](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/memory/extraction/model_extractor.py#L39)

An :class:`Extractor` that calls a language model to distill messages into discrete facts.

Use for self-managed stores that hold plain text and want automatic distillation.

**Example**:

```python
ExtractionConfig(
    trigger=[InvocationTrigger()],
    extractor=ModelExtractor(model=cheap_model, system_prompt="Extract user preferences."),
)
```

#### \_\_init\_\_

```python
def __init__(model: Model | None = None,
             system_prompt: str | None = None) -> None
```

Defined in: [src/strands/memory/extraction/model\_extractor.py:54](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/memory/extraction/model_extractor.py#L54)

Initialize the extractor.

**Arguments**:

-   `model` - Model used to extract facts. Resolution order: this `model` > :attr:`ExtractorContext.default_model` (`agent.aux_model` > `agent.model`).
-   `system_prompt` - System prompt steering what counts as a fact. Defaults to a general fact-extraction prompt. The JSON output format the extractor parses is always appended after it.

#### extract

```python
async def extract(
        messages: list[Message],
        context: ExtractorContext | None = None) -> list[ExtractionResult]
```

Defined in: [src/strands/memory/extraction/model\_extractor.py:67](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/memory/extraction/model_extractor.py#L67)

Extract entries from a batch of messages.

**Raises**:

-   `ValueError` - If no model is configured and no default is available.
-   `RuntimeError` - If the model returns no response.