"""Characterization: ClassifierStrategy sends byte-identical classifier requests across refactors.

The digests were captured from the implementation before request-text projection moved to
``strands.models._request_text``. A change here means the classifier's untrusted-context bounding or
sanitization changed; update the digests only when that change is intended and reviewed.
"""

import hashlib
import json

import pytest

from strands.models import ClassifierStrategy, ModelRouter, RoutingCandidate
from strands.models.routing.classifier_strategy import _ClassifierSelection
from strands.models.routing.strategy import RoutingContext
from tests.fixtures.mocked_model_provider import MockedModelProvider


class _CapturingClassifier(MockedModelProvider):
    def __init__(self):
        super().__init__([])
        self.requests = []

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        self.requests.append({"prompt": prompt, "system_prompt": system_prompt})
        yield {"output": _ClassifierSelection(selected_candidate_index=0)}


CASES = {
    "plain": (
        [{"role": "user", "content": [{"text": "Plan a safe migration"}]}],
        "Be precise",
        "8c7b9813e018e286fb016ec52d81ebd742766fe315519e1fabb1580a44f8c33e",
    ),
    "media_guard_and_tool_result": (
        [
            {"role": "user", "content": [{"text": "old"}]},
            {"role": "assistant", "content": [{"text": "ok"}]},
            {"role": "user", "content": [{"text": "look"}, {"image": {}}, {"guardContent": {"text": {"text": "g"}}}]},
            {"role": "user", "content": [{"toolResult": {"toolUseId": "t", "content": [{"text": "secret"}]}}]},
        ],
        [{"text": "sys a"}, {"cachePoint": {"type": "default"}}, {"text": "sys b"}],
        "bbae1263e3767250e1333644e9375d2fd0d02c7c3801ba93316fd2d9a06d4f9d",
    ),
    "over_budget": (
        [{"role": "user", "content": [{"text": "x" * 9000 + "TAIL"}]}],
        "y" * 9000,
        "f9f0497a2b3b087a6a9b995fc9e03a3ca5889f987aa65f0ae1497067540f5954",
    ),
    "no_request": ([], None, "6775f157e089e9bac0bd9fb1b6a94313d3bc515d8be2749e950e46ab5ffc569a"),
}


@pytest.mark.asyncio
@pytest.mark.parametrize(("messages", "system_prompt", "exp_digest"), CASES.values(), ids=CASES.keys())
async def test_classifier_request_is_unchanged(messages, system_prompt, exp_digest):
    classifier = _CapturingClassifier()
    strategy = ClassifierStrategy(classifier, max_message_chars=500, max_agent_instructions_chars=300)
    router = ModelRouter(
        models=[
            RoutingCandidate(MockedModelProvider([]), name="a", description="A"),
            RoutingCandidate(MockedModelProvider([]), name="b", description="B"),
        ],
        strategy=strategy,
    )
    context = RoutingContext(
        messages=messages,
        system_prompt=system_prompt,
        tool_specs=[],
        candidates=router.candidates,
        invocation_state={},
    )

    await strategy.select(context)

    tru_digest = hashlib.sha256(json.dumps(classifier.requests, sort_keys=True).encode()).hexdigest()
    assert tru_digest == exp_digest
