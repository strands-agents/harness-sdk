import pytest

from strands.hooks import BeforeToolCallEvent, HookProvider


@pytest.fixture
def cancel_hook():
    class Hook(HookProvider):
        def register_hooks(self, registry):
            registry.add_callback(BeforeToolCallEvent, self.cancel)

        def cancel(self, event):
            event.cancel_tool = "cancelled tool call"

    return Hook()
