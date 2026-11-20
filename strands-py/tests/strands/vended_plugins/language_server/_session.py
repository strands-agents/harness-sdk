"""A four-file workspace and a session over it, shared by the fake-client and real-server tests.

``b.py`` defines ``helper``, which ``a.py`` (the file being edited) uses; ``d.py`` imports ``a.main``; ``c.py`` is
unrelated. Older reads of ``b.py`` (a dependency) and ``d.py`` (a dependent) should stay, and the read of ``c.py`` go.
"""

from strands.types.content import Message, Messages

FILES = {
    "b.py": "def helper(x: int) -> int:\n    return x * 2\n",
    "a.py": "from b import helper\n\n\ndef main() -> int:\n    return helper(3)\n",
    "c.py": "def unrelated() -> str:\n    return 'c'\n\n\nclass Logger:\n    def log(self, msg: str) -> None: ...\n",
    "d.py": "from a import main\n\nprint(main())\n",
}


def read_pair(tool_use_id: str, path: str, text: str | None = None) -> Messages:
    return [
        Message(
            role="assistant",
            content=[{"toolUse": {"toolUseId": tool_use_id, "name": "read", "input": {"path": path}}}],
        ),
        Message(
            role="user",
            content=[
                {
                    "toolResult": {
                        "toolUseId": tool_use_id,
                        "status": "success",
                        "content": [{"text": FILES[path] if text is None else text}],
                    }
                }
            ],
        ),
    ]


def conversation() -> Messages:
    """Reads of c.py, b.py and d.py, then an edit to a.py: the newest two messages."""
    messages: Messages = [Message(role="user", content=[{"text": "Make main() return helper(4)."}])]
    messages += read_pair("t1", "c.py") + read_pair("t2", "b.py") + read_pair("t3", "d.py")
    edit_input = {"path": "a.py", "old_str": "helper(3)", "new_str": "helper(4)"}
    messages += [
        Message(role="assistant", content=[{"toolUse": {"toolUseId": "t4", "name": "edit", "input": edit_input}}]),
        Message(
            role="user",
            content=[{"toolResult": {"toolUseId": "t4", "status": "success", "content": [{"text": "Edited a.py."}]}}],
        ),
    ]
    return messages


def results(messages: Messages) -> dict[str, str]:
    """Each tool result's first text, by toolUseId."""
    return {
        block["toolResult"]["toolUseId"]: block["toolResult"]["content"][0]["text"]
        for message in messages
        for block in message["content"]
        if "toolResult" in block
    }
