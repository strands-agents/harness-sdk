# Testing Guidelines - Strands Python SDK

> **IMPORTANT**: When writing tests, you **MUST** follow the guidelines in this document. They keep tests consistent, maintainable, and resilient to unrelated changes.

This document is the authoritative testing reference for the Python SDK. For general development guidance, see [AGENTS.md](../AGENTS.md).

## Test Layout

- **Unit tests** mirror `src/strands/` exactly under `tests/strands/` — `tests/strands/agent/test_agent.py` tests `src/strands/agent/agent.py`. Do not put unit tests anywhere else.
- **Integration tests** live in `tests_integ/`, organized by feature area, and run only in CI (they need real provider credentials). Whole-message-dict assertions in integ tests are especially brittle — see [Assertions](#assertions).
- **Test files are prefixed `test_`**; test functions are prefixed `test_`.

```bash
hatch test                           # Run unit tests
hatch test -c                        # Run with coverage
hatch test tests/strands/agent/      # Run a specific directory
hatch run test-integ                 # Run integration tests
hatch test --all                     # All Python versions (3.10–3.14)
```

## Test Fixtures Quick Reference

Reusable fixtures live in `tests/fixtures/`; shared async/AWS helpers are session-scoped fixtures in `tests/conftest.py`. **Reuse these — do not hand-roll a mock model, hook recorder, or tool.** If you find yourself writing one, check here first.

| Fixture / helper | Location | When to use |
| --- | --- | --- |
| `MockedModelProvider` | `tests/fixtures/mocked_model_provider.py` | Drive the agent loop with a pre-defined sequence of responses (optionally with per-response `Usage` for metrics paths) instead of a real provider |
| `MockHookProvider` | `tests/fixtures/mock_hook_provider.py` | Record hook invocations and assert which lifecycle events fired |
| `MockMultiAgentHookProvider` | `tests/fixtures/mock_multiagent_hook_provider.py` | Same, for multi-agent lifecycle events |
| `MockAgentTool` | `tests/fixtures/mock_agent_tool.py` | A stand-in `AgentTool` when a tool is incidental to the test |
| `MockedSessionRepository` | `tests/fixtures/mock_session_repository.py` | In-memory `SessionRepository` for session/persistence tests |
| `agenerator` | `tests/conftest.py` | Wrap a list as an async generator (feed a `MockedModelProvider.stream` or any `async for`) |
| `alist` | `tests/conftest.py` | Collect an async iterable into a list (`events = await alist(agent.stream_async(...))`) |
| `generate` | `tests/conftest.py` | Drive a sync generator to exhaustion, returning `(yielded_events, return_value)` |
| `moto_env`, `moto_mock_aws` | `tests/conftest.py` | Mock AWS credentials/services with `moto` — never hit real AWS in a unit test |

## Async Tests

Pytest runs in **strict asyncio mode** (the default — `asyncio_mode` is not set). Every coroutine test **MUST** carry an explicit marker:

```python
@pytest.mark.asyncio
async def test_streams_tool_use(agenerator):
    ...
```

A coroutine test without the marker is silently skipped, not run. Consume agent/model streams with the `alist` fixture rather than re-implementing the `async for` collection loop.

## Assertions

**Name the assertion pair `tru_<noun>` / `exp_<noun>`.** This is the one sanctioned exception to the "name every variable for its content" rule — the matched prefixes make arrange/assert pairs scannable. Compute the actual value into `tru_<noun>`, define the expected value as `exp_<noun>`, then compare:

```python
tru_result = agent("hello")
exp_result = {"role": "assistant", "content": [{"text": "hi"}]}
assert tru_result == exp_result
```

The right granularity depends on **who controls the expected shape**:

**When you control the shape, assert the whole object — not field-by-field.** A single equality on the whole structure documents the expected shape and catches unexpected extra fields. Mask only genuinely volatile fields (timestamps, generated ids, metadata) with `unittest.mock.ANY`:

```python
tru_message = result.message
exp_message = {"role": "assistant", "content": [{"text": "abc"}], "metadata": unittest.mock.ANY}
assert tru_message == exp_message
```

**When the shape is an externally-evolving type, assert only the fields the test is about.** This is the natural exception to the rule above: a type like `Message` grows fields the test doesn't care about, so asserting the entire dict couples the test to unrelated churn. If the test is about the text or role, assert just that (`assert result.message["role"] == "assistant"`) — pinning the whole `Message` shape is a recurring source of breakage in `tests_integ/`.

## Test Organization

- **Prefer adding assertions to an existing test over writing a new one.** When a test already sets up the same scenario, extend it with the new assertions rather than duplicating the arrange step in a new test function. Add a separate test only for a distinct behavior, execution path, or error condition.
- **Name tests `test_<method>_<description>`.** The test module already names the subject, so the class/subject should be omitted: `test__init__default_model_id`, `test_update_config_validation_warns_on_unknown_keys`. Add a subject prefix (`test_<subject>_<method>_<description>`) **only** when one module covers several subjects and the bare method name would be ambiguous.
- **Default to flat, module-level functions.** Most of the suite is flat.
- **Use a `class Test<Subject>` only when tests share class-scoped setup or fixtures** — not merely to group related cases (a module already groups them). Inside a class, the method name can drop the redundant subject since the class supplies it.
- **Parametrize repetitive cases** with `@pytest.mark.parametrize` instead of copy-pasting a test body across inputs.
- **Keep tests focused and independent**; import packages at the top of the file.

## Comments in Tests

The evergreen-comment rule applies here too. **Only a regression test for a discovered bug carries an issue reference**. It links the issue it guards against and describes the behavior it now guarantees, never narrating what the code used to do. Prefer `# guards against unbounded retry on a None tool name (#642)` over `# we used to hang on None here`. A test written as part of feature development gets no issue reference.
