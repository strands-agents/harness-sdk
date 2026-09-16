# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pydoc-markdown>=4.8.2",
# ]
# ///
"""Generate markdown documentation for strands-agents SDK using pydoc-markdown.

This script generates per-module markdown files in the .build/api-docs/python/ directory.

Usage:
    uv run scripts/api-generation-python.py   # if uv is available
    pip install pydoc-markdown && python scripts/api-generation-python.py  # fallback
"""

import ast
import importlib.util
import shutil
from pathlib import Path

import docspec
from pydoc_markdown import PydocMarkdown
from pydoc_markdown.contrib.loaders.python import PythonLoader
from pydoc_markdown.contrib.processors.crossref import CrossrefProcessor
from pydoc_markdown.contrib.processors.filter import FilterProcessor
from pydoc_markdown.contrib.processors.smart import SmartProcessor
from pydoc_markdown.contrib.renderers.markdown import MarkdownRenderer
from pydoc_markdown.contrib.source_linkers.git import GitSourceLinker

BIDI_PACKAGE = "strands.experimental.bidi"


def _read_module_tree(source_root: Path, module_name: str) -> ast.Module:
    module_path = source_root.joinpath(*module_name.split("."), "__init__.py")
    return ast.parse(module_path.read_text(encoding="utf-8"), filename=str(module_path))


def _read_all_exports(module_tree: ast.Module, module_name: str) -> list[str]:
    for statement in module_tree.body:
        if not isinstance(statement, ast.Assign):
            continue
        if not any(isinstance(target, ast.Name) and target.id == "__all__" for target in statement.targets):
            continue

        exports = ast.literal_eval(statement.value)
        if isinstance(exports, list) and all(isinstance(export, str) for export in exports):
            return exports
        break

    raise ValueError(f"{module_name} must declare __all__ as a list of strings")


def _read_lazy_exports(module_tree: ast.Module) -> set[str]:
    exports = set()
    for statement in module_tree.body:
        if not isinstance(statement, ast.FunctionDef) or statement.name != "__getattr__":
            continue
        if not statement.args.args:
            continue

        parameter_name = statement.args.args[0].arg
        for node in ast.walk(statement):
            if not isinstance(node, ast.If) or not isinstance(node.test, ast.Compare):
                continue
            comparison = node.test
            if (
                isinstance(comparison.left, ast.Name)
                and comparison.left.id == parameter_name
                and len(comparison.ops) == 1
                and isinstance(comparison.ops[0], ast.Eq)
                and len(comparison.comparators) == 1
                and isinstance(comparison.comparators[0], ast.Constant)
                and isinstance(comparison.comparators[0].value, str)
            ):
                exports.add(comparison.comparators[0].value)
    return exports


def _resolve_import(module_name: str, imported_module: ast.ImportFrom) -> str:
    if imported_module.level:
        relative_name = "." * imported_module.level + (imported_module.module or "")
        return importlib.util.resolve_name(relative_name, module_name)
    if imported_module.module:
        return imported_module.module
    raise ValueError(f"{module_name} contains an unsupported import")


def _read_public_sources(source_root: Path, module_name: str) -> dict[str, set[str]]:
    module_tree = _read_module_tree(source_root, module_name)
    public_names = set(_read_all_exports(module_tree, module_name)) | _read_lazy_exports(module_tree)
    imports = {}

    for node in ast.walk(module_tree):
        if not isinstance(node, ast.ImportFrom):
            continue
        source_module = _resolve_import(module_name, node)
        for imported_name in node.names:
            if imported_name.name == "*":
                continue
            public_name = imported_name.asname or imported_name.name
            imports[public_name] = (source_module, imported_name.name)

    missing_names = public_names - imports.keys()
    if missing_names:
        missing = ", ".join(sorted(missing_names))
        raise ValueError(f"{module_name} exports symbols without source imports: {missing}")

    public_sources: dict[str, set[str]] = {}
    for public_name in public_names:
        source_module, source_name = imports[public_name]
        public_sources.setdefault(source_module, set()).add(source_name)
    return public_sources


def _read_bidi_public_api(source_root: Path) -> dict[str, dict[str, set[str]]]:
    package_tree = _read_module_tree(source_root, BIDI_PACKAGE)
    owner_names = _read_all_exports(package_tree, BIDI_PACKAGE)
    return {
        f"{BIDI_PACKAGE}.{owner_name}": _read_public_sources(source_root, f"{BIDI_PACKAGE}.{owner_name}")
        for owner_name in owner_names
    }


class CustomGitSourceLinker(GitSourceLinker):
    """Custom source linker that returns 'Defined in: [path:line](url)' format."""

    def get_source_url(self, obj: docspec.ApiObject) -> str | None:
        # Get the base URL from parent
        url = super().get_source_url(obj)
        if not url or not obj.location:
            return None

        # Extract path relative to src/
        path = obj.location.filename
        if "src/" in path:
            path = "src/" + path.split("src/")[-1]

        lineno = obj.location.lineno
        return f"Defined in: [{path}:{lineno}]({url})"


def generate_docs():
    input_path = Path("../strands-py/src")
    output_path = "./.build/api-docs/python"

    """Generate markdown documentation for all strands modules."""
    output_dir = Path(output_path)

    # Delete existing output directory to ensure clean generation
    if output_dir.exists():
        shutil.rmtree(output_dir)
        print(f"Deleted existing output directory: {output_dir}")

    output_dir.mkdir(exist_ok=True, parents=True)

    # Configure the session
    session = PydocMarkdown()

    # Configure the Python loader
    loader = PythonLoader(
        search_path=[str(input_path)],
        packages=["strands"],
    )
    session.loaders = [loader]

    # Configure processors (filter, crossref, smart)
    session.processors = [
        FilterProcessor(skip_empty_modules=True),
        CrossrefProcessor(),
        SmartProcessor(),
    ]

    # Configure the renderer
    renderer = MarkdownRenderer(
        render_module_header=False,
        descriptive_class_title="",
        add_module_prefix=True,
        render_toc=False,
        source_linker=CustomGitSourceLinker(
            root="../strands-py/src",
            url_template="https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/{path}#L{lineno}",
            use_branch=False,
        ),
        source_format="{url}",  # URL already contains the full formatted string
    )
    session.renderer = renderer

    # Load and process modules
    modules = session.load_modules()
    session.process(modules)
    bidi_public_api = _read_bidi_public_api(input_path)
    bidi_public_sources = {
        source_module: (public_module, symbols)
        for public_module, source_modules in bidi_public_api.items()
        for source_module, symbols in source_modules.items()
    }

    # Modules to exclude from documentation
    excluded_modules = {
        "strands.agent",  # Not useful, just re-exports
    }

    # Generate index file
    module_files = []
    bidi_public_sections = {module_name: [] for module_name in bidi_public_api}

    # Write each module to a separate file
    for module in modules:
        module_name = module.name

        if module_name in bidi_public_api:
            continue

        if module_name == BIDI_PACKAGE:
            continue

        if module_name in bidi_public_sources:
            public_module, public_symbols = bidi_public_sources[module_name]
            available_symbols = {member.name for member in module.members}
            missing_symbols = public_symbols - available_symbols
            if missing_symbols:
                missing = ", ".join(sorted(missing_symbols))
                raise ValueError(f"{module_name} does not define mapped symbols: {missing}")
            module.members = [member for member in module.members if member.name in public_symbols]
            rendered = renderer.render_to_string([module]).replace(module_name, public_module)
            if rendered.strip():
                bidi_public_sections[public_module].append(rendered)
            continue

        if module_name.startswith(f"{BIDI_PACKAGE}."):
            continue

        # Skip modules with underscore (private/internal modules)
        # Check if any part of the module path starts with underscore
        if any(part.startswith("_") for part in module_name.split(".")):
            print(f"Skipping private module: {module_name}")
            continue

        # Skip explicitly excluded modules
        if module_name in excluded_modules:
            print(f"Skipping excluded module: {module_name}")
            continue

        # Parse module path: strands.agent.base -> strands.agent.base.mdx
        filename = f"{module_name}.mdx"
        filepath = output_dir / filename
        slug = f"docs/api/python/{module_name}"

        # Render single module
        content = renderer.render_to_string([module])

        content = f"""
---
title: {module_name}
slug:  {slug}
editUrl: false
---
{content}
""".strip()

        if content.strip():  # Only write non-empty files
            # Because we're writing MDX we need to escape brackets so that it's not variable interpolation
            content = content.replace("{", "\\{").replace("<A2A", "&gt;A2A")
            filepath.write_text(content, encoding="utf-8")
            module_files.append((module_name, str(filepath.relative_to(output_dir))))
            print(f"Generated: {filepath}")

    for module_name, sections in bidi_public_sections.items():
        if not sections:
            continue

        filepath = output_dir / f"{module_name}.mdx"
        slug = f"docs/api/python/{module_name}"
        rendered_sections = "\n\n".join(sections)
        content = f"""
---
title: {module_name}
slug:  {slug}
editUrl: false
---
{rendered_sections}
""".strip()
        content = content.replace("{", "\\{").replace("<A2A", "&gt;A2A")
        filepath.write_text(content, encoding="utf-8")
        module_files.append((module_name, str(filepath.relative_to(output_dir))))
        print(f"Generated: {filepath}")

    print(f"\nTotal modules documented: {len(module_files)}")


if __name__ == "__main__":
    generate_docs()
