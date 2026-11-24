Skill data model and loading utilities for AgentSkills.io skills.

This module defines the Skill dataclass and provides classmethods for discovering, parsing, and loading skills from the filesystem, raw content, or HTTPS URLs. Skills are directories containing a SKILL.md file with YAML frontmatter metadata and markdown instructions.

## Skill

```python
@dataclass
class Skill()
```

Defined in: [src/strands/vended\_plugins/skills/skill.py:212](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/skills/skill.py#L212)

Represents an agent skill with metadata and instructions.

A skill encapsulates a set of instructions and metadata that can be dynamically loaded by an agent at runtime. Skills support progressive disclosure: metadata is shown upfront in the system prompt, and full instructions are loaded on demand via a tool.

Skills can be created directly or via convenience classmethods::

# From a skill directory on disk

skill = Skill.from\_file(”./skills/my-skill”)

# From raw SKILL.md content

skill = Skill.from\_content(”---\\nname: my-skill\\n…”)

# Load all skills from a parent directory

skills = Skill.from\_directory(”./skills/”)

# From an HTTPS URL

skill = Skill.from\_url(“[https://example.com/SKILL.md](https://example.com/SKILL.md)”)

**Attributes**:

-   `name` - Unique identifier for the skill (1-64 chars, lowercase alphanumeric + hyphens).
-   `description` - Human-readable description of what the skill does.
-   `instructions` - Full markdown instructions from the SKILL.md body.
-   `path` - Filesystem path to the skill directory, if loaded from disk.
-   `allowed_tools` - List of tool names the skill is allowed to use. (Experimental: not yet enforced)
-   `metadata` - Additional key-value metadata from the SKILL.md frontmatter.
-   `license` - License identifier (e.g., “Apache-2.0”).
-   `compatibility` - Compatibility information string.

#### from\_file

```python
@classmethod
def from_file(cls, skill_path: str | Path, *, strict: bool = False) -> Skill
```

Defined in: [src/strands/vended\_plugins/skills/skill.py:255](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/skills/skill.py#L255)

Load a single skill from a directory containing SKILL.md.

Resolves the filesystem path, reads the file content, and delegates to `from_content` for parsing. After loading, sets the skill’s `path` and validates the skill name against the parent directory.

**Arguments**:

-   `skill_path` - Path to the skill directory or the SKILL.md file itself.
-   `strict` - If True, raise on any validation issue. If False (default), warn and load anyway.

**Returns**:

A Skill instance populated from the SKILL.md file.

**Raises**:

-   `FileNotFoundError` - If the path does not exist or SKILL.md is not found.
-   `ValueError` - If the skill metadata is invalid.

#### from\_content

```python
@classmethod
def from_content(cls, content: str, *, strict: bool = False) -> Skill
```

Defined in: [src/strands/vended\_plugins/skills/skill.py:303](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/skills/skill.py#L303)

Parse SKILL.md content into a Skill instance.

This is a convenience method for creating a Skill from raw SKILL.md content (YAML frontmatter + markdown body) without requiring a file on disk.

Example::

## content = '''--- name: my-skill description: Does something useful

# Instructions

Follow these steps… ''' skill = Skill.from\_content(content)

**Arguments**:

-   `content` - Raw SKILL.md content with YAML frontmatter and markdown body.
-   `strict` - If True, raise on any validation issue. If False (default), warn and load anyway.

**Returns**:

A Skill instance populated from the parsed content.

**Raises**:

-   `ValueError` - If the content is missing required fields or has invalid frontmatter.

#### from\_url

```python
@classmethod
def from_url(cls, url: str, *, strict: bool = False) -> Skill
```

Defined in: [src/strands/vended\_plugins/skills/skill.py:346](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/skills/skill.py#L346)

Load a skill by fetching its SKILL.md content from an HTTPS URL.

Fetches the raw SKILL.md content over HTTPS and parses it using :meth:`from_content`. The URL must point directly to the raw file content (not an HTML page).

Example::

skill = Skill.from\_url( “[https://raw.githubusercontent.com/org/repo/main/SKILL.md](https://raw.githubusercontent.com/org/repo/main/SKILL.md)” )

**Arguments**:

-   `url` - An `https://` URL pointing directly to raw SKILL.md content.
-   `strict` - If True, raise on any validation issue. If False (default), warn and load anyway.

**Returns**:

A Skill instance populated from the fetched SKILL.md content.

**Raises**:

-   `ValueError` - If `url` is not an `https://` URL.
-   `RuntimeError` - If the SKILL.md content cannot be fetched.

#### from\_directory

```python
@classmethod
def from_directory(cls,
                   skills_dir: str | Path,
                   *,
                   strict: bool = False) -> list[Skill]
```

Defined in: [src/strands/vended\_plugins/skills/skill.py:388](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/skills/skill.py#L388)

Load all skills from a parent directory containing skill subdirectories.

Each subdirectory containing a SKILL.md file is treated as a skill. Subdirectories without SKILL.md are silently skipped.

**Arguments**:

-   `skills_dir` - Path to the parent directory containing skill subdirectories.
-   `strict` - If True, raise on any validation issue. If False (default), warn and load anyway.

**Returns**:

List of Skill instances loaded from the directory.

**Raises**:

-   `FileNotFoundError` - If the skills directory does not exist.