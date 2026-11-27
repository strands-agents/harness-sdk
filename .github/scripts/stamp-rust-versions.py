#!/usr/bin/env python3
"""Stamp release versions into the Rust workspace manifests.

The repo keeps every Rust crate at the placeholder 0.0.0, as the TypeScript and
Python packages keep theirs; a release writes the real versions in before it
packages, and the change is never committed.

--sdk-version sets the version of `strands` and `strands-macros` (which share
the workspace version) and the requirements the other crates declare on them.
The SDK release passes the version it publishes; the harness release passes the
published `strands` version the harness should require.

--harness-version sets the version of `strands-harness`.

Run from the repo root.
"""

import argparse
import re
import sys
import tomllib
from pathlib import Path

ROOT_MANIFEST = Path("Cargo.toml")
HARNESS_MANIFEST = Path("harness-rs/strands-harness/Cargo.toml")
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def substitute_once(path: Path, text: str, pattern: str, replacement: str) -> str:
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        sys.exit(f"{path}: expected one line matching {pattern!r}")
    return new_text


def stamp_sdk(version: str) -> None:
    text = ROOT_MANIFEST.read_text()
    text = substitute_once(ROOT_MANIFEST, text, r'^version = "[^"]*"$', f'version = "{version}"')
    text = substitute_once(
        ROOT_MANIFEST,
        text,
        r'^(strands = \{ path = "strands-rs/strands", version = )"[^"]*"',
        rf'\g<1>"{version}"',
    )
    text = substitute_once(
        ROOT_MANIFEST,
        text,
        r'^(strands-macros = \{ path = "strands-rs/strands-macros", version = )"=[^"]*"',
        rf'\g<1>"={version}"',
    )
    ROOT_MANIFEST.write_text(text)

    workspace = tomllib.loads(text)["workspace"]
    dependencies = workspace["dependencies"]
    stamped = (
        workspace["package"]["version"],
        dependencies["strands"]["version"],
        dependencies["strands-macros"]["version"],
    )
    if stamped != (version, version, f"={version}"):
        sys.exit(f"{ROOT_MANIFEST}: stamping produced {stamped}")


def stamp_harness(version: str) -> None:
    text = HARNESS_MANIFEST.read_text()
    text = substitute_once(HARNESS_MANIFEST, text, r'^version = "[^"]*"$', f'version = "{version}"')
    HARNESS_MANIFEST.write_text(text)

    if tomllib.loads(text)["package"]["version"] != version:
        sys.exit(f"{HARNESS_MANIFEST}: stamping did not set version {version}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sdk-version", required=True)
    parser.add_argument("--harness-version")
    args = parser.parse_args()

    for version in filter(None, (args.sdk_version, args.harness_version)):
        if not SEMVER.match(version):
            sys.exit(f"version {version!r} is not bare semver (MAJOR.MINOR.PATCH)")

    stamp_sdk(args.sdk_version)
    if args.harness_version:
        stamp_harness(args.harness_version)
    print(f"stamped sdk={args.sdk_version} harness={args.harness_version or 'unchanged'}")


if __name__ == "__main__":
    main()
