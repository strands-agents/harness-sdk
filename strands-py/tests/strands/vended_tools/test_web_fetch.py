"""Tests for the web_fetch tool."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import httpx
import pytest
from bs4 import BeautifulSoup

import strands.agent.agent as agent_module
from strands.types.tools import ToolContext, ToolUse
from strands.vended_tools.web_fetch import (
    WebFetchError,
    make_web_fetch,
)
from strands.vended_tools.web_fetch import _extract as extract_module
from strands.vended_tools.web_fetch._extract import _tag_attribute, html_to_markdown
from strands.vended_tools.web_fetch.web_fetch import _parse_charset


def _transport(handler):
    """Build a mock httpx transport from a request handler callable."""
    return httpx.MockTransport(handler)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=_transport(handler))


def _make_ctx(cancel: threading.Event | None = None) -> ToolContext:
    cancel = cancel or threading.Event()
    agent = SimpleNamespace(model=None, _cancel_signal=cancel)
    tool_use = ToolUse(toolUseId="test-wf", name="web_fetch", input={})
    return ToolContext(tool_use=tool_use, agent=agent, invocation_state={}, cancel_signal=cancel)


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
    """End-to-end tool behavior with the transport stubbed out."""

    @pytest.mark.asyncio
    async def test_html_response_returns_markdown(self):
        html = "<html><head><title>T</title></head><body><h1>Hi</h1></body></html>"

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, text=html)

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/", tool_context=_make_ctx())
        assert "# T" in tru_result
        assert "# Hi" in tru_result

    @pytest.mark.asyncio
    async def test_non_html_response_returns_body(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="plain text response")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/robots.txt", tool_context=_make_ctx())
        assert tru_result == "plain text response"

    @pytest.mark.asyncio
    async def test_xml_content_type_is_converted_to_markdown(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={"content-type": "application/xhtml+xml"},
                text="<html><body><p>xhtml</p></body></html>",
            )

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/page.xhtml", tool_context=_make_ctx())
        assert "xhtml" in tru_result

    @pytest.mark.asyncio
    async def test_markdown_content_is_truncated(self):
        # max_content_chars limits what the main agent receives, with a marker.
        body = "x" * 200

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, text=body)

        tool = make_web_fetch(client=_client(handler), mode="markdown", max_content_chars=50)
        tru_result = await tool(url="https://example.com/", tool_context=_make_ctx())
        assert tru_result.startswith("x" * 50)
        assert "[content truncated]" in tru_result

    @pytest.mark.asyncio
    async def test_rejects_non_http_scheme(self):
        with pytest.raises(WebFetchError, match="Fetch failed"):
            await make_web_fetch(mode="markdown")(url="file:///etc/passwd", tool_context=_make_ctx())

    @pytest.mark.asyncio
    async def test_transport_error_is_wrapped_as_value_error(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(WebFetchError, match="Fetch failed"):
            await tool(url="https://example.com/", tool_context=_make_ctx())

    @pytest.mark.asyncio
    async def test_body_over_cap_is_rejected(self):
        big = b"x" * 100

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, content=big)

        tool = make_web_fetch(client=_client(handler), max_bytes=50, mode="markdown")
        with pytest.raises(WebFetchError, match="exceeded"):
            await tool(url="https://example.com/", tool_context=_make_ctx())

    @pytest.mark.asyncio
    async def test_error_status_raises(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="Not Found")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(WebFetchError, match="HTTP 404"):
            await tool(url="https://example.com/missing", tool_context=_make_ctx())

    @pytest.mark.asyncio
    async def test_user_client_redirect_behaviour_is_respected(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/old":
                return httpx.Response(
                    301, headers={"location": "https://example.com/new", "content-type": "text/plain"}, text="moved"
                )
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="new page")

        # User-supplied client with follow_redirects=False: redirect is not followed.
        client = httpx.AsyncClient(transport=_transport(handler), follow_redirects=False)
        tool = make_web_fetch(client=client, mode="markdown")
        tru_result = await tool(url="https://example.com/old", tool_context=_make_ctx())
        assert tru_result == "moved"

    @pytest.mark.asyncio
    async def test_timeout_is_wrapped_as_web_fetch_error(self):
        async def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.TimeoutException("timed out")

        tool = make_web_fetch(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), mode="markdown")
        with pytest.raises(WebFetchError, match="timed out"):
            await tool(url="https://example.com/", tool_context=_make_ctx())

    @pytest.mark.asyncio
    async def test_html_extraction_failure_falls_back_to_raw(self, monkeypatch):
        # html_to_markdown falls back to raw input on parser failure,
        # so the model always receives readable content.
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<p>raw content</p>")

        monkeypatch.setattr(extract_module, "BeautifulSoup", _raising_beautiful_soup)
        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/", tool_context=_make_ctx())
        assert tru_result == "<p>raw content</p>"

    @pytest.mark.asyncio
    async def test_sends_correct_headers(self):
        received: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            received.update(request.headers)
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="ok")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        await tool(url="https://example.com/", tool_context=_make_ctx())
        assert "strands-agents-web-fetch" in received.get("user-agent", "")

    @pytest.mark.asyncio
    async def test_pre_flight_cancel_short_circuits(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise AssertionError("transport should not be called if cancel is pre-set")

        cancel = threading.Event()
        cancel.set()
        ctx = _make_ctx(cancel)

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(asyncio.CancelledError):
            await tool(url="https://example.com/", tool_context=ctx)

    @pytest.mark.asyncio
    async def test_mid_flight_cancel_aborts_between_chunks(self):
        cancel = threading.Event()

        def handler(_request: httpx.Request) -> httpx.Response:
            async def body():
                yield b"chunk-one"
                cancel.set()  # signal mid-stream
                yield b"chunk-two"

            return httpx.Response(200, headers={"content-type": "text/plain"}, content=body())

        ctx = _make_ctx(cancel)

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(asyncio.CancelledError):
            await tool(url="https://example.com/", tool_context=ctx)


class TestAnalyst:
    """Analyst agent is called when model + prompt are both provided."""

    def _page_client(self, body: str = "<p>page content</p>") -> httpx.AsyncClient:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html"}, text=body)

        return _client(handler)

    @pytest.mark.asyncio
    async def test_agentic_content_is_truncated_before_analyst(self, monkeypatch):
        # max_content_chars limits what the analyst receives.
        body = "x" * 200

        def page_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, text=body)

        received_prompt: list[str] = []

        class _FakeAgent:
            def __init__(self, **kwargs):
                pass

            async def invoke_async(self, prompt: str, **kwargs):
                received_prompt.append(prompt)
                return "answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool = make_web_fetch(
            client=_client(page_handler),
            model=SimpleNamespace(),
            mode="agentic",
            max_content_chars=50,
        )
        await tool(url="https://example.com/", prompt="Summarize", tool_context=_make_ctx())
        assert "x" * 50 in received_prompt[0]
        assert "x" * 51 not in received_prompt[0]
        assert "[content truncated]" in received_prompt[0]

    @pytest.mark.asyncio
    async def test_prompt_without_model_and_no_agent_raises(self):
        # No factory model and no host agent — agentic mode has nowhere to go.
        tool = make_web_fetch(client=self._page_client(), mode="agentic")
        with pytest.raises(WebFetchError, match="agentic mode requires a model"):
            await tool(url="https://example.com/", prompt="What is this about?", tool_context=_make_ctx())

    @pytest.mark.asyncio
    async def test_prompt_uses_host_agent_model_when_no_factory_model(self, monkeypatch):
        # When no factory model is set, the host agent's model is used.
        host_model = SimpleNamespace()
        received_model: list = []

        class _FakeAgent:
            def __init__(self, model=None, **kwargs):
                received_model.append(model)

            async def invoke_async(self, prompt: str, **kwargs):
                return "host answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool_use = ToolUse(toolUseId="wf_2", name="web_fetch", input={})
        host_agent = SimpleNamespace(_cancel_signal=None, model=host_model)
        ctx = ToolContext(tool_use=tool_use, agent=host_agent, invocation_state={})

        tool = make_web_fetch(client=self._page_client(), mode="agentic")
        tru_result = await tool(url="https://example.com/", prompt="Summarize", tool_context=ctx)
        assert tru_result == "host answer"
        assert received_model[0] is host_model

    @pytest.mark.asyncio
    async def test_empty_prompt_with_model_returns_markdown(self, monkeypatch):
        # markdown mode skips the analyst regardless of model configuration.
        fake_model = SimpleNamespace()
        invoked: list[bool] = []

        class _FakeAgent:
            def __init__(self, **kwargs):
                pass

            async def invoke_async(self, prompt: str, **kwargs):
                invoked.append(True)
                return "answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool = make_web_fetch(client=self._page_client(), model=fake_model, mode="markdown")
        tru_result = await tool(url="https://example.com/", tool_context=_make_ctx())
        assert not invoked
        assert "page content" in tru_result

    @pytest.mark.parametrize("prompt", ["", "   "])
    @pytest.mark.asyncio
    async def test_agentic_mode_with_empty_prompt_raises(self, prompt):
        tool = make_web_fetch(client=self._page_client(), model=SimpleNamespace(), mode="agentic")
        with pytest.raises(WebFetchError, match="agentic mode requires a non-empty prompt"):
            await tool(url="https://example.com/", prompt=prompt, tool_context=_make_ctx())

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
        tool = make_web_fetch(client=self._page_client(), model=fake_model, mode="agentic")
        tru_result = await tool(url="https://example.com/", prompt="What is this about?", tool_context=_make_ctx())
        assert tru_result == "the answer"
        assert len(received_prompt) == 1
        assert "What is this about?" in received_prompt[0]
        assert "page content" in received_prompt[0]


class TestParseCharset:
    """_parse_charset extracts charset from Content-Type values, defaulting to utf-8."""

    def test_plain_charset(self):
        assert _parse_charset("text/html; charset=utf-8") == "utf-8"

    def test_quoted_charset(self):
        assert _parse_charset('text/html; charset="iso-8859-1"') == "iso-8859-1"

    def test_missing_charset_defaults_to_utf8(self):
        assert _parse_charset("text/plain") == "utf-8"

    def test_empty_charset_defaults_to_utf8(self):
        assert _parse_charset("text/html; charset=") == "utf-8"


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
        # Invisible/whitespace prefixes before "javascript:" must not bypass the check.
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
    # BS4 returns ``class`` as a list; _tag_attribute must join it.
    tag = BeautifulSoup('<div class="foo bar">', "html.parser").div
    assert _tag_attribute(tag, "class") == "foo bar"
