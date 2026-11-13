import json

from strands.types.content import ContentBlock, InjectedBlock, TextBlock


def test_text_block_to_dict():
    block = TextBlock("Hello")

    tru_content = block.to_dict()
    exp_content = {"text": "Hello"}
    assert tru_content == exp_content


def test_injected_content_is_kept_under_injected_and_round_trips_through_json():
    block = ContentBlock(injected=InjectedBlock(text="reminder", source="test"))

    assert block == {"injected": {"text": "reminder", "source": "test"}}
    assert json.loads(json.dumps(block)) == block
