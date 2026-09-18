"""Tests for the ActorMemory plugin."""

import json
from unittest.mock import MagicMock

import pytest

from strands.hooks.events import BeforeInvocationEvent
from strands.hooks.registry import HookRegistry
from strands.storage import InMemoryStorage, S3Storage, Storage
from strands.vended_plugins.actor_memory import ActorMemory


@pytest.fixture
def s3_bucket():
    """Create a moto-mocked S3 bucket."""
    import boto3
    from moto import mock_aws

    with mock_aws():
        session = boto3.Session(region_name="us-east-1")
        client = session.client("s3")
        client.create_bucket(Bucket="test-bucket")
        yield session


def _mock_agent(system_prompt: str | list | None = "You are an agent."):
    """Create a mock agent exposing the properties/state ActorMemory depends on."""
    agent = MagicMock()
    _set_system_prompt(agent, system_prompt)

    type(agent).system_prompt = property(
        lambda self: self._system_prompt,
        lambda self, value: _set_system_prompt(self, value),
    )
    type(agent).system_prompt_content = property(lambda self: self._system_prompt_content)

    agent.hooks = HookRegistry()
    agent.add_hook = MagicMock(
        side_effect=lambda callback, event_type=None: agent.hooks.add_callback(event_type, callback)
    )
    agent.tool_registry = MagicMock()
    agent.tool_registry.process_tools = MagicMock(return_value=["remember"])

    state_store: dict[str, object] = {}
    agent.state = MagicMock()
    agent.state.get = MagicMock(side_effect=lambda key: state_store.get(key))
    agent.state.set = MagicMock(side_effect=lambda key, value: state_store.__setitem__(key, value))
    return agent


def _set_system_prompt(agent: MagicMock, value: str | list | None) -> None:
    """Simulate the Agent.system_prompt setter (string or content-block list)."""
    if isinstance(value, str):
        agent._system_prompt = value
        agent._system_prompt_content = [{"text": value}]
    elif isinstance(value, list):
        text_parts = [block["text"] for block in value if "text" in block]
        agent._system_prompt = "\n".join(text_parts) if text_parts else None
        agent._system_prompt_content = value
    else:
        agent._system_prompt = None
        agent._system_prompt_content = None


async def _read_facts(storage: Storage, actor_id: str) -> list[str]:
    """Read facts straight from storage, using the documented actor_memory/<actor_id>/facts.json key."""
    raw = await storage.read(f"actor_memory/{actor_id}/facts.json")
    return json.loads(raw) if raw else []


async def _attach(plugin: ActorMemory, agent: MagicMock) -> None:
    """Attach a plugin to a mock agent, registering its hooks the way the plugin registry does."""
    await plugin.init_agent(agent)
    for callback in plugin.hooks:
        agent.add_hook(callback)


async def _run_before_invocation(agent: MagicMock) -> None:
    """Dispatch a BeforeInvocationEvent through the agent's public hook registry."""
    await agent.hooks.invoke_callbacks_async(BeforeInvocationEvent(agent=agent))


class TestActorMemoryInit:
    """Tests for ActorMemory initialization."""

    def test_rejects_empty_actor_id(self):
        with pytest.raises(ValueError, match="actor_id is not a valid actor identifier"):
            ActorMemory(actor_id="")

    def test_rejects_actor_id_with_path_separator(self):
        with pytest.raises(ValueError, match="cannot contain path separators"):
            ActorMemory(actor_id="a/b")

    @pytest.mark.parametrize("bad_id", [".", "..", "   "])
    def test_rejects_relative_or_blank_actor_id(self, bad_id):
        with pytest.raises(ValueError, match="actor_id is not a valid actor identifier"):
            ActorMemory(actor_id=bad_id)

    @pytest.mark.asyncio
    async def test_default_storage_is_local_file_storage(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        plugin = ActorMemory(actor_id="actor-1")
        agent = _mock_agent()
        agent.storage = None
        await plugin.init_agent(agent)

        await plugin.remember(fact="prefers Spanish")

        # A default-configured LocalFileStorage, read directly, should see the same fact,
        # proving init_agent fell back to a local file backend rather than erroring or
        # keeping facts only in memory.
        from strands.storage import LocalFileStorage

        assert await _read_facts(LocalFileStorage(), "actor-1") == ["prefers Spanish"]

    @pytest.mark.asyncio
    async def test_init_agent_uses_agent_storage_when_not_explicit(self):
        storage = InMemoryStorage()
        plugin = ActorMemory(actor_id="actor-1")
        agent = _mock_agent()
        agent.storage = storage
        await plugin.init_agent(agent)

        await plugin.remember(fact="prefers Spanish")

        assert await _read_facts(storage, "actor-1") == ["prefers Spanish"]

    @pytest.mark.asyncio
    async def test_custom_storage_is_used(self):
        storage = InMemoryStorage()
        plugin = ActorMemory(actor_id="actor-1", storage=storage)

        await plugin.remember(fact="prefers Spanish")

        assert await _read_facts(storage, "actor-1") == ["prefers Spanish"]

    @pytest.mark.asyncio
    async def test_explicit_storage_takes_precedence_over_agent_storage(self):
        explicit_storage = InMemoryStorage()
        agent_storage = InMemoryStorage()
        plugin = ActorMemory(actor_id="actor-1", storage=explicit_storage)
        agent = _mock_agent()
        agent.storage = agent_storage
        await plugin.init_agent(agent)

        await plugin.remember(fact="prefers Spanish")

        assert await _read_facts(explicit_storage, "actor-1") == ["prefers Spanish"]
        assert await _read_facts(agent_storage, "actor-1") == []

    @pytest.mark.asyncio
    async def test_remember_before_init_agent_raises(self):
        plugin = ActorMemory(actor_id="actor-1")
        with pytest.raises(RuntimeError, match="requires a storage backend"):
            await plugin.remember(fact="prefers Spanish")


class TestActorMemoryRemember:
    """Tests for the remember tool."""

    @pytest.mark.asyncio
    async def test_remember_persists_a_fact(self):
        storage = InMemoryStorage()
        plugin = ActorMemory(actor_id="actor-1", storage=storage)

        await plugin.remember(fact="prefers Spanish")

        assert await _read_facts(storage, "actor-1") == ["prefers Spanish"]

    @pytest.mark.asyncio
    async def test_remember_is_idempotent(self):
        storage = InMemoryStorage()
        plugin = ActorMemory(actor_id="actor-1", storage=storage)

        await plugin.remember(fact="prefers Spanish")
        await plugin.remember(fact="prefers Spanish")

        assert await _read_facts(storage, "actor-1") == ["prefers Spanish"]

    @pytest.mark.asyncio
    async def test_repeated_reads_hit_storage_once(self):
        """After the first load, remember() and the before-invocation hook reuse the in-process cache."""
        storage = InMemoryStorage()
        plugin = ActorMemory(actor_id="actor-1", storage=storage)
        real_read = storage.read
        read_calls = 0

        async def counting_read(key):
            nonlocal read_calls
            read_calls += 1
            return await real_read(key)

        storage.read = counting_read

        await plugin.remember(fact="prefers Spanish")
        await plugin.remember(fact="likes coffee")
        agent = _mock_agent()
        await _attach(plugin, agent)
        await _run_before_invocation(agent)
        await _run_before_invocation(agent)

        assert read_calls == 1

    @pytest.mark.asyncio
    async def test_remember_trims_to_max_facts(self):
        storage = InMemoryStorage()
        plugin = ActorMemory(actor_id="actor-1", storage=storage, max_facts=2)

        await plugin.remember(fact="fact-1")
        await plugin.remember(fact="fact-2")
        await plugin.remember(fact="fact-3")

        assert await _read_facts(storage, "actor-1") == ["fact-2", "fact-3"]

    @pytest.mark.asyncio
    async def test_facts_persist_across_plugin_instances(self):
        """Different ActorMemory instances sharing storage + actor_id see the same facts."""
        storage = InMemoryStorage()
        first = ActorMemory(actor_id="actor-1", storage=storage)
        await first.remember(fact="prefers Spanish")

        # A second instance, with no in-process cache of its own, must load the existing
        # fact from storage first -- otherwise remembering it again here would duplicate it.
        second = ActorMemory(actor_id="actor-1", storage=storage)
        await second.remember(fact="prefers Spanish")

        assert await _read_facts(storage, "actor-1") == ["prefers Spanish"]

    @pytest.mark.asyncio
    async def test_different_actors_do_not_share_facts(self):
        storage = InMemoryStorage()
        actor_one = ActorMemory(actor_id="actor-1", storage=storage)
        _ = ActorMemory(actor_id="actor-2", storage=storage)

        await actor_one.remember(fact="prefers Spanish")

        assert await _read_facts(storage, "actor-1") == ["prefers Spanish"]
        assert await _read_facts(storage, "actor-2") == []

    @pytest.mark.asyncio
    async def test_remember_persists_to_s3(self, s3_bucket):
        storage = S3Storage("test-bucket", prefix="agents/", boto_session=s3_bucket)
        plugin = ActorMemory(actor_id="juan", storage=storage)

        await plugin.remember(fact="prefers Spanish")

        # Read back through a fresh plugin instance to prove it round-tripped through S3,
        # not just the in-process cache.
        reloaded = ActorMemory(actor_id="juan", storage=storage)
        await reloaded.remember(fact="prefers Spanish")

        assert await _read_facts(storage, "juan") == ["prefers Spanish"]


class TestActorMemoryInjection:
    """Tests for system-prompt injection before each invocation."""

    @pytest.mark.asyncio
    async def test_injects_remembered_facts_into_string_prompt(self):
        plugin = ActorMemory(actor_id="actor-1", storage=InMemoryStorage())
        await plugin.remember(fact="prefers Spanish")
        agent = _mock_agent(system_prompt="You are an agent.")
        await _attach(plugin, agent)

        await _run_before_invocation(agent)

        assert "You are an agent." in agent.system_prompt
        assert "prefers Spanish" in agent.system_prompt

    @pytest.mark.asyncio
    async def test_injects_remembered_facts_into_content_block_prompt(self):
        plugin = ActorMemory(actor_id="actor-1", storage=InMemoryStorage())
        await plugin.remember(fact="prefers Spanish")
        agent = _mock_agent(system_prompt=[{"text": "You are an agent."}])
        await _attach(plugin, agent)

        await _run_before_invocation(agent)

        blocks = agent.system_prompt_content
        assert {"text": "You are an agent."} in blocks
        assert any("prefers Spanish" in block.get("text", "") for block in blocks)

    @pytest.mark.asyncio
    async def test_no_injection_when_no_facts_remembered(self):
        plugin = ActorMemory(actor_id="actor-1", storage=InMemoryStorage())
        agent = _mock_agent(system_prompt="You are an agent.")
        await _attach(plugin, agent)

        await _run_before_invocation(agent)

        assert agent.system_prompt == "You are an agent."

    @pytest.mark.asyncio
    async def test_reinjection_does_not_duplicate_facts(self):
        plugin = ActorMemory(actor_id="actor-1", storage=InMemoryStorage())
        await plugin.remember(fact="prefers Spanish")
        agent = _mock_agent(system_prompt="You are an agent.")
        await _attach(plugin, agent)

        await _run_before_invocation(agent)
        await _run_before_invocation(agent)

        assert agent.system_prompt.count("prefers Spanish") == 1

    @pytest.mark.asyncio
    async def test_reinjection_picks_up_newly_remembered_facts(self):
        plugin = ActorMemory(actor_id="actor-1", storage=InMemoryStorage())
        agent = _mock_agent(system_prompt="You are an agent.")
        await _attach(plugin, agent)

        await _run_before_invocation(agent)
        await plugin.remember(fact="prefers Spanish")
        await _run_before_invocation(agent)

        assert "prefers Spanish" in agent.system_prompt
        assert agent.system_prompt.count("You are an agent.") == 1
