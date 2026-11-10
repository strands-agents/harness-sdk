import pytest

from strands.hooks import AfterNodeCallEvent, BeforeNodeCallEvent, HookProvider


@pytest.fixture
def interrupt_hook():
    class Hook(HookProvider):
        def __init__(self):
            self.after_count = 0

        def register_hooks(self, registry):
            registry.add_callback(BeforeNodeCallEvent, self.interrupt)
            registry.add_callback(AfterNodeCallEvent, self.cleanup)

        def interrupt(self, event):
            return event.interrupt("test_name", reason="test_reason")

        def cleanup(self, event):
            self.after_count += 1

    return Hook()
