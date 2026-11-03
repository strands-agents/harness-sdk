from strands.types.content import TextBlock


def test_text_block_to_dict():
    block = TextBlock("Hello")

    tru_content = block.to_dict()
    exp_content = {"text": "Hello"}
    assert tru_content == exp_content


def test_text_block_to_dict_with_metadata():
    metadata = {"providerData": {"provider": "anthropic", "data": {"type": "compaction", "content": "summary"}}}
    block = TextBlock("Hello", metadata=metadata)

    tru_content = block.to_dict()
    exp_content = {"text": "Hello", "metadata": metadata}
    assert tru_content == exp_content
