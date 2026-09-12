"""Tests for the web_fetch tool."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from bs4 import BeautifulSoup

import strands.agent.agent as agent_module
from strands.sandbox.errors import SandboxTimeoutError
from strands.sandbox.types import ExecutionResult
from strands.types.tools import ToolContext, ToolUse
from strands.vended_tools.web_fetch import (
    WebFetchError,
    make_web_fetch,
)
from strands.vended_tools.web_fetch import _extract as extract_module
from strands.vended_tools.web_fetch._extract import _tag_attribute, html_to_markdown


def _make_execution_result(
    stdout: str = "",
    stderr: str = "",
    exit_code: int = 0,
) -> ExecutionResult:
    return ExecutionResult(exit_code=exit_code, stdout=stdout, stderr=stderr)


def _make_curl_result(
    body: str,
    *,
    content_type: str = "text/plain",
    exit_code: int = 0,
    stderr: str | None = None,
) -> ExecutionResult:
    """Build a mock ExecutionResult matching --write-out '%{stderr}%{content_type}' output:
    body in stdout, content-type in stderr (on success).
    """
    effective_stderr = stderr if stderr is not None else (content_type if exit_code == 0 else "")
    return _make_execution_result(stdout=body, stderr=effective_stderr, exit_code=exit_code)


def _make_sandbox(execute_result: ExecutionResult | Exception | None = None) -> SimpleNamespace:
    if isinstance(execute_result, Exception):
        mock = AsyncMock(side_effect=execute_result)
    else:
        mock = AsyncMock(return_value=execute_result or _make_curl_result(""))
    return SimpleNamespace(execute=mock)


def _make_ctx(sandbox: SimpleNamespace | None = None) -> ToolContext:
    sandbox = sandbox or _make_sandbox()
    agent = SimpleNamespace(model=None, sandbox=sandbox)
    tool_use = ToolUse(toolUseId="test-wf", name="web_fetch", input={})
    return ToolContext(tool_use=tool_use, agent=agent, invocation_state={})


def _raising_beautiful_soup(*args, **kwargs):
    raise ValueError("mock extraction failure")


class TestLazyLoad:
    """web_fetch and make_web_fetch are lazy-loaded via __getattr__."""

    def test_make_web_fetch_accessible_from_vended_tools(self):
        import strands.vended_tools as vt

        assert vt.make_web_fetch is make_web_fetch

    def test_unknown_attribute_raises(self):
        import strands.vended_tools as vt

        with pytest.raises(AttributeError):
            _ = vt.not_a_real_tool


class TestWebFetchToolCall:
    """End-to-end tool behavior with the sandbox stubbed out."""

    @pytest.mark.asyncio
    async def test_response_body_is_passed_through_html_to_markdown(self):
        sandbox = _make_sandbox(_make_curl_result("<h1>Hi</h1>", content_type="text/html"))
        tru_result = await make_web_fetch(mode="markdown")(url="https://example.com/", tool_context=_make_ctx(sandbox))
        assert "# Hi" in tru_result

    @pytest.mark.asyncio
    async def test_xml_content_type_is_converted_to_markdown(self):
        sandbox = _make_sandbox(
            _make_curl_result("<html><body><p>xhtml</p></body></html>", content_type="application/xhtml+xml")
        )
        tru_result = await make_web_fetch(mode="markdown")(
            url="https://example.com/page.xhtml", tool_context=_make_ctx(sandbox)
        )
        assert "xhtml" in tru_result

    @pytest.mark.asyncio
    async def test_non_html_response_is_returned_as_is(self):
        sandbox = _make_sandbox(_make_curl_result("plain text response", content_type="text/plain"))
        tru_result = await make_web_fetch(mode="markdown")(
            url="https://example.com/robots.txt", tool_context=_make_ctx(sandbox)
        )
        assert tru_result == "plain text response"

    @pytest.mark.asyncio
    async def test_markdown_content_is_truncated(self):
        sandbox = _make_sandbox(_make_curl_result("x" * 200, content_type="text/plain"))
        tru_result = await make_web_fetch(mode="markdown", max_content_chars=50)(
            url="https://example.com/", tool_context=_make_ctx(sandbox)
        )
        assert "[content truncated]" in tru_result

    @pytest.mark.asyncio
    async def test_rejects_non_http_scheme(self):
        sandbox = _make_sandbox()
        with pytest.raises(WebFetchError):
            await make_web_fetch(mode="markdown")(url="file:///etc/passwd", tool_context=_make_ctx(sandbox))

    @pytest.mark.asyncio
    async def test_sandbox_error_is_wrapped_as_web_fetch_error(self):
        sandbox = _make_sandbox(RuntimeError("connection refused"))
        with pytest.raises(WebFetchError, match="fetch failed"):
            await make_web_fetch(mode="markdown")(url="https://example.com/", tool_context=_make_ctx(sandbox))

    @pytest.mark.asyncio
    async def test_rejects_oversized_body_with_content_length(self):
        sandbox = _make_sandbox(_make_execution_result(exit_code=63))
        with pytest.raises(WebFetchError, match="exceeded"):
            await make_web_fetch(mode="markdown")(url="https://example.com/", tool_context=_make_ctx(sandbox))

    @pytest.mark.asyncio
    async def test_rejects_oversized_body(self):
        sandbox = _make_sandbox(_make_curl_result("x" * 100, content_type="text/plain"))
        with pytest.raises(WebFetchError, match="exceeded"):
            await make_web_fetch(mode="markdown", max_bytes=50)(
                url="https://example.com/", tool_context=_make_ctx(sandbox)
            )

    @pytest.mark.asyncio
    async def test_error_status_raises(self):
        sandbox = _make_sandbox(_make_execution_result(exit_code=22, stderr="HTTP/2 404 Not Found"))
        with pytest.raises(WebFetchError, match="HTTP"):
            await make_web_fetch(mode="markdown")(url="https://example.com/missing", tool_context=_make_ctx(sandbox))

    @pytest.mark.asyncio
    async def test_propagates_sandbox_timeout_unwrapped(self):
        sandbox = _make_sandbox(SandboxTimeoutError(30))
        with pytest.raises(SandboxTimeoutError):
            await make_web_fetch(mode="markdown")(url="https://example.com/", tool_context=_make_ctx(sandbox))

    @pytest.mark.asyncio
    async def test_html_extraction_failure_falls_back_to_raw(self, monkeypatch):
        sandbox = _make_sandbox(_make_curl_result("<p>raw content</p>", content_type="text/html"))
        monkeypatch.setattr(extract_module, "BeautifulSoup", _raising_beautiful_soup)
        tru_result = await make_web_fetch(mode="markdown")(url="https://example.com/", tool_context=_make_ctx(sandbox))
        assert tru_result == "<p>raw content</p>"

    @pytest.mark.asyncio
    async def test_sends_correct_user_agent_in_curl_command(self):
        sandbox = _make_sandbox(_make_curl_result("ok"))
        await make_web_fetch(mode="markdown")(url="https://example.com/", tool_context=_make_ctx(sandbox))
        command = sandbox.execute.call_args[0][0]
        assert "strands-agents-web-fetch/1.0" in command

    @pytest.mark.asyncio
    async def test_url_is_safely_quoted(self):
        sandbox = _make_sandbox(_make_curl_result("ok"))
        await make_web_fetch(mode="markdown")(url="https://example.com/path?q=a&b=c", tool_context=_make_ctx(sandbox))
        command = sandbox.execute.call_args[0][0]
        assert "'https://example.com/path?q=a&b=c'" in command


class TestAnalyst:
    """Analyst agent is called when model + prompt are both provided."""

    def _sandbox(self, body: str = "<p>page content</p>") -> SimpleNamespace:
        return _make_sandbox(_make_curl_result(body, content_type="text/html"))

    @pytest.mark.asyncio
    async def test_agentic_content_is_truncated_before_analyst(self, monkeypatch):
        sandbox = _make_sandbox(_make_curl_result("x" * 200, content_type="text/plain"))
        received_prompt: list[str] = []

        class _FakeAgent:
            def __init__(self, **kwargs):
                pass

            async def invoke_async(self, prompt: str, **kwargs):
                received_prompt.append(prompt)
                return "answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool = make_web_fetch(model=SimpleNamespace(), mode="agentic", max_content_chars=50)
        await tool(url="https://example.com/", prompt="Summarize", tool_context=_make_ctx(sandbox))
        assert "x" * 50 in received_prompt[0]
        assert "x" * 51 not in received_prompt[0]
        assert "[content truncated]" in received_prompt[0]

    @pytest.mark.asyncio
    async def test_prompt_without_model_and_no_agent_raises(self):
        with pytest.raises(WebFetchError, match="agentic mode requires a model"):
            await make_web_fetch(mode="agentic")(
                url="https://example.com/", prompt="What is this about?", tool_context=_make_ctx(self._sandbox())
            )

    @pytest.mark.asyncio
    async def test_prompt_uses_host_agent_model_when_no_factory_model(self, monkeypatch):
        host_model = SimpleNamespace()
        received_model: list = []

        class _FakeAgent:
            def __init__(self, model=None, **kwargs):
                received_model.append(model)

            async def invoke_async(self, prompt: str, **kwargs):
                return "host answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        sandbox = self._sandbox()
        agent = SimpleNamespace(model=host_model, sandbox=sandbox)
        tool_use = ToolUse(toolUseId="wf_2", name="web_fetch", input={})
        ctx = ToolContext(tool_use=tool_use, agent=agent, invocation_state={})

        tru_result = await make_web_fetch(mode="agentic")(
            url="https://example.com/", prompt="Summarize", tool_context=ctx
        )
        assert tru_result == "host answer"
        assert received_model[0] is host_model

    @pytest.mark.parametrize("prompt", ["", "   "])
    @pytest.mark.asyncio
    async def test_agentic_mode_with_empty_prompt_raises(self, prompt):
        with pytest.raises(WebFetchError, match="agentic mode requires a non-empty prompt"):
            await make_web_fetch(model=SimpleNamespace(), mode="agentic")(
                url="https://example.com/", prompt=prompt, tool_context=_make_ctx(self._sandbox())
            )

    @pytest.mark.asyncio
    async def test_prompt_with_model_invokes_analyst(self, monkeypatch):
        fake_model = SimpleNamespace()
        received_prompt: list[str] = []

        class _FakeAgent:
            def __init__(self, **kwargs):
                pass

            async def invoke_async(self, prompt: str, **kwargs):
                received_prompt.append(prompt)
                return "the answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tru_result = await make_web_fetch(model=fake_model, mode="agentic")(
            url="https://example.com/", prompt="What is this about?", tool_context=_make_ctx(self._sandbox())
        )
        assert tru_result == "the answer"
        assert len(received_prompt) == 1
        assert "What is this about?" in received_prompt[0]
        assert "page content" in received_prompt[0]


class TestHtmlToMarkdown:
    """Extraction strips noise and preserves structure."""

    def test_strips_script_and_style(self):
        html = """
        <html><head><title>Hi</title>
        <style>body{color:red}</style>
        </head><body>
        <p>Hello world.</p>
        <script>alert('xss')</script>
        <p>After script.</p>
        </body></html>
        """
        md = html_to_markdown(html)
        assert "# Hi" in md
        assert "alert" not in md
        assert "color:red" not in md
        assert "Hello world." in md
        assert "After script." in md

    def test_strips_data_uri_images(self):
        blob = "A" * 200
        html = f'<p>text</p><img src="data:image/png;base64,{blob}" alt="alt text">'
        md = html_to_markdown(html)
        assert blob not in md
        assert "data:" not in md
        assert "alt text" in md

    def test_preserves_regular_images(self):
        html = '<img src="https://example.com/pic.png" alt="pic">'
        md = html_to_markdown(html)
        assert "![pic](https://example.com/pic.png)" in md

    def test_javascript_href_is_dropped(self):
        html = '<a href="javascript:alert(1)">click</a>'
        md = html_to_markdown(html)
        assert "javascript:" not in md
        assert "click" in md

    def test_javascript_img_src_is_dropped(self):
        html = '<img src="javascript:alert(1)" alt="x">'
        md = html_to_markdown(html)
        assert "javascript:" not in md

    @pytest.mark.parametrize("prefix", [" ", "\u200b", "\ufeff"])
    def test_javascript_img_src_with_invisible_prefix_is_dropped(self, prefix):
        html = f'<img src="{prefix}javascript:alert(1)" alt="x">'
        md = html_to_markdown(html)
        assert "javascript:" not in md

    @pytest.mark.parametrize("prefix", [" ", "\t", "\u200b", "\ufeff", "\u00ad"])
    def test_javascript_href_with_invisible_prefix_is_dropped(self, prefix):
        html = f'<a href="{prefix}javascript:alert(1)">click</a>'
        md = html_to_markdown(html)
        assert "javascript:" not in md
        assert "click" in md

    def test_preserves_headings_lists_and_links(self):
        html = """
        <h1>Title</h1>
        <p>Intro paragraph with a <a href="https://ex.com/x">link</a>.</p>
        <ul><li>one</li><li>two</li></ul>
        <ol><li>first</li><li>second</li></ol>
        """
        md = html_to_markdown(html)
        assert "# Title" in md
        assert "[link](https://ex.com/x)" in md
        assert "- one" in md
        assert "- two" in md
        assert "1. first" in md
        assert "2. second" in md

    def test_preserves_code_blocks(self):
        html = "<pre><code>def f():\n    return 1</code></pre>"
        md = html_to_markdown(html)
        assert "```" in md
        assert "def f():" in md
        assert "return 1" in md

    def test_returns_input_on_parser_exception(self, monkeypatch):
        monkeypatch.setattr(extract_module, "BeautifulSoup", _raising_beautiful_soup)
        assert html_to_markdown("<p>anything</p>") == "<p>anything</p>"


def test__tag_attribute_joins_list_values():
    tag = BeautifulSoup('<div class="foo bar">', "html.parser").div
    assert _tag_attribute(tag, "class") == "foo bar"
