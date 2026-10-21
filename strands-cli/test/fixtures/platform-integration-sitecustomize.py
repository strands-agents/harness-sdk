"""Provide the deterministic remote skill used by Python platform tests."""

import io
import urllib.request

_REMOTE_SKILL = b"""---
name: remote-platform-skill
description: Remote platform integration marker.
---
Use remote-platform-skill.
"""
_urlopen = urllib.request.urlopen


def deterministic_urlopen(request, *args, **kwargs):
    url = request.full_url if isinstance(request, urllib.request.Request) else request
    if url == "https://skills.example.test/SKILL.md":
        return io.BytesIO(_REMOTE_SKILL)
    return _urlopen(request, *args, **kwargs)


urllib.request.urlopen = deterministic_urlopen
