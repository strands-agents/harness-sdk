"""Tests for the web_fetch tool."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import httpx
import pytest
from bs4 import BeautifulSoup

import strands.agent.agent as agent_module
from strands.agent.invocation_context import _create_invocation_context, _reached_limit
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
        tru_result = await tool(url="https://example.com/")
        assert "# T" in tru_result
        assert "# Hi" in tru_result

    @pytest.mark.asyncio
    async def test_non_html_response_returns_body(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="plain text response")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/robots.txt")
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
        tru_result = await tool(url="https://example.com/page.xhtml")
        assert "xhtml" in tru_result

    @pytest.mark.asyncio
    async def test_markdown_content_is_truncated(self):
        # max_content_chars limits what the main agent receives, with a marker.
        body = "x" * 200

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, text=body)

        tool = make_web_fetch(client=_client(handler), mode="markdown", max_content_chars=50)
        tru_result = await tool(url="https://example.com/")
        assert tru_result.startswith("x" * 50)
        assert "[content truncated]" in tru_result

    @pytest.mark.asyncio
    async def test_rejects_non_http_scheme(self):
        with pytest.raises(WebFetchError, match="Fetch failed"):
            await make_web_fetch(mode="markdown")(url="file:///etc/passwd")

    @pytest.mark.asyncio
    async def test_transport_error_is_wrapped_as_value_error(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(WebFetchError, match="Fetch failed"):
            await tool(url="https://example.com/")

    @pytest.mark.asyncio
    async def test_body_over_cap_is_rejected(self):
        big = b"x" * 100

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/plain"}, content=big)

        tool = make_web_fetch(client=_client(handler), max_bytes=50, mode="markdown")
        with pytest.raises(WebFetchError, match="exceeded"):
            await tool(url="https://example.com/")

    @pytest.mark.asyncio
    async def test_error_status_raises(self):
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="Not Found")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        with pytest.raises(WebFetchError, match="HTTP 404"):
            await tool(url="https://example.com/missing")

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
        tru_result = await tool(url="https://example.com/old")
        assert tru_result == "moved"

    @pytest.mark.asyncio
    async def test_timeout_is_wrapped_as_web_fetch_error(self):
        async def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.TimeoutException("timed out")

        tool = make_web_fetch(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), mode="markdown")
        with pytest.raises(WebFetchError, match="timed out"):
            await tool(url="https://example.com/")

    @pytest.mark.asyncio
    async def test_html_extraction_failure_falls_back_to_raw(self, monkeypatch):
        # html_to_markdown falls back to raw input on parser failure,
        # so the model always receives readable content.
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<p>raw content</p>")

        monkeypatch.setattr(extract_module, "BeautifulSoup", _raising_beautiful_soup)
        tool = make_web_fetch(client=_client(handler), mode="markdown")
        tru_result = await tool(url="https://example.com/")
        assert tru_result == "<p>raw content</p>"

    @pytest.mark.asyncio
    async def test_sends_correct_headers(self):
        received: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            received.update(request.headers)
            return httpx.Response(200, headers={"content-type": "text/plain"}, text="ok")

        tool = make_web_fetch(client=_client(handler), mode="markdown")
        await tool(url="https://example.com/")
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
        await tool(url="https://example.com/", prompt="Summarize")
        assert "x" * 50 in received_prompt[0]
        assert "x" * 51 not in received_prompt[0]
        assert "[content truncated]" in received_prompt[0]

    @pytest.mark.asyncio
    async def test_prompt_without_model_and_no_agent_raises(self):
        # No factory model and no host agent — agentic mode has nowhere to go.
        tool = make_web_fetch(client=self._page_client(), mode="agentic")
        with pytest.raises(WebFetchError, match="agentic mode requires a model"):
            await tool(url="https://example.com/", prompt="What is this about?")

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "host_agent_attrs",
        [
            {"aux_model": SimpleNamespace(), "model": SimpleNamespace()},
            {"model": SimpleNamespace()},
        ],
        ids=["aux_model", "model_only"],
    )
    async def test_prompt_uses_host_agent_aux_model_when_no_factory_model(self, monkeypatch, host_agent_attrs):
        # When no factory model is set, the host agent's aux_model is used, or its model when
        # the host has no aux_model attribute.
        received_model: list = []

        class _FakeAgent:
            def __init__(self, model=None, **kwargs):
                received_model.append(model)

            async def invoke_async(self, prompt: str, **kwargs):
                return "host answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool_use = ToolUse(toolUseId="wf_2", name="web_fetch", input={})
        host_agent = SimpleNamespace(_cancel_signal=None, **host_agent_attrs)
        ctx = ToolContext(tool_use=tool_use, agent=host_agent, invocation_state={})

        tool = make_web_fetch(client=self._page_client(), mode="agentic")
        tru_result = await tool(url="https://example.com/", prompt="Summarize", tool_context=ctx)
        assert tru_result == "host answer"
        exp_model = host_agent_attrs.get("aux_model", host_agent_attrs["model"])
        assert received_model[0] is exp_model

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
        tru_result = await tool(url="https://example.com/")
        assert not invoked
        assert "page content" in tru_result

    @pytest.mark.parametrize("prompt", ["", "   "])
    @pytest.mark.asyncio
    async def test_agentic_mode_with_empty_prompt_raises(self, prompt):
        tool = make_web_fetch(client=self._page_client(), model=SimpleNamespace(), mode="agentic")
        with pytest.raises(WebFetchError, match="agentic mode requires a non-empty prompt"):
            await tool(url="https://example.com/", prompt=prompt)

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
        tru_result = await tool(url="https://example.com/", prompt="What is this about?")
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

    # guards against image alt text, src, and title changing the structure of the markdown (#6243)
    @pytest.mark.parametrize(
        ("html", "expected"),
        [
            ('<img alt="a](https://example.com/x) [b" src="pic.png">', r"![a\]\(https://example.com/x) \[b](pic.png)"),
            (
                '<img alt="[click](https://example.com/y)" src="data:image/png;base64,AAAA">',
                r"\[click\]\(https://example.com/y)",
            ),
            ('<img alt="[click](https://example.com/y)" src="">', r"![\[click\]\(https://example.com/y)]()"),
            (
                '<img alt="&lt;https://example.com/a&gt;" src="data:image/png;base64,AAAA">',
                "&lt;https://example.com/a&gt;",
            ),
            ('<img alt="^back\\slash\n\n`tick` ~~~" src="pic.png">', r"![\^back\\slash \`tick\` \~\~\~](pic.png)"),
            ('<p>Rated<img alt=" 4 stars " src="data:image/png;base64,AAAA">by users</p>', "Rated 4 stars by users"),
            # "(" is escaped only where it could open a link destination
            ('<img alt="Logo (dark)" src="pic.png">', "![Logo (dark)](pic.png)"),
            ('<img alt="(dark) Logo" src="pic.png">', r"![\(dark) Logo](pic.png)"),
            ('<img alt="a] (https://example.com/x)" src="pic.png">', r"![a\] \(https://example.com/x)](pic.png)"),
            (
                '<p>see<img alt=" (https://example.com/y)" src="data:image/png;base64,AAAA"></p>',
                r"see \(https://example.com/y)",
            ),
            (
                '<a href="https://example.com/"><img alt="a] b" src="pic.png"></a>',
                r"[![a\] b](pic.png)](https://example.com/)",
            ),
            (
                '<h2>Head <img alt="[click](https://example.com/h)" src="pic.png"></h2>',
                r"## Head \[click\]\(https://example.com/h)",
            ),
            (
                '<img alt="x" src="pic.png) [click](https://example.com/z">',
                "![x](pic.png%29%20[click]%28https://example.com/z)",
            ),
            ('<img alt="x" src=" a\tb<c>d\\e\x01\x7f\x85.png\n">', "![x](ab%3Cc%3Ed/e%01%7F%C2%85.png)"),
            ('<img alt="x" src="p.png&quot;t&quot;&#39;u&#39;`v">', "![x](p.png%22t%22%27u%27%60v)"),
            # a trailing "!" is escaped only where the alt text is written bare, so a following link stays a link
            (
                '<p><img alt="Wow!" src="data:image/png;base64,AAAA"><a href="https://example.com/">link</a></p>',
                r"Wow\![link](https://example.com/)",
            ),
            (
                '<p><img alt="Wow! " src="data:image/png;base64,AAAA"><div></div><a href="https://example.com/">l</a></p>',
                r"Wow\![l](https://example.com/)",
            ),
            (
                '<h7><img alt="Wow!" src="pic.png"><a href="https://example.com/">link</a></h7>',
                r"###### Wow\![link](https://example.com/)",
            ),
            (
                '<p><img alt="Wow!" src="pic.png"><a href="https://example.com/">link</a></p>',
                "![Wow!](pic.png)[link](https://example.com/)",
            ),
            # whitespace and control characters, which Python and JavaScript define differently
            (
                '<img alt="a\x1cb\x85c\ufeffd\xa0e" src="\x1c\x85p\u2028q.png\ufeff\x1c">',
                "![a b c d e](%C2%85p%E2%80%A8q.png%EF%BB%BF)",
            ),
            (
                '<img alt="x" src="pic.png" title=\'t\\") [click](https://example.com/t) ("y\'>',
                r'![x](pic.png "t\\\") \[click\]\(https://example.com/t) (\"y")',
            ),
            ('<img alt="x" title="t) u">', "![x]()"),
        ],
    )
    def test_escapes_image_alt_src_and_title(self, html, expected):
        assert html_to_markdown(html) == expected

    # guards against body text, the page title, and link titles and hrefs changing the structure of the markdown (#6302)
    @pytest.mark.parametrize(
        ("html", "expected"),
        [
            (
                "<p>See [the docs](https://example.com/docs) for details.</p>",
                r"See \[the docs\](https://example.com/docs) for details.",
            ),
            (
                "<p>![logo](https://example.com/x.png) a\\[b](https://example.com/c)</p>",
                r"!\[logo\](https://example.com/x.png) a\\\[b\](https://example.com/c)",
            ),
            ("<p>Use <code>a[0]</code> and C:\\dir</p>", r"Use `a[0]` and C:\\dir"),
            (
                "<title>Guide [part 1](https://example.com/one) # intro</title>",
                r"# Guide \[part 1\]\(https://example.com/one) # intro",
            ),
            ("<title>Line one\n\n## Line two</title>", "# Line one ## Line two"),
            ("<title>snake_case *bold* &lt;b&gt;</title>", r"# snake\_case \*bold\* &lt;b&gt;"),
            ("<title>\n(1) Inbox\xa0</title>", "# (1) Inbox"),
            ("<html><head><title>\n My Page\n</title></head><body><p>body</p></body></html>", "# My Page\n\nbody"),
            # the first title starts the output, where TypeScript writes it where it stands
            ("<p>a</p><title>Mid</title><p>b</p>", "# Mid\n\na\n\nb"),
            # every title with text is a heading, and a title in a dropped element is dropped
            ("<title> </title><title>One</title><p>body</p><title># Two</title>", "# One\n\nbody\n\n# # Two"),
            (
                "<rss><channel><title>Blog</title><item><description>Hello</description><title>Post</title></item>"
                "</channel></rss>",
                "# Blog\n\nHello\n\n# Post",
            ),
            ("<html><head><title>T</title><body><p>body</p></body></html>", "# T\n\nbody"),
            ("<svg><title>icon</title></svg><p>body</p>", "body"),
            (
                '<a href="https://example.com/a" title=\'path C:\\" end\'>link</a>',
                r'[link](https://example.com/a "path C:\\\" end")',
            ),
            (
                '<a href="https://example.com/a" title="two\nlines [x] &lt;b&gt;">link</a>',
                r'[link](https://example.com/a "two lines \[x\] &lt;b&gt;")',
            ),
            ('<a href="https://example.com/a)b">odd</a>', "[odd](https://example.com/a%29b)"),
            ('<a href="https://example.com/a b">space</a>', "[space](https://example.com/a%20b)"),
            ('<a href="https://example.com/a\\)b">odd</a>', "[odd](https://example.com/a/%29b)"),
            # a backslash is a slash before the query of an http(s) or relative URL, as URL parsers read it
            (
                '<a href="docs\\page.htm?q=a\\b">x</a> <a href="mailto:a\\b">m</a>',
                "[x](docs/page.htm?q=a%5Cb) [m](mailto:a%5Cb)",
            ),
            (
                '<a href="10.0.0.1:80\\a">x</a> <a href="\u200bmailto:a\\b">m</a>',
                "[x](10.0.0.1:80/a) [m](\u200bmailto:a/b)",
            ),
            (
                '<a href="file:///C:\\Users\\me\\doc.txt">f</a> <a href="ftp://h\\a">g</a> <a href="WSS://h\\a">w</a> '
                '<a href="ws://h\\a">v</a>',
                "[f](file:///C:/Users/me/doc.txt) [g](ftp://h/a) [w](WSS://h/a) [v](ws://h/a)",
            ),
            ('<a href=" \n">blank</a>', "blank"),
            # a link whose text is its href is not written as <href>, which can be an HTML tag
            ('<a href="b">b</a>', "[b](b)"),
            # an ordinary href and title are not escaped
            (
                '<a href=" /a?b=1&amp;c=2#d " title="(Plain) title">link [1]</a>',
                r'[link \[1\]](/a?b=1&c=2#d "(Plain) title")',
            ),
        ],
    )
    def test_escapes_text_title_and_links(self, html, expected):
        assert html_to_markdown(html) == expected

    # guards against body text starting a heading, list, quote, fence or code span (#6302)
    @pytest.mark.parametrize(
        ("html", "expected"),
        [
            ("<p># Not a heading</p>", r"\# Not a heading"),
            ("<p>> quote</p><p>- a</p><p>+ b</p><p>12. c</p>", "\\> quote\n\n\\- a\n\n\\+ b\n\n12\\. c"),
            ("<p>1) Not a list</p>", r"1\) Not a list"),
            ("<p>Title</p><p>===</p><p>~~~</p>", "Title\n\n\\===\n\n\\~~~"),
            ("<p>use `rm -rf` now</p>", r"use \`rm -rf\` now"),
            ("<div>1. one<br>2. two</div>", "1\\. one  \n2\\. two"),
            ("a<div><span> # x</span></div>", "a\n\n\\# x"),
            ("<ul><li>- a</li></ul><blockquote>> b</blockquote><h2># c</h2>", "- \\- a\n\n> \\> b\n\n## \\# c"),
            # text that does not start a line, and text in code, is unchanged
            (
                '<p><a href="/">Home</a> > <a href="/p">Products</a> - all, C# 1. x</p>',
                "[Home](/) > [Products](/p) - all, C# 1. x",
            ),
            ("<p>#hashtag</p><p>+1</p><p>3.14</p><p>\u0661. x</p>", "#hashtag\n\n+1\n\n3.14\n\n\u0661. x"),
            ("<p>~/projects/app</p><p>~100 and ~~ no</p>", "~/projects/app\n\n~100 and ~~ no"),
            ('<p>a<i class="icon"></i> - b</p>', "a - b"),
            (
                '<h2>Intro<a href="#i">#</a></h2><p><span>Step</span> <span>1.</span> Open</p>',
                "## Intro[#](#i)\n\nStep 1. Open",
            ),
            ("<p><code>a\n# b\n[c](u)</code></p>", "`a # b [c](u)`"),
            # image alt text written without the image
            ('<p><img src="data:image/png;base64,AA" alt="# x"></p>', r"\# x"),
            ('<p><img src="data:image/png;base64,AA" alt="* a_b"></p>', r"\* a\_b"),
        ],
    )
    def test_escapes_block_markers_and_backticks_in_text(self, html, expected):
        assert html_to_markdown(html) == expected

    # guards against a line of backticks in a code block closing its fence
    @pytest.mark.parametrize(
        ("html", "expected"),
        [
            (
                '<pre><code>```\ncode\n```</code></pre><p><a href="u">link</a></p>',
                "````\n```\ncode\n```\n````\n\n[link](u)",
            ),
            ("<pre>```\na\n  ````\nb</pre>", "`````\n```\na\n  ````\nb\n`````"),
            ("<pre>a&#13;```&#13;# b</pre>", "````\na\n```\n# b\n````"),
            # markdownify writes a code block in a heading on one line
            ("<h2><pre>a ``` [b](u)</pre></h2>", "## ```` a ``` [b](u) ````"),
            ("<p><code>a `b` c</code> <kbd>d\n# e</kbd></p>", "`` a `b` c `` `d # e`"),
        ],
    )
    def test_code_cannot_end_its_block_or_span_early(self, html, expected):
        assert html_to_markdown(html) == expected

    # line breaks that markdownify keeps in text, whitespace that it strips late, and markers that turndown leaves
    @pytest.mark.parametrize(
        ("html", "expected"),
        [
            ("<p>foo\n# bar\n- baz</p>", "foo\n\\# bar\n\\- baz"),
            ("<p>foo<br> - one</p>", "foo  \n \\- one"),
            ("<p>&nbsp;# x</p>", r"\# x"),
            ("<main> > x</main>", r"\> x"),
            ("a<figcaption><i> - x</i></figcaption>", "a\n\n*\\- x*"),
            ("<p>#<span> x</span></p><p>1.</p>", "\\# x\n\n1\\."),
            ("<p>1)</p>", r"1\)"),
            ("<p><del>~100</del> 80</p><p>~<span>~~</span></p>", "~~\\~100~~ 80\n\n\\~~~"),
            (
                "<p><s>~100</s> 80</p><p>~~<span>~</span></p><p><a>~~&nbsp;</a>~x</p>",
                "~~\\~100~~ 80\n\n\\~~~\n\n\\~~~x",
            ),
            # a table cell follows "|", and text after other output on its line is not escaped as turndown does
            ("<table><tr><th>#</th><th>1.</th></tr></table>", "| # | 1. |\n| --- | --- |"),
            ("<p><b>x</b>> y</p>", "**x**> y"),
        ],
    )
    def test_escapes_block_markers_on_every_line_of_text(self, html, expected):
        assert html_to_markdown(html) == expected

    def test_javascript_href_is_dropped(self):
        html = '<a href="javascript:alert(1)">click</a>'
        md = html_to_markdown(html)
        assert "javascript:" not in md
        assert "click" in md

    @pytest.mark.parametrize("href", ["VBScript:msgbox(1)", "data:text/html,<script>alert(1)</script>"])
    def test_vbscript_and_data_hrefs_are_dropped(self, href):
        assert html_to_markdown(f'<a href="{href}">click</a>') == "click"

    def test_javascript_img_src_is_dropped(self):
        html = '<img src="javascript:alert(1)" alt="x">'
        md = html_to_markdown(html)
        assert "javascript:" not in md

    def test_vbscript_img_src_is_dropped(self):
        assert html_to_markdown('<img src="VBScript:msgbox(1)" alt="x">') == ""

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

    @pytest.mark.parametrize("prefix", ["\u2028", "\u2029", "\u200b\u2028 "])
    @pytest.mark.parametrize("url", ["javascript:alert(1)", "vbscript:msgbox(1)", "data:text/html,x"])
    def test_script_and_data_hrefs_with_line_separator_prefix_are_dropped(self, prefix, url):
        assert html_to_markdown(f'<a href="{prefix}{url}">click</a>') == "click"

    @pytest.mark.parametrize("prefix", ["\u2028", "\u2029", "\u200b\u2028 "])
    @pytest.mark.parametrize(
        ("src", "expected"),
        [("javascript:alert(1)", ""), ("vbscript:msgbox(1)", ""), ("data:image/png;base64,AAAA", "x")],
    )
    def test_script_and_data_img_srcs_with_line_separator_prefix_are_dropped(self, prefix, src, expected):
        assert html_to_markdown(f'<img src="{prefix}{src}" alt="x">') == expected

    @pytest.mark.parametrize("prefix", [chr(c) for c in (0x0890, 0x0891, *range(0x13439, 0x13440))])
    def test_javascript_href_with_newer_format_character_prefix_is_dropped(self, prefix):
        assert html_to_markdown(f'<a href="{prefix}javascript:alert(1)">click</a>') == "click"

    @pytest.mark.parametrize("url", ["javascript://\u2100%0aalert(1)", "vbscript://[x", "data://[x/text/html,x"])
    def test_script_and_data_hrefs_with_unparseable_host_are_dropped(self, url):
        assert html_to_markdown(f'<a href="{url}">click</a>') == "click"

    def test_unparseable_href_is_kept_and_rest_of_page_is_converted(self):
        html = '<h1>Hi</h1><a href="javascript:alert(1)">js</a> <a href="http://[bad">bad</a>'
        assert html_to_markdown(html) == "# Hi\n\njs [bad](http://[bad)"

    def test_unparseable_img_src_is_kept(self):
        html = '<img src="http://[bad" alt="pic">'
        assert html_to_markdown(html) == "![pic](http://[bad)"

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


class TestWebFetchRequestUsage:
    """The analyst joins the request the tool call belongs to."""

    @staticmethod
    def _page_client() -> httpx.AsyncClient:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-type": "text/html"}, text="<p>page content</p>")

        return _client(handler)

    @pytest.mark.asyncio
    async def test_analyst_joins_the_request_the_tool_call_belongs_to(self, monkeypatch):
        received_kwargs: list[dict] = []

        class _FakeAgent:
            def __init__(self, **kwargs):
                pass

            async def invoke_async(self, prompt: str, **kwargs):
                received_kwargs.append(kwargs)
                return "the answer"

        monkeypatch.setattr(agent_module, "Agent", _FakeAgent)
        tool = make_web_fetch(client=self._page_client(), model=SimpleNamespace(), mode="agentic")
        request = _create_invocation_context({"turns": 1})
        request._usage["turns_taken"] = 1
        tool_use = {"toolUseId": "1", "name": "web_fetch", "input": {}}
        ctx = ToolContext(tool_use=tool_use, agent=SimpleNamespace(), invocation_state={}, invocation_context=request)

        await tool(url="https://example.com/", prompt="What is this about?", tool_context=ctx)

        handed = received_kwargs[0]["invocation_context"]
        handed._record_usage({"inputTokens": 1, "outputTokens": 2, "totalTokens": 3})
        assert _reached_limit(handed) is None
        assert request.usage == {"turns_taken": 1, "inputTokens": 1, "outputTokens": 2, "totalTokens": 3}
