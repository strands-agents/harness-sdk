r"""Validation patterns for sandbox inputs.

Mirrors ``strands-ts/src/sandbox/constants.ts``. These patterns reject inputs
that could break out of the intended shell context (path separators, spaces,
shell metacharacters), providing defense-in-depth for shell-based sandboxes.

Match these with :meth:`re.Pattern.fullmatch` (not :meth:`re.match`): Python's
``$`` also matches just before a trailing ``\n``, so ``re.match`` would accept
e.g. ``"python3\n"`` and let a newline-separated second statement slip through.
``fullmatch`` reproduces the JavaScript ``/^...$/.test()`` semantics of the
``strands-ts`` oracle, which anchors to the true end of the string.
"""

import re

#: Pattern for validating language/interpreter names.
#: Allows alphanumeric characters, dots, hyphens, and underscores. Rejects path
#: separators, spaces, and shell metacharacters to prevent injection.
LANGUAGE_PATTERN = re.compile(r"^[a-zA-Z0-9._-]+$")

#: Pattern for validating environment variable names: a leading letter or
#: underscore, followed by letters, digits, or underscores (valid POSIX names).
#: Names outside this set are rejected to prevent shell-syntax injection where a
#: key is interpolated into a command, and to fail with a clear error otherwise.
ENV_KEY_PATTERN = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
